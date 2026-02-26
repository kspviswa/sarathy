"""Textual-based onboarding wizard for sarathy."""

from textual.app import App, ComposeResult
from textual.containers import Container, Horizontal, Vertical
from textual.screen import Screen
from textual.widgets import (
    Button,
    Header,
    Input,
    Label,
    RadioButton,
    RadioSet,
    Static,
    Switch,
)


LOGO = """
╔═══════════════════════════════════════════════════════════╗
║              🪆 Sarathy Setup Wizard                      ║
║                                                               ║
║        Let's get your AI assistant configured!              ║
╚═══════════════════════════════════════════════════════════╝
"""


class OnboardingApp(App):
    """Sarathy onboarding wizard application."""

    CSS = """
    Screen {
        align: center middle;
    }
    
    Container {
        width: 70;
        border: solid $primary;
        padding: 2 4;
    }
    
    #title {
        text-align: center;
        text-style: bold;
        color: $accent;
    }
    
    #subtitle {
        color: $text-muted;
        margin-bottom: 2;
    }
    
    RadioSet {
        margin: 2 0;
    }
    
    Input {
        margin: 1 0;
    }
    
    Switch {
        margin: 1 0;
    }
    
    #buttons {
        align: right middle;
        margin-top: 2;
    }
    
    .spacer {
        height: 1;
    }
    """

    def __init__(self, config, config_path, workspace, **kwargs):
        super().__init__(**kwargs)
        self.config = config
        self.config_path = config_path
        self.workspace = workspace

    def compose(self) -> ComposeResult:
        yield Header()
        yield Container(
            Static(LOGO, id="logo"),
            id="main",
        )

    def on_mount(self) -> None:
        self.push_screen(WelcomeScreen(self.config, self.config_path, self.workspace))


class WelcomeScreen(Screen):
    """Welcome screen showing logo and intro."""

    def __init__(self, config, config_path, workspace, **kwargs):
        super().__init__(**kwargs)
        self.config = config
        self.config_path = config_path
        self.workspace = workspace

    def compose(self) -> ComposeResult:
        yield Container(
            Static("[bold cyan]🪆 Welcome to Sarathy Setup Wizard[/bold cyan]", id="title"),
            Static("Let's get your personal AI assistant configured!", id="subtitle"),
            Static(""),
            Static("This wizard will guide you through:"),
            Static("  1. Choosing your LLM provider"),
            Static("  2. Configuring your model"),
            Static("  3. Setting up communication channels (optional)"),
            Static(""),
            Horizontal(
                Button("Get Started →", variant="primary", id="start"),
                Button("Exit", variant="default", id="exit"),
            ),
            id="welcome",
        )

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "start":
            self.app.push_screen(ProviderScreen(self.config, self.config_path, self.workspace))
        else:
            self.app.exit()


class ProviderScreen(Screen):
    """Screen for selecting LLM provider."""

    def __init__(self, config, config_path, workspace, **kwargs):
        super().__init__(**kwargs)
        self.config = config
        self.config_path = config_path
        self.workspace = workspace

    def compose(self) -> ComposeResult:
        yield Container(
            Static("[bold cyan]Step 1: Choose Your LLM Provider[/bold cyan]", id="title"),
            Static("Select a provider for your AI assistant:", id="subtitle"),
            RadioSet(
                RadioButton("Ollama (Local)", id="ollama", value="ollama"),
                RadioButton("LMStudio (Local)", id="lmstudio", value="lmstudio"),
                RadioButton("vLLM (Local)", id="vllm", value="vllm"),
                RadioButton("Custom (OpenAI-compatible)", id="custom", value="custom"),
            ),
            Label("API Base URL:"),
            Input(placeholder="http://localhost:11434", id="api_base"),
            Label("API Key (if required):"),
            Input(placeholder="API Key", password=False, id="api_key"),
            Static(""),
            Horizontal(
                Button("← Back", variant="default", id="back"),
                Button("Next →", variant="primary", id="next"),
            ),
            id="provider_screen",
        )

    def on_mount(self) -> None:
        self.query_one("#api_base").display = False
        self.query_one("#api_key").display = False

    def on_radio_set_changed(self, event: RadioSet.Changed) -> None:
        radio_set = self.query_one(RadioSet)
        selected = radio_set.pressed_button
        if selected:
            provider = selected.id
            if provider in ("ollama", "lmstudio", "vllm"):
                self.query_one("#api_base").display = True
                self.query_one("#api_base").placeholder = (
                    "http://localhost:11434" if provider == "ollama" else "http://localhost:1234/v1"
                )
                self.query_one("#api_key").display = False
            else:
                self.query_one("#api_base").display = True
                self.query_one("#api_key").display = True

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "back":
            self.app.pop_screen()
        else:
            radio_set = self.query_one(RadioSet)
            selected = radio_set.pressed_button

            if not selected:
                return

            provider = selected.id

            from sarathy.config.schema import ProviderConfig

            pc = ProviderConfig()

            api_base = self.query_one("#api_base").value
            api_key = self.query_one("#api_key").value

            if api_base:
                pc.api_base = api_base
            if api_key:
                pc.api_key = api_key

            setattr(self.config.providers, provider, pc)
            self.config.agents.defaults.model = "llama3" if provider == "ollama" else "gpt-4"

            self.app.push_screen(ModelScreen(self.config, self.config_path, self.workspace))


class ModelScreen(Screen):
    """Screen for configuring model name."""

    def __init__(self, config, config_path, workspace, **kwargs):
        super().__init__(**kwargs)
        self.config = config
        self.config_path = config_path
        self.workspace = workspace

    def compose(self) -> ComposeResult:
        yield Container(
            Static("[bold cyan]Step 2: Configure Model[/bold cyan]", id="title"),
            Static("Enter the model name you want to use:", id="subtitle"),
            Label("Model Name:"),
            Input(
                placeholder="llama3",
                value=self.config.agents.defaults.model,
                id="model_name",
            ),
            Static(""),
            Horizontal(
                Button("← Back", variant="default", id="back"),
                Button("Next →", variant="primary", id="next"),
            ),
            id="model_screen",
        )

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "back":
            self.app.pop_screen()
        else:
            model_name = self.query_one("#model_name").value
            if model_name:
                self.config.agents.defaults.model = model_name
            self.app.push_screen(ChannelsScreen(self.config, self.config_path, self.workspace))


class ChannelsScreen(Screen):
    """Screen for enabling channels."""

    def __init__(self, config, config_path, workspace, **kwargs):
        super().__init__(**kwargs)
        self.config = config
        self.config_path = config_path
        self.workspace = workspace

    def compose(self) -> ComposeResult:
        yield Container(
            Static("[bold cyan]Step 3: Enable Channels (Optional)[/bold cyan]", id="title"),
            Static("Choose which platforms you want to connect:", id="subtitle"),
            Static(""),
            Static("[Telegram]  📱 Enable Telegram"),
            Switch(value=False, id="telegram_switch"),
            Static("[Discord]  💬 Enable Discord"),
            Switch(value=False, id="discord_switch"),
            Static("[Email]    📧 Enable Email"),
            Switch(value=False, id="email_switch"),
            Static(""),
            Horizontal(
                Button("← Back", variant="default", id="back"),
                Button("Next →", variant="primary", id="next"),
            ),
            id="channels_screen",
        )

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "back":
            self.app.pop_screen()
        else:
            tg = self.query_one("#telegram_switch").value
            dc = self.query_one("#discord_switch").value
            em = self.query_one("#email_switch").value

            if tg:
                self.app.push_screen(
                    TelegramSetupScreen(self.config, self.config_path, self.workspace)
                )
            elif dc:
                self.app.push_screen(
                    DiscordSetupScreen(self.config, self.config_path, self.workspace)
                )
            elif em:
                self.app.push_screen(
                    EmailSetupScreen(self.config, self.config_path, self.workspace)
                )
            else:
                self.app.push_screen(FinishScreen(self.config, self.config_path, self.workspace))


class TelegramSetupScreen(Screen):
    """Telegram setup screen."""

    def __init__(self, config, config_path, workspace, **kwargs):
        super().__init__(**kwargs)
        self.config = config
        self.config_path = config_path
        self.workspace = workspace

    def compose(self) -> ComposeResult:
        yield Container(
            Static("[bold]📱 Telegram Setup[/bold]", id="title"),
            Static("1. Open Telegram and search for @BotFather", id="step1"),
            Static("2. Send /newbot to create a new bot", id="step2"),
            Static("3. Get your bot token", id="step3"),
            Static("4. Start your bot by sending /start", id="step4"),
            Static(""),
            Label("Bot Token:"),
            Input(placeholder="Enter bot token", password=False, id="token"),
            Label("Allowed Users:"),
            Input(placeholder="Allowed users (comma-separated)", id="allowed"),
            Static(""),
            Horizontal(
                Button("← Back", variant="default", id="back"),
                Button("Save →", variant="primary", id="save"),
            ),
        )

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "back":
            self.app.pop_screen()
        else:
            token = self.query_one("#token").value
            allowed = self.query_one("#allowed").value

            self.config.channels.telegram.enabled = True
            self.config.channels.telegram.token = token
            self.config.channels.telegram.allow_from = [
                u.strip() for u in allowed.split(",") if u.strip()
            ]

            if self.config.channels.discord.enabled:
                self.app.push_screen(
                    DiscordSetupScreen(self.config, self.config_path, self.workspace)
                )
            elif self.config.channels.email.enabled:
                self.app.push_screen(
                    EmailSetupScreen(self.config, self.config_path, self.workspace)
                )
            else:
                self.app.push_screen(FinishScreen(self.config, self.config_path, self.workspace))


class DiscordSetupScreen(Screen):
    """Discord setup screen."""

    def __init__(self, config, config_path, workspace, **kwargs):
        super().__init__(**kwargs)
        self.config = config
        self.config_path = config_path
        self.workspace = workspace

    def compose(self) -> ComposeResult:
        yield Container(
            Static("[bold]💬 Discord Setup[/bold]", id="title"),
            Static("1. Go to discord.com/developers/applications", id="step1"),
            Static("2. Create app → Bot → Reset Token", id="step2"),
            Static("3. Enable MESSAGE CONTENT INTENT", id="step3"),
            Static("4. OAuth2 → URL Generator → invite bot", id="step4"),
            Static(""),
            Label("Bot Token:"),
            Input(placeholder="Enter bot token", password=False, id="token"),
            Label("Allowed Users:"),
            Input(placeholder="Allowed user IDs (comma-separated)", id="allowed"),
            Static(""),
            Horizontal(
                Button("← Back", variant="default", id="back"),
                Button("Save →", variant="primary", id="save"),
            ),
        )

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "back":
            self.app.pop_screen()
        else:
            token = self.query_one("#token").value
            allowed = self.query_one("#allowed").value

            self.config.channels.discord.enabled = True
            self.config.channels.discord.token = token
            self.config.channels.discord.allow_from = [
                u.strip() for u in allowed.split(",") if u.strip()
            ]

            if self.config.channels.email.enabled:
                self.app.push_screen(
                    EmailSetupScreen(self.config, self.config_path, self.workspace)
                )
            else:
                self.app.push_screen(FinishScreen(self.config, self.config_path, self.workspace))


class EmailSetupScreen(Screen):
    """Email setup screen."""

    def __init__(self, config, config_path, workspace, **kwargs):
        super().__init__(**kwargs)
        self.config = config
        self.config_path = config_path
        self.workspace = workspace

    def compose(self) -> ComposeResult:
        yield Container(
            Static("[bold]📧 Email Setup[/bold]", id="title"),
            Static("For Gmail: Use an App Password (not regular password)", id="hint"),
            Label("IMAP Host:"),
            Input(placeholder="imap.gmail.com", id="imap_host"),
            Label("IMAP Port:"),
            Input(placeholder="993", id="imap_port"),
            Label("IMAP Username:"),
            Input(placeholder="your email", id="imap_user"),
            Label("IMAP Password:"),
            Input(placeholder="app password", password=False, id="imap_pass"),
            Label("SMTP Host:"),
            Input(placeholder="smtp.gmail.com", id="smtp_host"),
            Label("SMTP Port:"),
            Input(placeholder="587", id="smtp_port"),
            Label("SMTP Username:"),
            Input(placeholder="your email", id="smtp_user"),
            Label("SMTP Password:"),
            Input(placeholder="app password", password=False, id="smtp_pass"),
            Label("From Address:"),
            Input(placeholder="your@email.com", id="from_addr"),
            Static(""),
            Horizontal(
                Button("← Back", variant="default", id="back"),
                Button("Save →", variant="primary", id="save"),
            ),
        )

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "back":
            self.app.pop_screen()
        else:
            self.config.channels.email.enabled = True
            self.config.channels.email.consent_granted = True
            self.config.channels.email.imap_host = (
                self.query_one("#imap_host").value or "imap.gmail.com"
            )
            self.config.channels.email.imap_port = int(self.query_one("#imap_port").value or "993")
            self.config.channels.email.imap_username = self.query_one("#imap_user").value
            self.config.channels.email.imap_password = self.query_one("#imap_pass").value
            self.config.channels.email.smtp_host = (
                self.query_one("#smtp_host").value or "smtp.gmail.com"
            )
            self.config.channels.email.smtp_port = int(self.query_one("#smtp_port").value or "587")
            self.config.channels.email.smtp_username = self.query_one("#smtp_user").value
            self.config.channels.email.smtp_password = self.query_one("#smtp_pass").value
            self.config.channels.email.from_address = self.query_one("#from_addr").value

            self.app.push_screen(FinishScreen(self.config, self.config_path, self.workspace))


class FinishScreen(Screen):
    """Finish screen with summary."""

    def __init__(self, config, config_path, workspace, **kwargs):
        super().__init__(**kwargs)
        self.config = config
        self.config_path = config_path
        self.workspace = workspace

    def compose(self) -> ComposeResult:
        channels = []
        if self.config.channels.telegram.enabled:
            channels.append("Telegram")
        if self.config.channels.discord.enabled:
            channels.append("Discord")
        if self.config.channels.email.enabled:
            channels.append("Email")

        channels_str = ", ".join(channels) if channels else "None"

        yield Container(
            Static("[bold green]🎉 Setup Complete![/bold green]", id="title"),
            Static(f"", id="spacer"),
            Static(f"Config saved to: {self.config_path}"),
            Static(f"Workspace: {self.workspace}"),
            Static(f"Model: {self.config.agents.defaults.model}"),
            Static(f"Channels: {channels_str}"),
            Static(f"", id="spacer2"),
            Static("[bold]Next steps:[/bold]"),
            Static("  • Customize config: nano ~/.sarathy/config.json"),
            Static('  • Chat: sarathy agent -m "Hello!"'),
            Static("  • Start gateway: sarathy gateway start"),
            Static("  • Check status: sarathy gateway status"),
            Static(""),
            Button("Finish", variant="primary", id="finish"),
        )

    def on_mount(self) -> None:
        from sarathy.config.loader import save_config

        save_config(self.config)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        self.app.exit()


def run_onboarding(config, config_path, workspace):
    """Run the onboarding wizard."""
    app = OnboardingApp(config, config_path, workspace)
    app.run()
