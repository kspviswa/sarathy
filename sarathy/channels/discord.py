"""Discord channel implementation using Discord Gateway websocket."""

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import websockets
from loguru import logger

from sarathy.bus.events import OutboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.channels.base import BaseChannel
from sarathy.channels.utils import detect_and_convert_tables
from sarathy.config.schema import DiscordConfig

DISCORD_API_BASE = "https://discord.com/api/v10"
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024  # 20MB
MAX_MESSAGE_LEN = 2000  # Discord message character limit


def _split_message(content: str, max_len: int = MAX_MESSAGE_LEN) -> list[str]:
    """Split content into chunks within max_len, preferring line breaks."""
    if not content:
        return []
    if len(content) <= max_len:
        return [content]
    chunks: list[str] = []
    while content:
        if len(content) <= max_len:
            chunks.append(content)
            break
        cut = content[:max_len]
        pos = cut.rfind("\n")
        if pos <= 0:
            pos = cut.rfind(" ")
        if pos <= 0:
            pos = max_len
        chunks.append(content[:pos])
        content = content[pos:].lstrip()
    return chunks


class DiscordChannel(BaseChannel):
    """Discord channel using Gateway websocket."""

    name = "discord"

    def __init__(self, config: DiscordConfig, bus: MessageBus, command_manager=None):
        super().__init__(config, bus)
        self.config: DiscordConfig = config
        self.command_manager = command_manager
        self._ws: websockets.WebSocketClientProtocol | None = None
        self._seq: int | None = None
        self._heartbeat_task: asyncio.Task | None = None
        self._typing_tasks: dict[str, asyncio.Task] = {}
        self._http: httpx.AsyncClient | None = None
        self._registered_skill_commands: set[str] = set()
        self._streaming_enabled_channels: set[str] = set()  # Per-channel streaming override

    async def start(self) -> None:
        """Start the Discord gateway connection."""
        if not self.config.token:
            logger.error("Discord bot token not configured")
            return

        self._running = True
        self._http = httpx.AsyncClient(timeout=30.0)

        while self._running:
            try:
                logger.info("Connecting to Discord gateway...")
                async with websockets.connect(self.config.gateway_url) as ws:
                    self._ws = ws
                    await self._gateway_loop()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning("Discord gateway error: {}", e)
                if self._running:
                    logger.info("Reconnecting to Discord gateway in 5 seconds...")
                    await asyncio.sleep(5)

    async def stop(self) -> None:
        """Stop the Discord channel."""
        self._running = False
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            self._heartbeat_task = None
        for task in self._typing_tasks.values():
            task.cancel()
        self._typing_tasks.clear()
        if self._ws:
            await self._ws.close()
            self._ws = None
        if self._http:
            await self._http.aclose()
            self._http = None

    async def send(self, msg: OutboundMessage) -> None:
        """Send a message through Discord REST API."""
        if not self._http:
            logger.warning("Discord HTTP client not initialized")
            return

        url = f"{DISCORD_API_BASE}/channels/{msg.chat_id}/messages"
        headers = {"Authorization": f"Bot {self.config.token}"}

        content = msg.content or ""

        content = detect_and_convert_tables(content)

        # Append tokens/sec if verbose is enabled
        if msg.metadata.get("_verbose") and msg.metadata.get("_stats"):
            stats = msg.metadata["_stats"]
            tps = stats.get("tokens_per_sec", 0)
            tokens = stats.get("total_tokens", 0)
            if tps > 0 and tokens > 0:
                content = f"{content}\n\n⚡ {tokens} tokens @ {tps:.1f} tokens/sec"

        try:
            # Send media attachments first
            media_attachments = msg.media or []
            reply_to = msg.reply_to

            for media_path in media_attachments:
                success = await self._send_file(url, headers, media_path, reply_to)
                # Let the first successful attachment carry the reply if present
                if success and reply_to:
                    reply_to = None
                if not success:
                    # Fall back to including path in content
                    content += f"\n[attachment: {Path(media_path).name}]"

            chunks = _split_message(content)
            if not chunks:
                return

            for i, chunk in enumerate(chunks):
                payload: dict[str, Any] = {"content": chunk}

                # Only set reply reference on the first chunk
                if i == 0 and reply_to:
                    payload["message_reference"] = {"message_id": reply_to}
                    payload["allowed_mentions"] = {"replied_user": False}

                if not await self._send_payload(url, headers, payload):
                    break  # Abort remaining chunks on failure
        finally:
            # Only stop typing for final responses, not for intermediate message tool sends
            is_final = msg.metadata.get("_final", True)
            if is_final:
                await self._stop_typing(msg.chat_id)

    async def _send_payload(
        self, url: str, headers: dict[str, str], payload: dict[str, Any]
    ) -> bool:
        """Send a single Discord API payload with retry on rate-limit. Returns True on success."""
        for attempt in range(3):
            try:
                response = await self._http.post(url, headers=headers, json=payload)
                if response.status_code == 429:
                    data = response.json()
                    retry_after = float(data.get("retry_after", 1.0))
                    logger.warning("Discord rate limited, retrying in {}s", retry_after)
                    await asyncio.sleep(retry_after)
                    continue
                response.raise_for_status()
                return True
            except Exception as e:
                if attempt == 2:
                    logger.error("Error sending Discord message: {}", e)
                else:
                    await asyncio.sleep(1)
        return False

    async def _send_file(
        self, url: str, headers: dict[str, str], file_path: str, reply_to: str | None
    ) -> bool:
        """Send a file attachment via Discord API. Returns True on success."""
        path = Path(file_path)
        if not path.exists():
            logger.warning("Discord attachment file not found: {}", file_path)
            return False

        file_size = path.stat().st_size
        if file_size > MAX_ATTACHMENT_BYTES:
            logger.warning(
                "Discord attachment too large: {} bytes (max {})", file_size, MAX_ATTACHMENT_BYTES
            )
            return False

        for attempt in range(3):
            try:
                # Upload file using multipart/form-data
                with open(path, "rb") as f:
                    files = {"file": (path.name, f)}
                    data = {}
                    if reply_to:
                        data["message_reference"] = json.dumps({"message_id": reply_to})
                        data["allowed_mentions"] = json.dumps({"replied_user": False})
                        reply_to = None  # Only first attachment carries reply

                    response = await self._http.post(
                        url,
                        headers=headers,
                        files=files,
                        data=data,
                    )

                if response.status_code == 429:
                    response_data = response.json()
                    retry_after = float(response_data.get("retry_after", 1.0))
                    logger.warning(
                        "Discord rate limited on file upload, retrying in {}s", retry_after
                    )
                    await asyncio.sleep(retry_after)
                    continue

                response.raise_for_status()
                logger.info("Discord attachment sent: {}", path.name)
                return True
            except Exception as e:
                if attempt == 2:
                    logger.error("Error sending Discord file {}: {}", path.name, e)
                else:
                    await asyncio.sleep(1)
        return False

    async def _gateway_loop(self) -> None:
        """Main gateway loop: identify, heartbeat, dispatch events."""
        if not self._ws:
            return

        async for raw in self._ws:
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                logger.warning("Invalid JSON from Discord gateway: {}", raw[:100])
                continue

            op = data.get("op")
            event_type = data.get("t")
            seq = data.get("s")
            payload = data.get("d")

            if seq is not None:
                self._seq = seq

            if op == 10:
                # HELLO: start heartbeat and identify
                interval_ms = payload.get("heartbeat_interval", 45000)
                await self._start_heartbeat(interval_ms / 1000)
                await self._identify()
            elif op == 0 and event_type == "READY":
                logger.info("Discord gateway READY")
            elif op == 0 and event_type == "MESSAGE_CREATE":
                await self._handle_message_create(payload)
            elif op == 7:
                # RECONNECT: exit loop to reconnect
                logger.info("Discord gateway requested reconnect")
                break
            elif op == 9:
                # INVALID_SESSION: reconnect
                logger.warning("Discord gateway invalid session")
                break

    async def _identify(self) -> None:
        """Send IDENTIFY payload."""
        if not self._ws:
            return

        identify = {
            "op": 2,
            "d": {
                "token": self.config.token,
                "intents": self.config.intents,
                "properties": {
                    "os": "sarathy",
                    "browser": "sarathy",
                    "device": "sarathy",
                },
            },
        }
        await self._ws.send(json.dumps(identify))

    async def _start_heartbeat(self, interval_s: float) -> None:
        """Start or restart the heartbeat loop."""
        if self._heartbeat_task:
            self._heartbeat_task.cancel()

        async def heartbeat_loop() -> None:
            while self._running and self._ws:
                payload = {"op": 1, "d": self._seq}
                try:
                    await self._ws.send(json.dumps(payload))
                except Exception as e:
                    logger.warning("Discord heartbeat failed: {}", e)
                    break
                await asyncio.sleep(interval_s)

        self._heartbeat_task = asyncio.create_task(heartbeat_loop())

    async def _handle_message_create(self, payload: dict[str, Any]) -> None:
        """Handle incoming Discord messages."""
        author = payload.get("author") or {}
        if author.get("bot"):
            return

        sender_id = str(author.get("id", ""))
        channel_id = str(payload.get("channel_id", ""))
        content = payload.get("content") or ""

        if not sender_id or not channel_id:
            return

        if not self.is_allowed(sender_id):
            return

        content_parts = [content] if content else []
        media_paths: list[str] = []
        media_dir = Path.home() / ".sarathy" / "media"

        for attachment in payload.get("attachments") or []:
            url = attachment.get("url")
            filename = attachment.get("filename") or "attachment"
            size = attachment.get("size") or 0
            if not url or not self._http:
                continue
            if size and size > MAX_ATTACHMENT_BYTES:
                content_parts.append(f"[attachment: {filename} - too large]")
                continue
            try:
                media_dir.mkdir(parents=True, exist_ok=True)
                file_path = (
                    media_dir / f"{attachment.get('id', 'file')}_{filename.replace('/', '_')}"
                )
                resp = await self._http.get(url)
                resp.raise_for_status()
                file_path.write_bytes(resp.content)
                media_paths.append(str(file_path))
                content_parts.append(f"[attachment: {file_path}]")
            except Exception as e:
                logger.warning("Failed to download Discord attachment: {}", e)
                content_parts.append(f"[attachment: {filename} - download failed]")

        reply_to = (payload.get("referenced_message") or {}).get("id")

        content = "\n".join(p for p in content_parts if p) or "[empty message]"

        if content.strip().startswith("/streaming"):
            await self._handle_streaming_command(channel_id, content)
            return

        await self._start_typing(channel_id)

        await self._handle_message(
            sender_id=sender_id,
            chat_id=channel_id,
            content=content,
            media=media_paths,
            metadata={
                "message_id": str(payload.get("id", "")),
                "guild_id": payload.get("guild_id"),
                "reply_to": reply_to,
            },
        )

    async def _handle_streaming_command(self, channel_id: str, content: str) -> None:
        """Handle /streaming command - toggle streaming mode for this channel."""
        args = content.strip().split(None, 1)[1:] and content.strip().split(None, 1)[1] or ""

        if args == "status":
            current = channel_id in self._streaming_enabled_channels
            await self._send_direct_message(
                channel_id, f"🔴 Streaming: {'enabled' if current else 'disabled'}"
            )
        elif args in ("false", "off", "0"):
            self._streaming_enabled_channels.discard(channel_id)
            await self._send_direct_message(channel_id, "🔴 Streaming disabled for this channel.")
        elif args in ("true", "on", "1"):
            self._streaming_enabled_channels.add(channel_id)
            await self._send_direct_message(channel_id, "🟢 Streaming enabled for this channel.")
        else:
            current = channel_id in self._streaming_enabled_channels
            await self._send_direct_message(
                channel_id,
                f"Usage: /streaming [true|false|status]\nCurrent: {'enabled' if current else 'disabled'}",
            )

    async def _send_direct_message(self, channel_id: str, content: str) -> None:
        """Send a direct message to a channel."""
        if not self._http:
            return

        url = f"{DISCORD_API_BASE}/channels/{channel_id}/messages"
        headers = {"Authorization": f"Bot {self.config.token}"}
        payload = {"content": content}
        await self._send_payload(url, headers, payload)

    async def _start_typing(self, channel_id: str) -> None:
        """Start periodic typing indicator for a channel."""
        await self._stop_typing(channel_id)

        import time

        typing_ttl_seconds = 120  # 2 minutes TTL safety net

        async def typing_loop() -> None:
            url = f"{DISCORD_API_BASE}/channels/{channel_id}/typing"
            headers = {"Authorization": f"Bot {self.config.token}"}
            start_time = time.monotonic()
            while self._running:
                # Check TTL - stop after 2 minutes to prevent stuck indicators
                if time.monotonic() - start_time > typing_ttl_seconds:
                    logger.debug("Discord typing TTL reached ({}s); stopping", typing_ttl_seconds)
                    await self._stop_typing(channel_id)
                    break
                try:
                    await self._http.post(url, headers=headers)
                except asyncio.CancelledError:
                    return
                except Exception as e:
                    logger.debug("Discord typing indicator failed for {}: {}", channel_id, e)
                    return
                await asyncio.sleep(8)

        self._typing_tasks[channel_id] = asyncio.create_task(typing_loop())

    async def _stop_typing(self, channel_id: str) -> None:
        """Stop typing indicator for a channel."""
        task = self._typing_tasks.pop(channel_id, None)
        if task:
            task.cancel()
