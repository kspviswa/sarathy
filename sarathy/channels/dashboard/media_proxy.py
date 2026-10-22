"""The same-origin image proxy (spec 152 §A).

The Ask UI draws images that live on the open web — the favicon of every
cited source, the thumbnails of the media search. Pointing the browser
straight at those hosts fails twice over:

* a third-party favicon service is unreachable from the installed PWA and on
  filtered networks, so every source card showed a blank square;
* many result hosts refuse hotlinking (they answer 403 unless the request
  carries a browser ``Referer``), so the media rail rendered as empty boxes.

The fix is to stop pointing the browser at third-party hosts. This module
fetches the image **on the box**, with a browser ``User-Agent`` and a
``Referer`` that matches the target origin, and the dashboard serves it from
its own origin. The bytes are cached on disk, so a repeat request never
leaves the machine.

The fetch is SSRF-guarded: only ``http``/``https``, only the default ports,
and the host must resolve to a public address — a private, loopback,
link-local or otherwise reserved address is refused before a socket is
opened. The connection is then pinned to the addresses that were checked, so
the name cannot be re-resolved to something else between the check and the
connection.
"""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import socket
import time
from dataclasses import dataclass
from email.utils import formatdate
from pathlib import Path
from typing import Awaitable, Callable
from urllib.parse import urljoin, urlsplit, urlunsplit

import aiohttp
from aiohttp.abc import AbstractResolver
from loguru import logger

# The User-Agent the upstream sees. A lot of hosts answer 403 to anything
# that does not look like a browser.
PROXY_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# The body cap. An image larger than this is refused, not truncated.
MAX_IMAGE_BYTES = 5 * 1024 * 1024

# How long one upstream fetch may take.
FETCH_TIMEOUT_S = 20.0

# At most one redirect, and the target of that redirect is checked again
# with the SAME rules as the first URL.
MAX_REDIRECTS = 1

# Only these two schemes, and only the default ports.
ALLOWED_SCHEMES = ("http", "https")
ALLOWED_PORTS = (80, 443)

# How long a browser may cache the proxied image.
CACHE_MAX_AGE_S = 7 * 24 * 60 * 60

# The file extension per content type — the cache file is
# ``<sha256>.<ext>``.
_EXT_BY_TYPE = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/avif": ".avif",
    "image/bmp": ".bmp",
    "image/x-icon": ".ico",
    "image/vnd.microsoft.icon": ".ico",
    "image/tiff": ".tiff",
}

# The fetcher signature: (url, checked addresses, timeout) -> (bytes, type).
Fetcher = Callable[[str, list[str], float], Awaitable[tuple[bytes, str]]]


class ProxyError(Exception):
    """A refusal, with the status the API answers it with.

    Every failure the proxy can produce is one of these — never an
    unhandled exception, never a 500 with a stack trace.
    """

    def __init__(self, message: str, code: str, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


@dataclass
class CachedImage:
    """One proxied image — the bytes, where they came from and where they live."""

    data: bytes
    content_type: str
    path: Path
    etag: str
    fetched_at: float
    last_modified: str
    from_cache: bool = False


def normalise_url(raw: str) -> tuple[str, str, int]:
    """The URL to fetch, its host and its port.

    A refusal is a :class:`ProxyError` with a 400: a scheme that is not
    http(s), a URL without a host, credentials in the URL, or a port that is
    not 80/443.
    """
    text = (raw or "").strip()
    if not text:
        raise ProxyError("missing url", "missing_url", 400)

    try:
        parts = urlsplit(text)
        port = parts.port
    except ValueError as err:
        raise ProxyError(f"invalid url: {err}", "invalid_url", 400) from err

    scheme = (parts.scheme or "").lower()
    if scheme not in ALLOWED_SCHEMES:
        raise ProxyError(
            f"only {' and '.join(ALLOWED_SCHEMES)} urls are proxied", "bad_scheme", 400
        )

    host = (parts.hostname or "").strip()
    if not host:
        raise ProxyError("missing host", "missing_host", 400)

    if parts.username or parts.password:
        raise ProxyError("credentials in the url are not allowed", "credentials_not_allowed", 400)

    resolved_port = port or (443 if scheme == "https" else 80)
    if resolved_port not in ALLOWED_PORTS:
        raise ProxyError(f"port {resolved_port} is not allowed", "bad_port", 400)

    netloc = host if resolved_port == (443 if scheme == "https" else 80) else f"{host}:{resolved_port}"
    url = urlunsplit((scheme, netloc, parts.path or "/", parts.query, ""))
    return url, host, resolved_port


def is_public_address(ip: str) -> bool:
    """True when the address is a routable public one.

    Everything that is private, loopback, link-local, multicast, reserved or
    unspecified is refused — that is the whole SSRF guard.
    """
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False

    # An IPv4-mapped IPv6 address (::ffff:127.0.0.1) is an IPv4 address in
    # disguise — check the address it carries.
    mapped = getattr(addr, "ipv4_mapped", None)
    if mapped is not None:
        addr = mapped

    if (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_reserved
        or addr.is_unspecified
    ):
        return False
    return True


async def resolve_public_ips(host: str, port: int) -> list[str]:
    """The addresses of `host` — every one of them must be public.

    A name that resolves to a private address is refused outright: a host
    that has both a public and a private address is refused too, because the
    connection could land on either.
    """
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (OSError, UnicodeError) as err:
        raise ProxyError(f"cannot resolve {host}", "dns_error", 502) from err

    addresses: list[str] = []
    for info in infos:
        ip = info[4][0]
        if not is_public_address(ip):
            raise ProxyError(
                f"{host} resolves to a non-public address", "blocked_host", 403
            )
        if ip not in addresses:
            addresses.append(ip)

    if not addresses:
        raise ProxyError(f"cannot resolve {host}", "dns_error", 502)
    return addresses


class _PinnedResolver(AbstractResolver):
    """A resolver that answers with the addresses that were already checked.

    The connection is made to one of THESE addresses, so the name cannot be
    re-resolved to something private between the check and the connection.
    """

    def __init__(self, addresses: list[str]) -> None:
        self._addresses = addresses

    async def resolve(
        self, host: str, port: int = 0, family: int = socket.AF_INET
    ) -> list[dict[str, object]]:
        results: list[dict[str, object]] = []
        for ip in self._addresses:
            try:
                addr = ipaddress.ip_address(ip)
            except ValueError:
                continue
            addr_family = socket.AF_INET if addr.version == 4 else socket.AF_INET6
            if family not in (socket.AF_UNSPEC, addr_family):
                continue
            results.append(
                {
                    "hostname": host,
                    "host": ip,
                    "port": port,
                    "family": addr_family,
                    "proto": 0,
                    "flags": socket.AI_NUMERICHOST,
                }
            )
        return results

    async def close(self) -> None:
        return None


async def read_capped(resp: aiohttp.ClientResponse, cap: int) -> bytes:
    """The whole body, up to `cap` bytes.

    The body is read in CHUNKS and to the END: a single ``read(n)`` returns
    whatever has arrived so far, and a truncated JPEG decodes into a picture
    with a grey band under it — a thumbnail that LOOKS empty.
    """
    chunks: list[bytes] = []
    total = 0
    async for chunk in resp.content.iter_chunked(64 * 1024):
        total += len(chunk)
        if total > cap:
            raise ProxyError("image too large", "too_large", 502)
        chunks.append(chunk)
    return b"".join(chunks)


async def fetch_remote_image(
    url: str, addresses: list[str], timeout_s: float = FETCH_TIMEOUT_S
) -> tuple[bytes, str]:
    """Fetch the image at `url` from the checked `addresses`.

    At most one redirect is followed, and the target of that redirect is
    resolved and checked again with the same rules. Only an ``image/*``
    response is accepted, and the body is capped.
    """
    current = url
    checked = addresses
    for hop in range(MAX_REDIRECTS + 1):
        normalised, host, port = normalise_url(current)
        if hop > 0:
            # The redirect landed somewhere else — that name is checked again,
            # with the same rules as the first one.
            checked = await resolve_public_ips(host, port)

        parts = urlsplit(normalised)
        referer = f"{parts.scheme}://{parts.netloc}/"
        headers = {
            "User-Agent": PROXY_USER_AGENT,
            "Referer": referer,
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }

        connector = aiohttp.TCPConnector(resolver=_PinnedResolver(checked))
        timeout = aiohttp.ClientTimeout(total=timeout_s, connect=10)
        async with aiohttp.ClientSession(
            connector=connector, timeout=timeout, headers=headers
        ) as client:
            try:
                async with client.get(normalised, allow_redirects=False) as resp:
                    if resp.status in (301, 302, 303, 307, 308):
                        location = resp.headers.get("Location", "")
                        if hop >= MAX_REDIRECTS or not location:
                            raise ProxyError("too many redirects", "bad_redirect", 502)
                        current = urljoin(normalised, location)
                        continue

                    if resp.status >= 400:
                        raise ProxyError(
                            f"upstream answered {resp.status}", "upstream_error", 502
                        )

                    content_type = (
                        (resp.headers.get("Content-Type", "") or "").split(";")[0]
                    ).strip().lower()
                    if not content_type.startswith("image/"):
                        raise ProxyError(
                            f"upstream sent {content_type or 'no content type'}",
                            "not_an_image",
                            502,
                        )

                    data = await read_capped(resp, MAX_IMAGE_BYTES)
                    if not data:
                        raise ProxyError("upstream sent an empty body", "empty_body", 502)
                    return data, content_type
            except ProxyError:
                raise
            except asyncio.TimeoutError as err:
                raise ProxyError("upstream timed out", "timeout", 502) from err
            except aiohttp.ClientError as err:
                raise ProxyError(f"upstream failed: {err}", "upstream_error", 502) from err

    raise ProxyError("too many redirects", "bad_redirect", 502)


def cache_key(url: str) -> str:
    """The cache key of a URL — the sha256 of it."""
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


def _last_modified(path: Path) -> str:
    """The file's mtime as an HTTP date."""
    try:
        return formatdate(path.stat().st_mtime, usegmt=True)
    except OSError:
        return formatdate(time.time(), usegmt=True)


def read_cached(cache_dir: Path, url: str) -> CachedImage | None:
    """The cached image for `url` — ``None`` when there is none.

    The sidecar holds the source URL, the content type and the fetch time;
    the bytes live next to it as ``<sha256>.<ext>``.
    """
    key = cache_key(url)
    meta_path = cache_dir / f"{key}.json"
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(meta, dict):
        return None
    if meta.get("url") != url:
        return None

    name = str(meta.get("file") or "")
    # The file name comes from our own cache — but it is written to disk, so
    # it is checked before it is joined to the directory.
    if not name or "/" in name or "\\" in name or name.startswith("."):
        return None

    data_path = cache_dir / name
    try:
        data = data_path.read_bytes()
    except OSError:
        return None
    if not data:
        return None

    return CachedImage(
        data=data,
        content_type=str(meta.get("content_type") or "application/octet-stream"),
        path=data_path,
        etag=key,
        fetched_at=float(meta.get("fetched_at") or 0.0),
        last_modified=_last_modified(data_path),
        from_cache=True,
    )


def write_cached(
    cache_dir: Path, url: str, data: bytes, content_type: str
) -> CachedImage:
    """Write the image to the cache and return it."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = cache_key(url)
    ext = _EXT_BY_TYPE.get(content_type, ".img")
    name = f"{key}{ext}"
    data_path = cache_dir / name
    meta_path = cache_dir / f"{key}.json"

    # Written through a temporary file, so a half-written image is never
    # served as a cache hit.
    tmp_path = data_path.with_name(f"{name}.tmp")
    try:
        tmp_path.write_bytes(data)
        tmp_path.replace(data_path)
        meta_path.write_text(
            json.dumps(
                {
                    "url": url,
                    "content_type": content_type,
                    "file": name,
                    "fetched_at": time.time(),
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
    except OSError as err:
        logger.warning("Could not write the media proxy cache: {}", err)

    return CachedImage(
        data=data,
        content_type=content_type,
        path=data_path,
        etag=key,
        fetched_at=time.time(),
        last_modified=_last_modified(data_path),
        from_cache=False,
    )


class MediaProxy:
    """The proxy: the guard, the cache and the fetch.

    `fetch` is the seam the tests use — a fetcher that answers from a
    fixture instead of the network. The guard in front of it always runs.
    """

    def __init__(
        self,
        cache_dir: Path,
        *,
        timeout_s: float = FETCH_TIMEOUT_S,
        fetch: Fetcher | None = None,
    ) -> None:
        self.cache_dir = Path(cache_dir)
        self.timeout_s = timeout_s
        self._fetch = fetch

    async def get(self, raw_url: str) -> CachedImage:
        """The image at `raw_url` — from the cache when it is there.

        Raises :class:`ProxyError` for every refusal and every upstream
        failure; the caller turns that into a status.
        """
        url, host, port = normalise_url(raw_url)

        cached = read_cached(self.cache_dir, url)
        if cached is not None:
            return cached

        # The guard runs BEFORE the fetch: a blocked host never reaches the
        # network, not even a name that resolves to a public address now and
        # to a private one later.
        addresses = await resolve_public_ips(host, port)

        fetcher = self._fetch or fetch_remote_image
        data, content_type = await fetcher(url, addresses, self.timeout_s)

        content_type = (content_type or "").split(";")[0].strip().lower()
        if not content_type.startswith("image/"):
            raise ProxyError(
                f"upstream sent {content_type or 'no content type'}", "not_an_image", 502
            )
        if not data:
            raise ProxyError("upstream sent an empty body", "empty_body", 502)
        if len(data) > MAX_IMAGE_BYTES:
            raise ProxyError("image too large", "too_large", 502)

        return write_cached(self.cache_dir, url, data, content_type)
