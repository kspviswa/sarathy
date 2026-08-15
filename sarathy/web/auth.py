"""Pairing-token authentication for the sarathy web portal.

On first run the gateway generates a human-readable pairing token, persists it
in the data dir (0600), and prints it to the console. Users/hTTP clients prove
possession of the token via ``Authorization: Bearer <token>`` or by logging in
through the SPA (httponly cookie stores a hash).
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from pathlib import Path

from fastapi import HTTPException, Request, Response

TOKEN_COOKIE = "sarathy_token"
TOKEN_HEADER = "authorization"
PLACEHOLDER_KEY = "sarathy-placeholder"


def token_file(data_dir: Path) -> Path:
    return Path(data_dir) / "web-pairing-token"


def load_or_create_token(data_dir: Path) -> str:
    """Read the pairing token from disk or generate + persist one (0600)."""
    path = token_file(data_dir)
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    alphabet = "abcdefghijkmnpqrstuvwxyz23456789"
    token = "-".join(
        "".join(secrets.choice(alphabet) for _ in range(6)) for _ in range(6)
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(token + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return token


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Auth:
    """FastAPI-ready bearer/cookie authentication."""

    def __init__(self, data_dir: Path, enabled: bool = True):
        self.data_dir = Path(data_dir)
        self.enabled = enabled
        self.token = "" if not enabled else load_or_create_token(self.data_dir)

    # -- verification ---------------------------------------------------------
    def _candidate(self, request: Request) -> str | None:
        header = request.headers.get(TOKEN_HEADER, "")
        if header.lower().startswith("bearer "):
            return header[7:].strip()
        cookie = request.cookies.get(TOKEN_COOKIE) or ""
        return cookie if cookie else None

    def require(self, request: Request) -> None:
        """FastAPI dependency: 401 unless auth is disabled or token matches."""
        if not self.enabled:
            return
        candidate = self._candidate(request)
        if candidate and self._valid(candidate):
            return
        raise HTTPException(status_code=401, detail="Pairing token required")

    def _valid(self, candidate: str) -> bool:
        """Accept either a raw token or a pre-hashed (cookie) value."""
        expected_hash = token_hash(self.token)
        if hmac.compare_digest(token_hash(candidate), expected_hash):
            return True
        return hmac.compare_digest(candidate, expected_hash)

    def login_ok(self, candidate: str | None) -> bool:
        if not self.enabled:
            return True
        if not candidate:
            return False
        return self._valid(candidate)

    def set_cookie(self, response: Response) -> None:
        response.set_cookie(
            TOKEN_COOKIE,
            token_hash(self.token),
            httponly=True,
            samesite="lax",
            secure=False,  # plain-HTTP LAN installs; fine behind reverse proxy TLS
            max_age=60 * 60 * 24 * 365,
            path="/",
        )
