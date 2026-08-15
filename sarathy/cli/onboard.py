"""Textual-based onboarding wizard for sarathy."""

from textual.app import App, ComposeResult
from textual.containers import Container, Horizontal
from textual.screen import Screen
from textual.widgets import (
    Button,
    Header,
    Input,
    Label,
    RadioButton,
    RadioSet,
    Static,
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
            self.app.push_screen(FinishScreen(self.config, self.config_path, self.workspace))


class FinishScreen(Screen):
    """Finish screen with summary."""

    def __init__(self, config, config_path, workspace, **kwargs):
        super().__init__(**kwargs)
        self.config = config
        self.config_path = config_path
        self.workspace = workspace

    def compose(self) -> ComposeResult:
        yield Container(
            Static("[bold green]🎉 Setup Complete![/bold green]", id="title"),
            Static("", id="spacer"),
            Static(f"Config saved to: {self.config_path}"),
            Static(f"Workspace: {self.workspace}"),
            Static(f"Model: {self.config.agents.defaults.model}"),
            Static("", id="spacer2"),
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
