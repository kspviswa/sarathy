"""Tests for image preprocessing (downscaling large images before the vision path)."""

import base64
import io
import tempfile
from pathlib import Path

import pytest
from PIL import Image

from sarathy.agent.image_prep import (
    prepare_image_bytes,
    prepare_image_data_url,
)


def _png_bytes(size, color=(120, 30, 200)):
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


class TestPrepareImageBytes:
    def test_small_image_untouched(self):
        """A small image is returned byte-identical (no re-encode)."""
        raw = _png_bytes((100, 100))
        out, mime = prepare_image_bytes(raw, "image/png")
        assert out == raw
        assert mime == "image/png"

    def test_large_dimensions_downscaled(self):
        """A 4032px-wide photo is scaled so its longest side <= max_dim."""
        raw = _png_bytes((4032, 3024))
        out, mime = prepare_image_bytes(raw, "image/png", max_dim=1568)
        img = Image.open(io.BytesIO(out))
        assert max(img.size) <= 1568
        # Aspect ratio preserved (within rounding)
        assert abs(img.size[0] / img.size[1] - 4032 / 3024) < 0.02
        # And it actually got smaller
        assert len(out) < len(raw)

    def test_large_png_with_alpha_stays_png(self):
        """Transparent images keep PNG (JPEG has no alpha)."""
        buf = io.BytesIO()
        Image.new("RGBA", (3000, 2000), (10, 20, 30, 128)).save(buf, format="PNG")
        raw = buf.getvalue()
        out, mime = prepare_image_bytes(raw, "image/png", max_dim=1000)
        assert mime == "image/png"
        assert Image.open(io.BytesIO(out)).mode in ("RGBA", "LA", "P")

    def test_photo_becomes_jpeg(self):
        """Opaque large images are re-encoded to JPEG for size."""
        raw = _png_bytes((2400, 1800))
        out, mime = prepare_image_bytes(raw, "image/png", max_dim=800)
        assert mime == "image/jpeg"
        assert Image.open(io.BytesIO(out)).format == "JPEG"

    def test_undecodable_bytes_returned_raw(self):
        """Garbage bytes are passed through rather than crashing the turn."""
        raw = b"not-an-image-at-all" * 30000
        out, mime = prepare_image_bytes(raw, "image/png", min_bytes=1024)
        assert out == raw
        assert mime == "image/png"

    def test_never_upscales(self):
        """An image smaller than max_dim keeps its dimensions."""
        raw = _png_bytes((640, 480))
        # Force re-encode path with a tiny min_bytes
        out, _ = prepare_image_bytes(raw, "image/png", max_dim=1568, min_bytes=1)
        img = Image.open(io.BytesIO(out))
        assert img.size == (640, 480)


class TestPrepareImageDataUrl:
    def test_returns_data_url(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "photo.png"
            p.write_bytes(_png_bytes((2000, 1500)))
            url = prepare_image_data_url(p, max_dim=800)
            assert url is not None
            assert url.startswith("data:image/jpeg;base64,")
            decoded = base64.b64decode(url.split(",", 1)[1])
            assert Image.open(io.BytesIO(decoded)).size == (800, 600)

    def test_missing_file_returns_none(self):
        assert prepare_image_data_url("/nonexistent/pic.png") is None

    def test_non_image_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "doc.pdf"
            p.write_bytes(b"%PDF-1.4\n")
            assert prepare_image_data_url(p) is None


class TestLoopIntegration:
    def test_loop_local_image_to_data_url_downscales(self):
        """The agent loop's helper downscales via the shared preprocessor."""
        from sarathy.agent.loop import AgentLoop

        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            media = workspace / "media"
            media.mkdir()
            big = media / "big.png"
            big.write_bytes(_png_bytes((4000, 3000)))

            loop = AgentLoop.__new__(AgentLoop)
            loop.workspace = workspace
            url = loop._local_image_to_data_url("big.png")
            assert url is not None
            decoded = base64.b64decode(url.split(",", 1)[1])
            assert max(Image.open(io.BytesIO(decoded)).size) <= 1568
