"""FastAPI portal: chat/sessions-first SPA + management endpoints."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from tau_agent.messages import TextContent

from sarathy.config.loader import save_config
from sarathy.config.schema import Config
from sarathy.cron.types import CronSchedule
from sarathy.web.auth import Auth
from sarathy.web.notifier import Notifier

STATIC_DIR = Path(__file__).resolve().parent / "static"

log = logging.getLogger("sarathy.web")


class ChatMessage(BaseModel):
    content: str


class CommandRequest(BaseModel):
    session_id: str
    line: str


class CronRequest(BaseModel):
    name: str = ""
    body: str
    schedule: str = "0 9 * * *"
    session_id: str = ""


class InstallRequest(BaseModel):
    url: str


def _mask_config(config: Config) -> dict[str, Any]:
    data = config.model_dump(by_alias=True)
    providers = data.get("providers", {})
    if isinstance(providers, dict):
        for name, cfg in providers.items():
            if isinstance(cfg, dict):
                for key in ("apiKey", "api_key"):
                    if cfg.get(key):
                        cfg[key] = "•••"
    tools = data.get("tools", {})
    search = (tools.get("web") or {}).get("search") or {} if isinstance(tools, dict) else {}
    if isinstance(search, dict):
        for key in ("apiKey", "api_key"):
            if search.get(key):
                search[key] = "•••"
    return data


def create_app(engine, *, auth: Auth, notifier: Notifier) -> FastAPI:
    app = FastAPI(title="Sarathy", docs_url=None, redoc_url=None)
    app.state.engine = engine

    def require_auth(request: Request) -> None:
        auth.require(request)

    # ------------------------------------------------------------------ static & pages
    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/manifest.webmanifest", include_in_schema=False)
    def manifest():
        return FileResponse(STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json")

    @app.get("/sw.js", include_in_schema=False)
    def sw():
        return FileResponse(STATIC_DIR / "sw.js", media_type="application/javascript")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    app.mount("/icons", StaticFiles(directory=STATIC_DIR / "icons"), name="icons")

    # ------------------------------------------------------------------ auth
    @app.get("/api/health", include_in_schema=False)
    def health():
        return engine.health()

    @app.post("/api/auth/login")
    def login(body: dict[str, str], response: Response):
        token = (body.get("token") or "").strip()
        if not auth.login_ok(token):
            raise HTTPException(status_code=401, detail="Invalid pairing token")
        auth.set_cookie(response)
        return {"ok": True}

    @app.post("/api/auth/logout")
    def logout(response: Response):
        response.delete_cookie("sarathy_token", path="/")
        return {"ok": True}

    @app.get("/api/auth/status")
    def auth_status(_: None = Depends(require_auth)):
        return {"paired": True, "authEnabled": auth.enabled}

    # ------------------------------------------------------------------ notifications
    @app.get("/api/notifications")
    def notifications(_: None = Depends(require_auth)):
        return notifier.counts()

    @app.get("/api/events")
    async def events(request: Request, _: None = Depends(require_auth)):
        return StreamingResponse(
            notifier.iter_events(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # ------------------------------------------------------------------ sessions
    @app.get("/api/sessions")
    async def list_sessions(_: None = Depends(require_auth)):
        sessions = await engine.list_sessions()
        for s in sessions:
            s.pop("messages", None)
        return {"sessions": sessions}

    @app.post("/api/sessions")
    async def create_session(_: None = Depends(require_auth)):
        app_obj = engine.new_session()
        return await app_obj.transcript()

    @app.get("/api/sessions/{session_id}")
    async def get_session(session_id: str, _: None = Depends(require_auth)):
        app_obj = await engine.ensure_session(session_id)
        return await app_obj.transcript()

    @app.post("/api/sessions/{session_id}/messages")
    async def send_message(session_id: str, body: ChatMessage, _: None = Depends(require_auth)):
        if not body.content.strip():
            raise HTTPException(status_code=400, detail="empty message")
        queued = await engine.send(session_id, body.content)
        return {"ok": True, "queued": queued}

    @app.post("/api/sessions/{session_id}/cancel")
    async def cancel_session(session_id: str, _: None = Depends(require_auth)):
        engine.cancel(session_id)
        return {"ok": True}

    @app.post("/api/sessions/{session_id}/read")
    async def mark_read(session_id: str, _: None = Depends(require_auth)):
        notifier.mark_read(session_id)
        return {"ok": True}

    @app.delete("/api/sessions/{session_id}")
    async def delete_session(session_id: str, _: None = Depends(require_auth)):
        engine.delete_session(session_id)
        return {"ok": True}

    # ------------------------------------------------------------------ commands
    @app.post("/api/commands")
    async def run_command(body: CommandRequest, _: None = Depends(require_auth)):
        result = await engine.commands.handle(body.session_id, body.line)
        return {"ok": True, "result": result}

    @app.get("/api/commands")
    async def list_commands(_: None = Depends(require_auth)):
        return {"commands": engine.commands.as_list()}

    # ------------------------------------------------------------------ config / gateway
    @app.get("/api/config")
    def get_config(_: None = Depends(require_auth)):
        return _mask_config(engine.config)

    @app.put("/api/config")
    async def put_config(body: dict[str, Any], _: None = Depends(require_auth)):
        current = engine.config.model_dump(by_alias=True)
        merged = {**current, **body}
        if isinstance(merged.get("providers"), dict):
            merged["providers"] = {
                **current.get("providers", {}), **merged["providers"]
            }
        try:
            new_config = Config.model_validate(merged)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        save_config(new_config)
        engine.config = new_config
        return {"ok": True}

    @app.post("/api/config/restart")
    async def restart_gateway(_: None = Depends(require_auth)):
        engine.request_restart()
        return {"ok": True, "note": "Restarting…"}

    # ------------------------------------------------------------------ extensions / skills / tools
    @app.get("/api/extensions")
    async def list_extensions(_: None = Depends(require_auth)):
        return {"extensions": engine.extensions.list_extensions()}

    @app.post("/api/extensions/install")
    async def install_extension(body: InstallRequest, _: None = Depends(require_auth)):
        try:
            target = engine.extensions.install(body.url.strip(), engine.data_dir)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"ok": True, "path": target}

    @app.post("/api/extensions/reload")
    async def reload_extensions(_: None = Depends(require_auth)):
        engine.extensions.reload(engine.data_dir)
        return {"ok": True, "extensions": engine.extensions.list_extensions()}

    @app.delete("/api/extensions/{name}")
    async def delete_extension(name: str, _: None = Depends(require_auth)):
        engine.extensions.uninstall(name, engine.data_dir)
        return {"ok": True}

    @app.get("/api/skills")
    async def list_skills(_: None = Depends(require_auth)):
        return {"skills": engine.skills_loader.list_skills()}

    @app.get("/api/tools")
    async def list_tools(_: None = Depends(require_auth)):
        tools = await engine.tools_for_session()
        return {"tools": [{"name": t.name, "description": t.description} for t in tools]}

    # ------------------------------------------------------------------ cron
    @app.get("/api/cron")
    async def list_cron(_: None = Depends(require_auth)):
        import dataclasses

        return {"jobs": [dataclasses.asdict(j) for j in engine.cron_service.list_jobs()]}

    @app.post("/api/cron")
    async def add_cron(body: CronRequest, _: None = Depends(require_auth)):
        cron_service = engine.cron_service
        schedule = CronSchedule(kind="cron", expr=body.schedule)
        job = cron_service.add_job(
            name=body.name or "web-job",
            schedule=schedule,
            message=body.body,
            deliver=False,
            channel="web",
            to=body.session_id or None,
        )
        return {"ok": True, "id": job.id}

    @app.delete("/api/cron/{job_id}")
    async def delete_cron(job_id: str, _: None = Depends(require_auth)):
        engine.cron_service.remove_job(job_id)
        return {"ok": True}

    # ------------------------------------------------------------------ memory
    @app.post("/api/memory/consolidate")
    async def consolidate_memory(_: None = Depends(require_auth)):
        excerpt = ""
        app_obj = engine.active_session()
        if app_obj is None:
            sessions = await engine.list_sessions()
            if sessions:
                app_obj = await engine.ensure_session(sessions[0]["session_id"])
        if app_obj is not None:
            messages = await app_obj.messages()
            excerpt = "".join(_text_of(m) for m in messages[-60:])
        added = await engine.archivist.consolidate(excerpt)
        return {"ok": True, "added": added}

    return app


def _text_of(message) -> str:
    try:
        return "".join(b.text for b in getattr(message, "content", []) if isinstance(b, TextContent))
    except Exception:  # noqa: BLE001
        return ""
