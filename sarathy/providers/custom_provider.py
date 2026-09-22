"""Direct OpenAI-compatible provider — bypasses LiteLLM."""

from __future__ import annotations

import asyncio
from typing import Any

import json_repair
from openai import AsyncOpenAI

from sarathy.providers.base import LLMProvider, LLMResponse, ToolCallRequest


class CustomProvider(LLMProvider):
    def __init__(
        self,
        api_key: str = "no-key",
        api_base: str = "http://localhost:8000/v1",
        default_model: str = "default",
    ):
        super().__init__(api_key, api_base)
        self.default_model = default_model
        self._client = AsyncOpenAI(api_key=api_key, base_url=api_base)

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        model: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        stream: bool = False,
        on_progress: callable | None = None,
        on_thinking: callable | None = None,
        session_id: str | None = None,
    ) -> LLMResponse:
        kwargs: dict[str, Any] = {
            "model": model or self.default_model,
            "messages": self._sanitize_empty_content(messages),
            "max_tokens": max(1, max_tokens),
            "temperature": temperature,
        }
        # Only pass reasoning_effort for non-OpenAI-compatible endpoints
        # Some providers like Ollama's /v1 don't support the think parameter
        if reasoning_effort:
            api_base = self.api_base or ""
            if not api_base.endswith("/v1"):
                kwargs["reasoning_effort"] = reasoning_effort
        if tools:
            kwargs.update(tools=tools, tool_choice="auto")

        # Add session_id for OpenRouter sticky routing if applicable.
        # It MUST travel in extra_body: the OpenAI SDK has no catch-all **kwargs
        # and rejects unknown top-level arguments with a TypeError.
        self._apply_session_id(kwargs, session_id)

        if stream and on_progress:
            return await self._stream_chat(kwargs, on_progress, on_thinking=on_thinking, session_id=session_id)

        try:
            return self._parse(await self._client.chat.completions.create(**kwargs))
        except Exception as e:
            # If the session_id body field caused the error, retry once without it
            if session_id and "session_id" in str(e).lower():
                try:
                    kwargs.pop("extra_body", None)
                    return self._parse(await self._client.chat.completions.create(**kwargs))
                except Exception:
                    pass
            return LLMResponse(content=f"Error: {e}", finish_reason="error")

    def _apply_session_id(self, kwargs: dict[str, Any], session_id: str | None) -> None:
        """Inject OpenRouter's session_id into extra_body (never top-level). Benign."""
        if not session_id or "openrouter.ai" not in (self.api_base or ""):
            return
        try:
            extra = dict(kwargs.get("extra_body") or {})
            extra["session_id"] = session_id
            kwargs["extra_body"] = extra
        except Exception:
            pass  # Benign

    @staticmethod
    def _usage_from(u: Any) -> dict[str, Any]:
        """Build a usage dict from a provider usage object, capturing cache fields.

        Handles both attribute-style and dict-style ``prompt_tokens_details``.
        Never raises; returns ``{}`` when usage is absent or malformed.
        """
        if not u:
            return {}
        try:
            is_dict = isinstance(u, dict)
            usage: dict[str, Any] = {
                "prompt_tokens": u.get("prompt_tokens", 0) if is_dict else (getattr(u, "prompt_tokens", 0) or 0),
                "completion_tokens": u.get("completion_tokens", 0) if is_dict else (getattr(u, "completion_tokens", 0) or 0),
                "total_tokens": u.get("total_tokens", 0) if is_dict else (getattr(u, "total_tokens", 0) or 0),
            }
            details = u.get("prompt_tokens_details") if is_dict else getattr(u, "prompt_tokens_details", None)

            cached = None
            cache_write = None
            if details is not None:
                if isinstance(details, dict):
                    cached = details.get("cached_tokens")
                    cache_write = details.get("cache_write_tokens")
                else:
                    cached = getattr(details, "cached_tokens", None)
                    cache_write = getattr(details, "cache_write_tokens", None)

            cache_discount = u.get("cache_discount") if is_dict else getattr(u, "cache_discount", None)

            if cached is not None:
                usage["cached_tokens"] = cached
            if cache_write is not None:
                usage["cache_write_tokens"] = cache_write
            if cache_discount is not None:
                usage["cache_discount"] = cache_discount

            cost = u.get("cost") if is_dict else getattr(u, "cost", None)
            if cost is not None:
                usage["cost"] = cost

            return usage
        except Exception:
            return {}

    async def _stream_chat(
        self,
        kwargs: dict,
        on_progress: callable,
        on_thinking: callable | None = None,
        session_id: str | None = None,
    ) -> LLMResponse:
        """Handle streaming chat completion."""
        accumulated_content = ""
        accumulated_reasoning = ""
        accumulated_tool_calls = []
        finish_reason = "unknown"
        usage: dict[str, Any] = {}

        # Add session_id for OpenRouter sticky routing if applicable
        self._apply_session_id(kwargs, session_id)

        # Try to include usage in streaming response
        stream_options_added = False
        try:
            kwargs["stream_options"] = {"include_usage": True}
            stream_options_added = True
        except Exception:
            pass

        try:
            async for chunk in await self._client.chat.completions.create(**kwargs, stream=True):
                # Usage may arrive on a final chunk that carries no choices
                # (stream_options.include_usage). Capture it before touching choices.
                chunk_usage = getattr(chunk, "usage", None)
                if chunk_usage:
                    usage = self._usage_from(chunk_usage)

                if not chunk.choices:
                    continue

                delta = chunk.choices[0].delta

                # Extract reasoning/thinking content from delta
                # Different providers use different field names:
                # - Ollama /v1: delta.reasoning
                # - Ollama raw: delta.thinking
                # - LM Studio / DeepSeek / Kimi: delta.reasoning_content
                reasoning = (
                    getattr(delta, "reasoning", None)
                    or getattr(delta, "thinking", None)
                    or getattr(delta, "reasoning_content", None)
                )
                if reasoning:
                    accumulated_reasoning += reasoning
                    if on_thinking and accumulated_reasoning:
                        if asyncio.iscoroutinefunction(on_thinking):
                            await on_thinking(accumulated_reasoning)
                        else:
                            on_thinking(accumulated_reasoning)

                if delta.content:
                    accumulated_content += delta.content
                    if asyncio.iscoroutinefunction(on_progress):
                        await on_progress(accumulated_content)
                    else:
                        on_progress(accumulated_content)

                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        if len(accumulated_tool_calls) <= tc.index:
                            accumulated_tool_calls.append(
                                {
                                    "id": "",
                                    "type": "function",
                                    "function": {"name": "", "arguments": ""},
                                }
                            )
                        if tc.id:
                            accumulated_tool_calls[tc.index]["id"] = tc.id
                        if tc.function and tc.function.name:
                            accumulated_tool_calls[tc.index]["function"]["name"] = tc.function.name
                        if tc.function and tc.function.arguments:
                            accumulated_tool_calls[tc.index]["function"]["arguments"] += (
                                tc.function.arguments
                            )

                finish_reason = chunk.choices[0].finish_reason or "unknown"
        except Exception as e:
            # If stream_options caused the error, retry without it
            if stream_options_added and "stream_options" in str(e).lower():
                try:
                    kwargs.pop("stream_options", None)
                    return await self._stream_chat(kwargs, on_progress, on_thinking, session_id)
                except Exception:
                    pass
            return LLMResponse(content=f"Error streaming: {e}", finish_reason="error")

        has_tool_calls = len(accumulated_tool_calls) > 0 and any(
            tc.get("function", {}).get("name") for tc in accumulated_tool_calls
        )

        tool_calls = []
        if has_tool_calls:
            for tc in accumulated_tool_calls:
                if tc.get("function", {}).get("name"):
                    import json

                    args = tc["function"].get("arguments", "")
                    try:
                        args = json.loads(args) if args else {}
                    except json.JSONDecodeError:
                        args = {"_raw": args}
                    tool_calls.append(
                        ToolCallRequest(
                            id=tc.get("id", ""),
                            name=tc["function"]["name"],
                            arguments=args,
                        )
                    )

        return LLMResponse(
            content=accumulated_content or None,
            tool_calls=tool_calls,
            finish_reason=finish_reason,
            reasoning_content=accumulated_reasoning or None,
            usage=usage,
        )

    def _parse(self, response: Any) -> LLMResponse:
        choice = response.choices[0]
        msg = choice.message
        tool_calls = [
            ToolCallRequest(
                id=tc.id,
                name=tc.function.name,
                arguments=json_repair.loads(tc.function.arguments)
                if isinstance(tc.function.arguments, str)
                else tc.function.arguments,
            )
            for tc in (msg.tool_calls or [])
        ]
        u = response.usage
        reasoning_content = getattr(msg, "reasoning_content", None) or None
        thinking_blocks = getattr(msg, "thinking_blocks", None) or None

        usage_dict = self._usage_from(u)

        return LLMResponse(
            content=msg.content,
            tool_calls=tool_calls,
            finish_reason=choice.finish_reason or "stop",
            usage=usage_dict,
            reasoning_content=reasoning_content,
            thinking_blocks=thinking_blocks,
        )

    def get_default_model(self) -> str:
        return self.default_model
