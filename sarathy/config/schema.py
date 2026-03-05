"""Configuration schema using Pydantic."""

from pathlib import Path
from pydantic import BaseModel, Field, ConfigDict
from pydantic.alias_generators import to_camel
from pydantic_settings import BaseSettings


class Base(BaseModel):
    """Base model that accepts both camelCase and snake_case keys."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class TelegramConfig(Base):
    """Telegram channel configuration."""

    enabled: bool = False
    token: str = ""  # Bot token from @BotFather
    allow_from: list[str] = Field(default_factory=list)  # Allowed user IDs or usernames
    proxy: str | None = (
        None  # HTTP/SOCKS5 proxy URL, e.g. "http://127.0.0.1:7890" or "socks5://127.0.0.1:1080"
    )
    reply_to_message: bool = False  # If true, bot replies quote the original message
    streaming: bool = False  # Stream responses in progress
    react_to_message: bool = False  # Add emoji reaction to user's message while processing
    reaction_emoji: str = "👀"  # Emoji to use for reaction


class DiscordConfig(Base):
    """Discord channel configuration."""

    enabled: bool = False
    token: str = ""  # Bot token from Discord Developer Portal
    allow_from: list[str] = Field(default_factory=list)  # Allowed user IDs
    gateway_url: str = "wss://gateway.discord.gg/?v=10&encoding=json"
    intents: int = 37377  # GUILDS + GUILD_MESSAGES + DIRECT_MESSAGES + MESSAGE_CONTENT
    streaming: bool = False  # Stream responses in progress


class EmailConfig(Base):
    """Email channel configuration (IMAP inbound + SMTP outbound)."""

    enabled: bool = False
    consent_granted: bool = False  # Explicit owner permission to access mailbox data

    # IMAP (receive)
    imap_host: str = ""
    imap_port: int = 993
    imap_username: str = ""
    imap_password: str = ""
    imap_mailbox: str = "INBOX"
    imap_use_ssl: bool = True

    # SMTP (send)
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_use_tls: bool = True
    smtp_use_ssl: bool = False
    from_address: str = ""

    # Behavior
    auto_reply_enabled: bool = (
        True  # If false, inbound email is read but no automatic reply is sent
    )
    poll_interval_seconds: int = 30
    mark_seen: bool = True
    max_body_chars: int = 12000
    subject_prefix: str = "Re: "
    allow_from: list[str] = Field(default_factory=list)  # Allowed sender email addresses


class ChannelsConfig(Base):
    """Configuration for chat channels."""

    send_progress: bool = True  # stream agent's text progress to the channel
    send_tool_hints: bool = False  # stream tool-call hints (e.g. read_file("…"))
    telegram: TelegramConfig = Field(default_factory=TelegramConfig)
    discord: DiscordConfig = Field(default_factory=DiscordConfig)
    email: EmailConfig = Field(default_factory=EmailConfig)


class AgentDefaults(Base):
    """Default agent configuration."""

    workspace: str = "~/.sarathy/workspace"
    model: str = "llama3"  # Default to local model (Ollama/LMStudio/vLLM)
    provider: str = ""  # REQUIRED - must match a provider key in providers section
    max_tokens: int = 4096
    temperature: float = 0.1
    max_tool_iterations: int = 40
    memory_window: int = 100
    session_cache_size: int = 50  # Max sessions to keep in memory
    max_session_messages: int = 500  # Max messages per session in memory
    context_length: int = (
        8192  # Max context length for the model (used for context usage calculation)
    )
    reasoning_effort: str | None = (
        None  # "off", "low", "medium", "high", "xhigh" for thinking-enabled models
    )


class AgentsConfig(Base):
    """Agent configuration."""

    defaults: AgentDefaults = Field(default_factory=AgentDefaults)


class ProviderConfig(Base):
    """LLM provider configuration."""

    api_key: str = "dummy"
    api_base: str | None = "http://localhost:11434"
    extra_headers: dict[str, str] | None = None


class ProvidersConfig(Base):
    """Configuration for LLM providers."""

    custom: ProviderConfig = Field(default_factory=ProviderConfig)  # Any OpenAI-compatible endpoint
    ollama: ProviderConfig = Field(default_factory=ProviderConfig)  # Ollama local
    lmstudio: ProviderConfig = Field(default_factory=ProviderConfig)  # LMStudio local
    vllm: ProviderConfig = Field(default_factory=ProviderConfig)  # vLLM local


class HeartbeatConfig(Base):
    """Heartbeat service configuration."""

    enabled: bool = True
    interval_s: int = 30 * 60  # 30 minutes


class GatewayConfig(Base):
    """Gateway/server configuration."""

    host: str = "0.0.0.0"
    port: int = 18790
    heartbeat: HeartbeatConfig = Field(default_factory=HeartbeatConfig)


class WebSearchConfig(Base):
    """Web search tool configuration."""

    enabled: bool = True  # Whether to enable web search tool
    provider: str = "firecrawl"  # Provider: "brave" or "firecrawl"
    api_key: str = ""  # Provider API key (fallback to env var if empty)
    max_results: int = 5  # Maximum results to return


class WebToolsConfig(Base):
    """Web tools configuration."""

    search: WebSearchConfig = Field(default_factory=WebSearchConfig)


class ExecToolConfig(Base):
    """Shell exec tool configuration."""

    timeout: int = 60
    path_append: str = ""


class MCPServerConfig(Base):
    """MCP server connection configuration (stdio or HTTP)."""

    command: str = ""  # Stdio: command to run (e.g. "npx")
    args: list[str] = Field(default_factory=list)  # Stdio: command arguments
    env: dict[str, str] = Field(default_factory=dict)  # Stdio: extra env vars
    url: str = ""  # HTTP: streamable HTTP endpoint URL
    headers: dict[str, str] = Field(default_factory=dict)  # HTTP: Custom HTTP Headers
    tool_timeout: int = 30  # Seconds before a tool call is cancelled


class ToolsConfig(Base):
    """Tools configuration."""

    web: WebToolsConfig = Field(default_factory=WebToolsConfig)
    exec: ExecToolConfig = Field(default_factory=ExecToolConfig)
    restrict_to_workspace: bool = False  # If true, restrict all tool access to workspace directory
    mcp_servers: dict[str, MCPServerConfig] = Field(default_factory=dict)


class Config(BaseSettings):
    """Root configuration for sarathy."""

    agents: AgentsConfig = Field(default_factory=AgentsConfig)
    channels: ChannelsConfig = Field(default_factory=ChannelsConfig)
    providers: ProvidersConfig = Field(default_factory=ProvidersConfig)
    gateway: GatewayConfig = Field(default_factory=GatewayConfig)
    tools: ToolsConfig = Field(default_factory=ToolsConfig)

    @property
    def workspace_path(self) -> Path:
        """Get expanded workspace path."""
        return Path(self.agents.defaults.workspace).expanduser()

    def _match_provider(
        self, model: str | None = None
    ) -> tuple["ProviderConfig | None", str | None]:
        """Get provider config and name from explicit provider setting.

        Requires agents.defaults.provider to be set and must match a configured provider.
        """
        from sarathy.providers.registry import PROVIDERS

        provider_name = self.agents.defaults.provider
        if not provider_name:
            available = [s.name for s in PROVIDERS if hasattr(self.providers, s.name)]
            raise ValueError(
                f"Missing required 'provider' in agents.defaults. "
                f"Available providers: {', '.join(available)}"
            )

        # Get the provider config directly by name
        p = getattr(self.providers, provider_name, None)
        if not p:
            available = [s.name for s in PROVIDERS if hasattr(self.providers, s.name)]
            raise ValueError(
                f"Unknown provider '{provider_name}' in agents.defaults.provider. "
                f"Available providers: {', '.join(available)}"
            )

        return p, provider_name

    def get_provider(self) -> ProviderConfig | None:
        """Get provider config from explicit provider setting."""
        p, _ = self._match_provider()
        return p

    def get_provider_name(self) -> str | None:
        """Get the explicit provider name from config (e.g. 'ollama', 'custom')."""
        _, name = self._match_provider()
        return name

    def get_api_key(self) -> str | None:
        """Get API key for the configured provider."""
        p = self.get_provider()
        return p.api_key if p else None

    def get_api_base(self) -> str | None:
        """Get API base URL for the configured provider."""
        from sarathy.providers.registry import find_by_name

        p, name = self._match_provider()
        if p and p.api_base:
            return p.api_base
        if name:
            spec = find_by_name(name)
            if spec and spec.is_gateway and spec.default_api_base:
                return spec.default_api_base
        return None

    model_config = ConfigDict(env_prefix="NANOBOT_", env_nested_delimiter="__")
