"""Image preprocessing for the vision path.

Phone cameras produce multi-megabyte images (an iPhone photo is routinely
3-6 MB, 4032x3024). Sending those raw to the local vision model wastes
bandwidth and, more importantly, inference time — the model has to process a
huge token budget of pixels before it can answer. We downscale and re-encode
before the image ever reaches the provider.

The transform is deliberately conservative: we only shrink, never upscale, and
we keep the longest side at ``max_dim`` (default 1568, the standard vision
budget) so OCR-heavy screenshots stay legible.
"""

from __future__ import annotations

import base64
import io
import mimetypes
from pathlib import Path

from loguru import logger

# Longest-side cap. 1568 keeps text legible while cutting a 4032px photo to
# ~1/6 the pixels.
DEFAULT_MAX_DIM = 1568
# Images smaller than this in bytes are sent untouched — re-encoding a small
# PNG to JPEG can actually *grow* it and lose fidelity.
DEFAULT_MIN_BYTES = 400 * 1024
# JPEG quality for re-encoded photos.
DEFAULT_JPEG_QUALITY = 85


def _pillow():
    try:
        from PIL import Image  # noqa: WPS433 (lazy import; Pillow is optional at runtime)
        return Image
    except Exception:  # pragma: no cover - Pillow is a declared dependency
        return None


def prepare_image_bytes(
    raw: bytes,
    mime: str,
    *,
    max_dim: int = DEFAULT_MAX_DIM,
    min_bytes: int = DEFAULT_MIN_BYTES,
    jpeg_quality: int = DEFAULT_JPEG_QUALITY,
) -> tuple[bytes, str]:
    """Return ``(bytes, mime)`` for an image, downscaled if it is large.

    - If Pillow is unavailable, or the image cannot be decoded, or it is already
      small (<= ``min_bytes`` and within ``max_dim``), the original bytes/mime
      are returned unchanged.
    - Otherwise the longest side is capped at ``max_dim`` and the result is
      re-encoded. Photos become JPEG; images with transparency stay PNG.
    """
    pil_image = _pillow()
    if pil_image is None:
        return raw, mime

    # Read the header only (cheap) to learn the dimensions without decoding the
    # full pixel buffer. A solid-colour 4000px PNG can be a few KB in bytes yet
    # enormous in pixels, so byte size alone is not a safe fast-path test.
    try:
        img = pil_image.open(io.BytesIO(raw))
        width, height = img.size
    except Exception as exc:
        logger.debug("image_prep: could not read image header ({}); sending raw", exc)
        return raw, mime

    longest = max(width, height)
    needs_resize = longest > max_dim
    needs_reencode = needs_resize or len(raw) > min_bytes

    # Fast path: modest dimensions AND small file -> send untouched (re-encoding
    # a small PNG to JPEG can grow it and lose fidelity).
    if not needs_reencode:
        return raw, mime

    try:
        img.load()
    except Exception as exc:
        logger.debug("image_prep: could not decode image ({}); sending raw", exc)
        return raw, mime

    if needs_resize:
        scale = max_dim / float(longest)
        new_size = (max(1, int(width * scale)), max(1, int(height * scale)))
        img = img.resize(new_size, pil_image.LANCZOS)

    has_alpha = img.mode in ("RGBA", "LA") or (
        img.mode == "P" and "transparency" in img.info
    )

    buf = io.BytesIO()
    if has_alpha:
        img.save(buf, format="PNG", optimize=True)
        out_mime = "image/png"
    else:
        if img.mode != "RGB":
            img = img.convert("RGB")
        img.save(buf, format="JPEG", quality=jpeg_quality, optimize=True)
        out_mime = "image/jpeg"

    out = buf.getvalue()
    # If re-encoding somehow produced something larger, keep the original.
    if len(out) >= len(raw) and not needs_resize:
        return raw, mime

    logger.debug(
        "image_prep: {}x{} {} -> {}x{} {} ({} KB -> {} KB)",
        width, height, mime,
        *img.size, out_mime,
        len(raw) // 1024, len(out) // 1024,
    )
    return out, out_mime


def prepare_image_data_url(
    path: str | Path,
    *,
    max_dim: int = DEFAULT_MAX_DIM,
    min_bytes: int = DEFAULT_MIN_BYTES,
    jpeg_quality: int = DEFAULT_JPEG_QUALITY,
) -> str | None:
    """Read an image file and return a (possibly downscaled) data URL.

    Returns ``None`` if the path is not an existing image file.
    """
    p = Path(path)
    mime, _ = mimetypes.guess_type(str(p))
    if not p.is_file() or not mime or not mime.startswith("image/"):
        return None

    raw = p.read_bytes()
    out_bytes, out_mime = prepare_image_bytes(
        raw, mime, max_dim=max_dim, min_bytes=min_bytes, jpeg_quality=jpeg_quality
    )
    b64 = base64.b64encode(out_bytes).decode()
    return f"data:{out_mime};base64,{b64}"
