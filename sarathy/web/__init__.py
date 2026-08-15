"""Web portal for sarathy: static SPA + REST/SSE API (chat-first, mobile PWA)."""

from sarathy.web.app import create_app  # noqa: F401
from sarathy.web.auth import Auth  # noqa: F401
from sarathy.web.notifier import Notifier  # noqa: F401
