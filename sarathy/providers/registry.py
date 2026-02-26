"""
Provider Registry — single source of truth for LLM provider metadata.

Keeping only:
  - Ollama (local)
  - LMStudio (local, OpenAI-compatible)
  - Custom (any OpenAI-compatible endpoint)
  - vLLM (local)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ProviderSpec:
    """One LLM provider's metadata."""

    name: str
    keywords: tuple[str, ...]
    env_key: str
    display_name: str = ""
    litellm_prefix: str = ""
    skip_prefixes: tuple[str, ...] = ()
    env_extras: tuple[tuple[str, str], ...] = ()
    is_gateway: bool = False
    is_local: bool = False
    detect_by_key_prefix: str = ""
    detect_by_base_keyword: str = ""
    default_api_base: str = ""
    strip_model_prefix: bool = False
    model_overrides: tuple[tuple[str, dict[str, Any]], ...] = ()
    is_oauth: bool = False
    is_direct: bool = False
    supports_prompt_caching: bool = False

    @property
    def label(self) -> str:
        return self.display_name or self.name.title()


PROVIDERS: tuple[ProviderSpec, ...] = (
    # === Custom (direct OpenAI-compatible endpoint, bypasses LiteLLM) ======
    ProviderSpec(
        name="custom",
        keywords=(),
        env_key="",
        display_name="Custom (OpenAI-compatible)",
        litellm_prefix="",
        is_direct=True,
    ),
    # === Local providers ====================================================
    # Ollama: local models via Ollama API
    ProviderSpec(
        name="ollama",
        keywords=("ollama",),
        env_key="",
        display_name="Ollama",
        litellm_prefix="ollama",
        skip_prefixes=(),
        env_extras=(),
        is_gateway=False,
        is_local=True,
        detect_by_key_prefix="",
        detect_by_base_keyword="",
        default_api_base="http://localhost:11434",
        strip_model_prefix=False,
        model_overrides=(),
    ),
    # LMStudio: local models with OpenAI-compatible API
    ProviderSpec(
        name="lmstudio",
        keywords=("lmstudio",),
        env_key="",
        display_name="LMStudio",
        litellm_prefix="openai",  # LMStudio is OpenAI-compatible
        skip_prefixes=(),
        env_extras=(),
        is_gateway=False,
        is_local=True,
        detect_by_key_prefix="",
        detect_by_base_keyword="lmstudio",
        default_api_base="http://localhost:1234/v1",
        strip_model_prefix=False,
        model_overrides=(),
    ),
    # vLLM: local models with OpenAI-compatible API
    ProviderSpec(
        name="vllm",
        keywords=("vllm",),
        env_key="HOSTED_VLLM_API_KEY",
        display_name="vLLM",
        litellm_prefix="hosted_vllm",
        skip_prefixes=(),
        env_extras=(),
        is_gateway=False,
        is_local=True,
        detect_by_key_prefix="",
        detect_by_base_keyword="",
        default_api_base="",
        strip_model_prefix=False,
        model_overrides=(),
    ),
)


def find_by_model(model: str) -> ProviderSpec | None:
    """Match a provider by model-name keyword."""
    model_lower = model.lower()
    model_normalized = model_lower.replace("-", "_")
    model_prefix = model_lower.split("/", 1)[0] if "/" in model_lower else ""
    normalized_prefix = model_prefix.replace("-", "_")

    for spec in PROVIDERS:
        if model_prefix and normalized_prefix == spec.name:
            return spec

    for spec in PROVIDERS:
        if any(
            kw in model_lower or kw.replace("-", "_") in model_normalized for kw in spec.keywords
        ):
            return spec
    return None


def find_gateway(
    provider_name: str | None = None,
    api_key: str | None = None,
    api_base: str | None = None,
) -> ProviderSpec | None:
    """Detect local/gateway provider."""
    if provider_name:
        spec = find_by_name(provider_name)
        if spec and (spec.is_gateway or spec.is_local):
            return spec

    for spec in PROVIDERS:
        if spec.detect_by_key_prefix and api_key and api_key.startswith(spec.detect_by_key_prefix):
            return spec
        if spec.detect_by_base_keyword and api_base and spec.detect_by_base_keyword in api_base:
            return spec

    return None


def find_by_name(name: str) -> ProviderSpec | None:
    """Find a provider spec by config field name."""
    for spec in PROVIDERS:
        if spec.name == name:
            return spec
    return None
