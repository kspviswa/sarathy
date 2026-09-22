"""Unit tests for marker image base64 encoding in agent loop."""

import base64
import tempfile
from pathlib import Path

import pytest

from sarathy.agent.loop import AgentLoop


class TestMarkerImageBase64:
    """Tests for _local_image_to_data_url and marker processing in _describe_images_with_image_provider."""

    def test_local_image_to_data_url_with_real_image(self):
        """_local_image_to_data_url returns data URL for real image file."""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            media_dir = workspace / "media"
            media_dir.mkdir()
            
            # Create a small PNG file
            img_path = media_dir / "test.png"
            img_path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
            
            loop = AgentLoop.__new__(AgentLoop)
            loop.workspace = workspace
            
            # Test with relative path (resolved against workspace/media)
            data_url = loop._local_image_to_data_url("test.png")
            assert data_url is not None
            assert data_url.startswith("data:image/png;base64,")
            
            # Verify it's valid base64
            b64_part = data_url.split(",")[1]
            decoded = base64.b64decode(b64_part)
            assert decoded.startswith(b"\x89PNG\r\n\x1a\n")

    def test_local_image_to_data_url_with_absolute_path(self):
        """_local_image_to_data_url works with absolute paths."""
        with tempfile.TemporaryDirectory() as tmpdir:
            img_path = Path(tmpdir) / "test.jpg"
            img_path.write_bytes(b"\xff\xd8\xff" + b"\x00" * 100)  # JPEG header
            
            loop = AgentLoop.__new__(AgentLoop)
            loop.workspace = Path("/tmp")  # Different workspace
            
            data_url = loop._local_image_to_data_url(str(img_path))
            assert data_url is not None
            assert data_url.startswith("data:image/jpeg;base64,")

    def test_local_image_to_data_url_with_http_url(self):
        """_local_image_to_data_url returns None for http URLs (handled separately)."""
        loop = AgentLoop.__new__(AgentLoop)
        loop.workspace = Path("/tmp")
        
        data_url = loop._local_image_to_data_url("http://example.com/image.png")
        assert data_url is None

    def test_local_image_to_data_url_with_https_url(self):
        """_local_image_to_data_url returns None for https URLs (handled separately)."""
        loop = AgentLoop.__new__(AgentLoop)
        loop.workspace = Path("/tmp")
        
        data_url = loop._local_image_to_data_url("https://example.com/image.png")
        assert data_url is None

    def test_local_image_to_data_url_missing_file(self):
        """_local_image_to_data_url returns None for missing files."""
        loop = AgentLoop.__new__(AgentLoop)
        loop.workspace = Path("/tmp")
        
        data_url = loop._local_image_to_data_url("nonexistent.png")
        assert data_url is None

    def test_local_image_to_data_url_non_image_file(self):
        """_local_image_to_data_url returns None for non-image files."""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            media_dir = workspace / "media"
            media_dir.mkdir()
            
            # Create a PDF file
            pdf_path = media_dir / "doc.pdf"
            pdf_path.write_bytes(b"%PDF-1.4\n" + b"\x00" * 100)
            
            loop = AgentLoop.__new__(AgentLoop)
            loop.workspace = workspace
            
            data_url = loop._local_image_to_data_url("doc.pdf")
            assert data_url is None

    @pytest.mark.asyncio
    async def test_marker_with_real_temp_image_file(self):
        """Marker with real temp image file -> image part URL is data:image/...;base64,..."""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            media_dir = workspace / "media"
            media_dir.mkdir()
            
            # Create a small PNG file
            img_path = media_dir / "test.png"
            img_path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
            
            loop = AgentLoop.__new__(AgentLoop)
            loop.workspace = workspace
            
            # Mock image provider
            class MockImageProvider:
                async def chat(self, messages, tools, model, temperature, max_tokens, stream):
                    class Response:
                        content = "Test description"
                    return Response()
                def get_default_model(self):
                    return "test-model"
            
            messages = [
                {"role": "user", "content": "Look at this: [image: test.png]"}
            ]
            
            result = await loop._describe_images_with_image_provider(
                messages, MockImageProvider()
            )
            
            # The user message should be rewritten with description
            user_msg = result[-1]
            assert user_msg["role"] == "user"
            assert "[image description: Test description]" in user_msg["content"][-1]["text"]

    @pytest.mark.asyncio
    async def test_marker_with_http_url_passthrough(self):
        """Marker with http(s) URL -> passed through unchanged."""
        loop = AgentLoop.__new__(AgentLoop)
        loop.workspace = Path("/tmp")
        
        class MockImageProvider:
            def __init__(self):
                self.received_parts = []
            async def chat(self, messages, tools, model, temperature, max_tokens, stream):
                # Capture the image parts sent to the provider
                user_content = messages[-1]["content"]
                if isinstance(user_content, list):
                    self.received_parts = [p for p in user_content if p.get("type") == "image_url"]
                class Response:
                    content = "Test description"
                return Response()
            def get_default_model(self):
                return "test-model"
        
        provider = MockImageProvider()
        messages = [
            {"role": "user", "content": "Look at this: [image: http://example.com/img.png]"}
        ]
        
        await loop._describe_images_with_image_provider(messages, provider)
        
        assert len(provider.received_parts) == 1
        assert provider.received_parts[0]["image_url"]["url"] == "http://example.com/img.png"

    @pytest.mark.asyncio
    async def test_marker_with_https_url_passthrough(self):
        """Marker with https URL -> passed through unchanged."""
        loop = AgentLoop.__new__(AgentLoop)
        loop.workspace = Path("/tmp")
        
        class MockImageProvider:
            def __init__(self):
                self.received_parts = []
            async def chat(self, messages, tools, model, temperature, max_tokens, stream):
                user_content = messages[-1]["content"]
                if isinstance(user_content, list):
                    self.received_parts = [p for p in user_content if p.get("type") == "image_url"]
                class Response:
                    content = "Test description"
                return Response()
            def get_default_model(self):
                return "test-model"
        
        provider = MockImageProvider()
        messages = [
            {"role": "user", "content": "Look at this: [image: https://example.com/img.png]"}
        ]
        
        await loop._describe_images_with_image_provider(messages, provider)
        
        assert len(provider.received_parts) == 1
        assert provider.received_parts[0]["image_url"]["url"] == "https://example.com/img.png"

    @pytest.mark.asyncio
    async def test_marker_with_missing_file_skipped(self):
        """Marker with missing file -> skipped, no crash."""
        loop = AgentLoop.__new__(AgentLoop)
        loop.workspace = Path("/tmp")
        
        class MockImageProvider:
            def __init__(self):
                self.received_parts = []
            async def chat(self, messages, tools, model, temperature, max_tokens, stream):
                user_content = messages[-1]["content"]
                if isinstance(user_content, list):
                    self.received_parts = [p for p in user_content if p.get("type") == "image_url"]
                class Response:
                    content = "Test description"
                return Response()
            def get_default_model(self):
                return "test-model"
        
        provider = MockImageProvider()
        messages = [
            {"role": "user", "content": "Look at this: [image: /nonexistent/path/img.png]"}
        ]
        
        result = await loop._describe_images_with_image_provider(messages, provider)
        
        # No image parts should be sent to provider
        assert len(provider.received_parts) == 0
        # The message should still be rewritten but with no description (or empty)
        user_msg = result[-1]
        assert user_msg["role"] == "user"

    @pytest.mark.asyncio
    async def test_marker_with_non_image_file_skipped(self):
        """Marker with non-image file (e.g. .pdf) -> skipped."""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            media_dir = workspace / "media"
            media_dir.mkdir()
            
            # Create a PDF file
            pdf_path = media_dir / "doc.pdf"
            pdf_path.write_bytes(b"%PDF-1.4\n" + b"\x00" * 100)
            
            loop = AgentLoop.__new__(AgentLoop)
            loop.workspace = workspace
            
            class MockImageProvider:
                def __init__(self):
                    self.received_parts = []
                async def chat(self, messages, tools, model, temperature, max_tokens, stream):
                    user_content = messages[-1]["content"]
                    if isinstance(user_content, list):
                        self.received_parts = [p for p in user_content if p.get("type") == "image_url"]
                    class Response:
                        content = "Test description"
                    return Response()
                def get_default_model(self):
                    return "test-model"
            
            provider = MockImageProvider()
            messages = [
                {"role": "user", "content": "Look at this: [image: doc.pdf]"}
            ]
            
            await loop._describe_images_with_image_provider(messages, provider)
            
            # No image parts should be sent to provider
            assert len(provider.received_parts) == 0

    @pytest.mark.asyncio
    async def test_mixed_message_real_image_http_missing(self):
        """Mixed message (real image + http URL + missing file) -> correct parts only."""
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            media_dir = workspace / "media"
            media_dir.mkdir()
            
            # Create a small PNG file
            img_path = media_dir / "test.png"
            img_path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
            
            loop = AgentLoop.__new__(AgentLoop)
            loop.workspace = workspace
            
            class MockImageProvider:
                def __init__(self):
                    self.received_parts = []
                async def chat(self, messages, tools, model, temperature, max_tokens, stream):
                    user_content = messages[-1]["content"]
                    if isinstance(user_content, list):
                        self.received_parts = [p for p in user_content if p.get("type") == "image_url"]
                    class Response:
                        content = "Test description"
                    return Response()
                def get_default_model(self):
                    return "test-model"
            
            provider = MockImageProvider()
            messages = [
                {"role": "user", "content": "Images: [image: test.png] [image: http://example.com/img.jpg] [image: /missing.png]"}
            ]
            
            await loop._describe_images_with_image_provider(messages, provider)
            
            # Should have 2 image parts: the real image (as data URL) and the http URL
            assert len(provider.received_parts) == 2
            
            # First should be data URL for test.png
            assert provider.received_parts[0]["image_url"]["url"].startswith("data:image/png;base64,")
            # Second should be the http URL unchanged
            assert provider.received_parts[1]["image_url"]["url"] == "http://example.com/img.jpg"