"""Provider manager: build providers, list models, and hot-reload settings.

Central place that turns the persisted :class:`~sarathy.config.schema.Config`
into a working :class:`~sarathy.providers.base.LLMProvider`, and that lets the
running gateway pick up model/provider/parameter changes without a restart.
"""

from __future__ import annotations

import time as _time
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx
from loguru import logger

from sarathy.config.loader import get_config_path, load_config, save_config
from sarathy.providers.custom_provider import CustomProvider
from sarathy.providers.litellm_provider import LiteLLMProvider
from sarathy.providers.registry import provider_spec_for, resolve_kind

if TYPE_CHECKING:
    from sarathy.config.schema import Config, ProviderConfig
    from sarathy.providers.base import LLMProvider

LOCAL_KINDS = {"ollama", "lmstudio", "vllm"}

_CONTEXT_LENGTH_TTL_S = 600
_CONTEXT_LENGTH_CACHE: dict[tuple[str, str], tuple[float, int | None]] = {}


def build_provider(name: str, cfg: "ProviderConfig", model: str) -> "LLMProvider":
    """Build an LLM provider for a single configured provider entry."""
    kind = resolve_kind(name, cfg)
    spec = provider_spec_for(kind)
    api_base = cfg.api_base or (spec.default_api_base if spec else None)

    if kind in ("custom", "openai") or (api_base and api_base.endswith("/v1")):
        # OpenAI-compatible endpoint → direct client (keeps reasoning content).
        if kind == "openai" and api_base and not api_base.endswith("/v1"):
            api_base = api_base.rstrip("/") + "/v1"
        return CustomProvider(
            api_key=cfg.api_key or "no-key",
            api_base=api_base or "http://localhost:8000/v1",
            default_model=model,
        )

    if kind not in LOCAL_KINDS and not (cfg.api_key and cfg.api_key != "dummy"):
        raise ValueError(
            f"Provider '{name}' needs an API key (kind='{kind}'). "
            "Set one via 'sarathy provider edit' or config.json."
        )

    # LiteLLM path. Pass the canonical spec name (e.g. 'ollama') so prefix /
    # env resolution inside LiteLLMProvider stays consistent for local kinds.
    spec_name = spec.name if spec else name
    return LiteLLMProvider(
        api_key=cfg.api_key if cfg.api_key and cfg.api_key != "dummy" else None,
        api_base=api_base,
        default_model=model,
        extra_headers=cfg.extra_headers,
        provider_name=spec_name,
    )


def create_provider(config: "Config") -> "LLMProvider":
    """Build the provider currently selected by ``config``."""
    name = config.agents.defaults.provider
    cfg = config.providers.get(name)
    if cfg is None:
        raise ValueError(
            f"Provider '{name}' (agents.defaults.provider) is not configured. "
            f"Available providers: {', '.join(config.providers.keys())}"
        )
    return build_provider(name, cfg, config.agents.defaults.model)


# ---------------------------------------------------------------------------
# Model listing (uses each provider's own /models or /api/tags endpoint)
# ---------------------------------------------------------------------------


def _model_list_url(kind: str, api_base: str) -> str:
    api_base = api_base.rstrip("/")
    if kind == "ollama":
        return f"{api_base}/api/tags"
    base = api_base if api_base.endswith("/v1") else f"{api_base}/v1"
    return f"{base}/models"


def _model_list_headers(cfg: "ProviderConfig") -> dict[str, str]:
    headers: dict[str, str] = {}
    if cfg.api_key and cfg.api_key != "dummy":
        headers["Authorization"] = f"Bearer {cfg.api_key}"
    if cfg.extra_headers:
        headers.update(cfg.extra_headers)
    return headers


def list_models(name: str, config: "Config") -> list[str]:
    """List models served by a provider using its native list API.

    Raises ValueError with a readable message when the provider is unreachable.
    """
    cfg = config.providers.get(name)
    if cfg is None:
        raise ValueError(f"Provider '{name}' is not configured.")
    kind = resolve_kind(name, cfg)
    spec = provider_spec_for(kind)
    api_base = cfg.api_base or (spec.default_api_base if spec else None)
    if not api_base:
        raise ValueError(f"Provider '{name}' has no API base URL configured.")

    url = _model_list_url(kind, api_base)
    try:
        resp = httpx.get(url, headers=_model_list_headers(cfg), timeout=10)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        raise ValueError(f"Failed to list models for '{name}' ({url}): {e}") from e

    if kind == "ollama":
        return [m.get("name") for m in data.get("models", []) if m.get("name")]
    return [m.get("id") for m in data.get("data", []) if m.get("id")]


# ---------------------------------------------------------------------------
# Context-length detection (best-effort, cached, never raises)
# ---------------------------------------------------------------------------

_OPENAI_CONTEXT_KEYS = ("context_length", "max_model_len")
_OLLAMA_CONTEXT_KEYS = ("context_length", "max_model_len", "num_ctx")
_LITELLM_CONTEXT_KEYS = ("max_input_tokens", "max_model_len", "context_window")


def _find_context_field(data: Any, keys: tuple[str, ...]) -> int | None:
    """Recursively find the first integer value for one of ``keys``."""
    if isinstance(data, dict):
        for key in keys:
            value = data.get(key)
            if isinstance(value, int):
                return value
            if isinstance(value, str) and value.strip().lstrip("-").isdigit():
                return int(value)
        for value in data.values():
            hit = _find_context_field(value, keys)
            if hit is not None:
                return hit
    elif isinstance(data, list):
        for value in data:
            hit = _find_context_field(value, keys)
            if hit is not None:
                return hit
    return None


def _detect_context_length(name: str, config: "Config", model: str) -> int | None:
    """Detect the model context length from the live provider endpoint.

    Raises on any failure; :func:`get_context_length` is the safe wrapper.
    """
    cfg = config.providers.get(name)
    if cfg is None:
        return None
    kind = resolve_kind(name, cfg)
    spec = provider_spec_for(kind)
    api_base = cfg.api_base or (spec.default_api_base if spec else None)

    if kind == "ollama":
        if not api_base:
            return None
        resp = httpx.get(
            f"{api_base.rstrip('/')}/api/show/{model}",
            headers=_model_list_headers(cfg),
            timeout=5,
        )
        resp.raise_for_status()
        return _find_context_field(resp.json(), _OLLAMA_CONTEXT_KEYS)

    openai_compat = kind in ("custom", "openai") or (api_base and api_base.endswith("/v1"))
    if openai_compat:
        if not api_base:
            return None
        resp = httpx.get(
            _model_list_url(kind, api_base),
            headers=_model_list_headers(cfg),
            timeout=5,
        )
        resp.raise_for_status()
        for entry in resp.json().get("data", []):
            if isinstance(entry, dict) and entry.get("id") == model:
                return _find_context_field(entry, _OPENAI_CONTEXT_KEYS)
        return None

    # LiteLLM hosted (best-effort).
    try:
        import litellm

        info = litellm.get_model_info(model)
        return _find_context_field(info, _LITELLM_CONTEXT_KEYS)
    except Exception:
        return None


def get_context_length(name: str, config: "Config", model: str) -> int | None:
    """Best-effort context-length detection for a (provider, model).

    Cached per ``(provider, model)`` for 600s, HTTP timeout ≤ 5s, and NEVER
    raises — returns ``None`` on any failure so callers fall back to config.
    """
    cache_key = (name, model)
    now = _time.monotonic()
    cached = _CONTEXT_LENGTH_CACHE.get(cache_key)
    if cached and now - cached[0] < _CONTEXT_LENGTH_TTL_S:
        return cached[1]

    try:
        result = _detect_context_length(name, config, model)
    except Exception:
        result = None

    _CONTEXT_LENGTH_CACHE[cache_key] = (now, result)
    return result


async def list_models_async(name: str, config: "Config") -> list[str]:
    """Async variant of :func:`list_models` (used by the dashboard)."""
    return await asyncio_to_thread(list_models, name, config)


async def asyncio_to_thread(fn, *args, **kwargs):
    import asyncio

    return await asyncio.to_thread(fn, *args, **kwargs)


def describe_provider(name: str, cfg: "ProviderConfig") -> dict[str, Any]:
    """Return a JSON-safe description of a configured provider."""
    kind = resolve_kind(name, cfg)
    spec = provider_spec_for(kind)
    api_base = cfg.api_base or (spec.default_api_base if spec else None)
    return {
        "name": name,
        "label": cfg.label or spec.label if spec else (name.title()),
        "kind": kind,
        "apiBase": api_base,
        "hasApiKey": bool(cfg.api_key and cfg.api_key != "dummy"),
        "isLocal": kind in LOCAL_KINDS,
    }


# ---------------------------------------------------------------------------
# RuntimeProvider — hot reload of model / parameters / provider
# ---------------------------------------------------------------------------


class RuntimeProvider:
    """Holds the live provider + agent settings and reloads them on demand.

    The gateway keeps a single ``RuntimeProvider``. Every incoming turn calls
    :meth:`refresh`, which re-reads ``config.json`` only when its mtime changes
    and rebuilds the provider whenever the active provider/model/parameters
    changed on disk — no gateway restart required.
    """

    def __init__(self, config: "Config", config_path: Path | None = None):
        self.config = config
        self.config_path = Path(config_path) if config_path else get_config_path()
        self._mtime = self._file_mtime()
        self._on_change: Any | None = None
        self.provider = create_provider(config)
        self.model = config.agents.defaults.model
        self.temperature = config.agents.defaults.temperature
        self.max_tokens = config.agents.defaults.max_tokens
        self.reasoning_effort = config.agents.defaults.reasoning_effort

    def on_change(self, callback: Any | None) -> None:
        """Register a callback invoked after the active settings change."""
        self._on_change = callback

    def _file_mtime(self) -> int:
        try:
            return self.config_path.stat().st_mtime_ns
        except OSError:
            return 0

    def refresh(self) -> bool:
        """Reload config if changed on disk; rebuild provider if needed.

        Returns True when the active model/provider/parameters changed.
        """
        mtime = self._file_mtime()
        if mtime == self._mtime:
            return False
        self._mtime = mtime
        try:
            new_cfg = load_config(self.config_path)
        except Exception as e:
            logger.warning("Failed to reload config for hot-reload: {}", e)
            return False

        changed = (
            self.config.agents.defaults.provider != new_cfg.agents.defaults.provider
            or self.config.agents.defaults.model != new_cfg.agents.defaults.model
            or self.config.agents.defaults.temperature != new_cfg.agents.defaults.temperature
            or self.config.agents.defaults.max_tokens != new_cfg.agents.defaults.max_tokens
            or self.config.agents.defaults.reasoning_effort
            != new_cfg.agents.defaults.reasoning_effort
        )
        self.config = new_cfg
        if changed:
            try:
                self.provider = create_provider(new_cfg)
            except Exception as e:
                logger.error("Rebuilding provider failed (keeping old one): {}", e)
                return False
            self.model = new_cfg.agents.defaults.model
            self.temperature = new_cfg.agents.defaults.temperature
            self.max_tokens = new_cfg.agents.defaults.max_tokens
            self.reasoning_effort = new_cfg.agents.defaults.reasoning_effort
            logger.info(
                "Runtime config changed → provider={} model={} temp={} max_tokens={}",
                new_cfg.agents.defaults.provider,
                self.model,
                self.temperature,
                self.max_tokens,
            )
            if self._on_change:
                try:
                    self._on_change()
                except Exception as e:
                    logger.warning("Runtime on_change callback failed: {}", e)
        return changed

    def apply_to(self, agent) -> bool:
        """Refresh and apply current settings to an agent (loop / subagent)."""
        changed = self.refresh()
        agent.provider = self.provider
        agent.model = self.model
        agent.temperature = self.temperature
        agent.max_tokens = self.max_tokens
        agent.reasoning_effort = self.reasoning_effort
        subagents = getattr(agent, "subagents", None)
        if subagents is not None:
            subagents.provider = self.provider
        return changed

    # ------------------------------------------------------------------ mutations

    def set_active(
        self,
        provider_name: str,
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        reasoning_effort: str | None = None,
    ) -> None:
        """Persist the active provider/model/params and rebuild immediately."""
        cfg = load_config(self.config_path)
        if provider_name not in cfg.providers:
            raise ValueError(
                f"Provider '{provider_name}' is not configured. "
                f"Available: {', '.join(cfg.providers.keys())}"
            )
        cfg.agents.defaults.provider = provider_name
        if model is not None:
            cfg.agents.defaults.model = model
        if temperature is not None:
            cfg.agents.defaults.temperature = temperature
        if max_tokens is not None:
            cfg.agents.defaults.max_tokens = max_tokens
        if reasoning_effort is not None:
            cfg.agents.defaults.reasoning_effort = reasoning_effort
        save_config(cfg, self.config_path)
        self.config = cfg
        self._mtime = self._file_mtime()
        self.provider = create_provider(cfg)
        self.model = cfg.agents.defaults.model
        self.temperature = cfg.agents.defaults.temperature
        self.max_tokens = cfg.agents.defaults.max_tokens
        self.reasoning_effort = cfg.agents.defaults.reasoning_effort
        if self._on_change:
            try:
                self._on_change()
            except Exception as e:
                logger.warning("Runtime on_change callback failed: {}", e)

    def status(self) -> dict[str, Any]:
        """Return current runtime status (for /model and /provider commands)."""
        return {
            "provider": self.config.agents.defaults.provider,
            "model": self.model,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "reasoning_effort": self.reasoning_effort,
            "providers": list(self.config.providers.keys()),
        }

    # ------------------------------------------------------------------ roles

    ROLE_MAIN = "main"
    ROLE_LOCAL = "local"

    def provider_for(self, role: str) -> "LLMProvider | None":
        """Resolve the provider tagged ``role`` (``main`` | ``local``).

        Returns ``None`` when no provider carries that role, so callers can
        fall back to the active provider. ``main`` falls back to the current
        active provider when unassigned (the interactive voice is the crown).
        """
        if role == self.ROLE_MAIN:
            for name, cfg in self.config.providers.items():
                if cfg.role == self.ROLE_MAIN:
                    return build_provider(name, cfg, cfg.model or self.model)
            # No explicit main → the active provider is the main voice.
            return self.provider
        if role == self.ROLE_LOCAL:
            for name, cfg in self.config.providers.items():
                if cfg.role == self.ROLE_LOCAL:
                    try:
                        return build_provider(name, cfg, cfg.model or self.model)
                    except Exception as e:
                        logger.warning(
                            "Local provider '{}' failed to build ({}); falling back to main",
                            name,
                            e,
                        )
                        return self.provider
            return None
        return None

    def role_status(self) -> dict[str, Any]:
        """Return role designations for /provider roles.

        ``main`` resolves to the explicit main tag, else the active provider.
        ``local`` is the tagged local name or None. Each role reports the
        model that would actually run: the provider's own override when set,
        else the active/default model.
        """
        main_name = None
        local_name = None
        main_model = None
        local_model = None
        for name, cfg in self.config.providers.items():
            if cfg.role == self.ROLE_MAIN:
                main_name = name
                main_model = cfg.model or self.model
            elif cfg.role == self.ROLE_LOCAL:
                local_name = name
                local_model = cfg.model or self.model
        if main_name is None:
            main_name = self.config.agents.defaults.provider
            main_model = self.model
        return {
            "main": main_name,
            "main_model": main_model,
            "local": local_name,
            "local_model": local_model,
            "active": self.config.agents.defaults.provider,
        }

    def set_role(self, role: str, provider_name: str, model: str | None = None) -> None:
        """Tag ``provider_name`` with ``role`` (``main`` | ``local``) and persist.

        Both roles are exclusive: assigning a new main or local clears the
        previously tagged provider of that role. There is exactly one main and
        at most one local at any time. When ``model`` is given, it is stored as
        the provider's per-provider model override (receiving the tag alone
        leaves any previously stored model untouched).
        """
        if role not in (self.ROLE_MAIN, self.ROLE_LOCAL):
            raise ValueError("role must be 'main' or 'local'")
        cfg = load_config(self.config_path)
        if provider_name not in cfg.providers:
            raise ValueError(
                f"Provider '{provider_name}' is not configured. "
                f"Available: {', '.join(cfg.providers.keys())}"
            )
        for name, p in cfg.providers.items():
            if p.role == role and name != provider_name:
                p.role = ""
        cfg.providers[provider_name].role = role
        if model:
            cfg.providers[provider_name].model = model
        save_config(cfg, self.config_path)
        self.config = cfg
        self._mtime = self._file_mtime()
        if self._on_change:
            try:
                self._on_change()
            except Exception as e:
                logger.warning("Runtime on_change callback failed: {}", e)
