"""Direct OpenAI-compatible provider — bypasses LiteLLM."""

from __future__ import annotations

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
    ) -> LLMResponse:
        kwargs: dict[str, Any] = {
            "model": model or self.default_model,
            "messages": self._sanitize_empty_content(messages),
            "max_tokens": max(1, max_tokens),
            "temperature": temperature,
        }
        if reasoning_effort:
            kwargs["reasoning_effort"] = reasoning_effort
        if tools:
            kwargs.update(tools=tools, tool_choice="auto")

        if stream and on_progress:
            return await self._stream_chat(kwargs, on_progress)

        try:
            return self._parse(await self._client.chat.completions.create(**kwargs))
        except Exception as e:
            return LLMResponse(content=f"Error: {e}", finish_reason="error")

    async def _stream_chat(self, kwargs: dict, on_progress: callable) -> LLMResponse:
        """Handle streaming chat completion."""
        accumulated_content = ""
        accumulated_tool_calls = []
        finish_reason = "unknown"

        try:
            async for chunk in await self._client.chat.completions.create(**kwargs, stream=True):
                delta = chunk.choices[0].delta

                if delta.content:
                    accumulated_content += delta.content
                    await on_progress(accumulated_content)

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
            )
        except Exception as e:
            return LLMResponse(content=f"Error streaming: {e}", finish_reason="error")

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
        return LLMResponse(
            content=msg.content,
            tool_calls=tool_calls,
            finish_reason=choice.finish_reason or "stop",
            usage={
                "prompt_tokens": u.prompt_tokens,
                "completion_tokens": u.completion_tokens,
                "total_tokens": u.total_tokens,
            }
            if u
            else {},
            reasoning_content=getattr(msg, "reasoning_content", None) or None,
        )

    def get_default_model(self) -> str:
        return self.default_model
