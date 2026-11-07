"""WebSocket /ws/voice JSON + binary frame helpers (spec 173 §A)."""

from __future__ import annotations

import json
from typing import Any

import aiohttp.web as web


def json_frame(frame_type: str, payload: dict[str, Any] | None = None) -> str:
    body: dict[str, Any] = {"type": frame_type}
    if payload:
        body.update(payload)
    return json.dumps(body, ensure_ascii=False)


async def send_json(ws: web.WebSocketResponse, frame_type: str, **payload: Any) -> None:
    await ws.send_str(json_frame(frame_type, payload))


async def send_binary_pcm(ws: web.WebSocketResponse, pcm: bytes) -> None:
    await ws.send_bytes(pcm)


def parse_control(data: str) -> tuple[str, dict[str, Any]]:
    try:
        obj = json.loads(data)
    except (json.JSONDecodeError, TypeError):
        return "", {}
    if not isinstance(obj, dict):
        return "", {}
    ftype = str(obj.get("type") or "")
    rest = {k: v for k, v in obj.items() if k != "type"}
    return ftype, rest
