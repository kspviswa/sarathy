"""Provider construction: map sarathy config to a tau_ai provider."""

from __future__ import annotations

from tau_ai.env import OpenAICompatibleConfig
from tau_ai.openai_compatible import OpenAICompatibleProvider

from sarathy.config.schema import Config

_LOCAL_ENDPOINTS = {
    "ollama": "http://localhost:11434/v1",
    "lmstudio": "http://localhost:1234/v1",
    "vllm": "http://localhost:8000/v1",
    "custom": "http://localhost:8000/v1",
}

VERSIONED_ENV_VAR = "SARATHY_PROVIDER_API_KEY"


def resolve_api_base(config: Config, provider_name: str) -> str:
    """Return the OpenAI-compatible base URL for the configured provider."""
    p = config.get_provider()
    base = (p.api_base if p and p.api_base else _LOCAL_ENDPOINTS.get(provider_name, "")) or _LOCAL_ENDPOINTS["custom"]
    if not base.endswith("/v1"):
        base = base.rstrip("/") + "/v1"
    return base


def build_provider(config: Config):
    """Build a tau_ai OpenAI-compatible provider from sarathy config.

    Returns ``(provider, provider_name)``. When the config does not select a
    provider (unconfigured), returns ``(None, None)`` so a gateway can still
    boot and prompt the user to configure it.
    """
    if not config.agents.defaults.provider:
        return None, None
    provider_name = config.get_provider_name() or "custom"
    p = config.get_provider()
    api_base = resolve_api_base(config, provider_name)
    defaults = config.agents.defaults

    provider_config = OpenAICompatibleConfig(
        api_key=p.api_key if p and p.api_key else "not-needed",
        base_url=api_base,
        supports_images=True,
        reasoning_effort=defaults.reasoning_effort,
        max_tokens=defaults.max_tokens or None,
        provider_name=f"Sarathy ({provider_name})",
    )
    return OpenAICompatibleProvider(provider_config), provider_name
