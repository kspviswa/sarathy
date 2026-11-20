"""Spec 181 — one script-driven TTS backend for satellites and voice notes."""

from __future__ import annotations

import json
import os
import subprocess
import wave
from pathlib import Path

import numpy as np
import pytest
from typer.testing import CliRunner

from sarathy.bus.queue import MessageBus
from sarathy.channels.dashboard.server import DashboardChannel
from sarathy.channels.satellites import SatellitesChannel
from sarathy.cli.commands import app
from sarathy.config.loader import _migrate_config, load_config, save_config
from sarathy.config.schema import Config, DashboardConfig, TTSEngineConfig, VoiceTTSConfig
from sarathy.tts import (
    TTSResolutionError,
    require_resolution,
    resolution,
    synthesize_note,
)

TTS_SCRIPT = Path.home() / ".sarathy" / "workspace" / "voice" / "tts.sh"

STUB_ENGINE = """#!/usr/bin/env bash
set -euo pipefail
OUT="$2"
shift 2
RATE="${STUB_RATE:-16000}"
FRAMES="${STUB_FRAMES:-160}"
python3 - "$OUT" "$RATE" "$FRAMES" <<'PY'
import sys, wave
out, rate, frames = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
with wave.open(out, "wb") as handle:
    handle.setnchannels(1)
    handle.setsampwidth(2)
    handle.setframerate(rate)
    handle.writeframes(b"\\x10\\x00" * frames)
PY
"""


def _stub(path: Path) -> Path:
    path.write_text(STUB_ENGINE, encoding="utf-8")
    path.chmod(0o755)
    return path


def _config_with(
    path: Path,
    engine: str,
    engines: dict[str, Path],
    fallback: list[str] | None = None,
    rate: int = 16_000,
) -> Config:
    cfg = Config()
    cfg.voice.tts.engine = engine
    cfg.voice.tts.fallback = fallback if fallback is not None else []
    cfg.voice.tts.engines = {
        name: TTSEngineConfig(
            command=str(script), sample_rate=rate, languages=["en-gb"], format="wav"
        )
        for name, script in engines.items()
    }
    save_config(cfg, path)
    return cfg


@pytest.fixture
def voice_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    config_path = tmp_path / "config.json"
    monkeypatch.setenv("SARATHY_CONFIG_PATH", str(config_path))
    monkeypatch.setenv("SARATHY_TTS_SCRIPT", str(TTS_SCRIPT))
    monkeypatch.setenv("SARATHY_LEGACY_ENGINE_CONF", str(tmp_path / "no-engine.conf"))
    monkeypatch.delenv("TTS_ENGINE", raising=False)
    monkeypatch.delenv("TTS_NO_FALLBACK", raising=False)
    monkeypatch.delenv("STUB_RATE", raising=False)
    monkeypatch.delenv("STUB_FRAMES", raising=False)
    return config_path


def test_voice_tts_defaults_and_deprecated_alias_folding() -> None:
    tts = VoiceTTSConfig()
    assert tts.engine == "maya2"
    assert tts.fallback == ["kokoro"]
    assert set(tts.engines) == {"maya2", "kokoro"}
    assert tts.engines["maya2"].type == "script"
    assert tts.engines["maya2"].sample_rate == 48_000
    assert tts.engines["kokoro"].sample_rate == 24_000
    assert Config().voice.tts.engine == "maya2"

    raw = {
        "channels": {
            "satellites": {"ttsVoice": "bm_lewis", "ttsLang": "en-gb", "ttsSpeed": 0.95}
        }
    }
    folded = _migrate_config(raw)
    assert folded["voice"]["tts"] == {
        "voice": "bm_lewis",
        "lang": "en-gb",
        "speed": 0.95,
    }
    cfg = Config.model_validate(folded)
    assert (cfg.voice.tts.voice, cfg.voice.tts.lang, cfg.voice.tts.speed) == (
        "bm_lewis",
        "en-gb",
        0.95,
    )
    # Existing satellites keys stay accepted; canonical values win.
    assert cfg.channels.satellites.tts_voice == "bm_lewis"
    explicit = _migrate_config(
        {
            "channels": {"satellites": {"ttsVoice": "old"}},
            "voice": {"tts": {"voice": "new"}},
        }
    )
    assert explicit["voice"]["tts"]["voice"] == "new"


def test_engine_resolution_available_missing_and_all_missing(
    voice_env: Path, tmp_path: Path
) -> None:
    first = _stub(tmp_path / "first.sh")
    second = _stub(tmp_path / "second.sh")
    _config_with(voice_env, "first", {"first": first, "second": second}, ["second"])

    ok = resolution(config_path=voice_env)
    assert ok["engine"] == "first"
    assert ok["resolved"] == {"satellite": "first", "note": "first"}
    assert ok["error"] is None

    cfg = load_config(voice_env)
    cfg.voice.tts.engine = "gone"
    cfg.voice.tts.fallback = ["second", "first"]
    save_config(cfg, voice_env)
    fallback = require_resolution(config_path=voice_env)
    assert fallback["resolved"] == {"satellite": "second", "note": "second"}
    gone = next(item for item in fallback["engines"] if item["name"] == "gone")
    assert gone["available"] is False
    assert gone["reason"] == "script not found"

    cfg.voice.tts.engine = "gone"
    cfg.voice.tts.fallback = ["also-gone"]
    save_config(cfg, voice_env)
    result = resolution(config_path=voice_env)
    assert result["resolved"] == {"satellite": None, "note": None}
    assert "no TTS engine available" in result["error"]
    with pytest.raises(TTSResolutionError, match="no TTS engine available"):
        require_resolution(config_path=voice_env)

    out = tmp_path / "never.wav"
    with pytest.raises(TTSResolutionError, match="skipped"):
        synthesize_note("hello", out, config_path=voice_env)
    assert not out.exists()


def test_tts_sh_dispatches_to_stub_engine(voice_env: Path, tmp_path: Path) -> None:
    stub = _stub(tmp_path / "echo.sh")
    _config_with(voice_env, "echo", {"echo": stub})

    out = tmp_path / "note.wav"
    proc = subprocess.run(
        [str(TTS_SCRIPT), "hello world", str(out), "--format", "wav"],
        capture_output=True,
        text=True,
        check=False,
        env=os.environ.copy(),
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "engine=echo sample_rate=16000 format=wav"
    assert out.is_file() and out.stat().st_size > 0
    with wave.open(str(out), "rb") as handle:
        assert handle.getframerate() == 16_000
        assert handle.getnchannels() == 1


@pytest.mark.parametrize(
    ("rate", "frames"),
    [(24_000, 2_400), (48_000, 4_800)],
)
def test_satellite_synthesize_returns_24k_int16_mono(
    voice_env: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    rate: int,
    frames: int,
) -> None:
    stub = _stub(tmp_path / "stub.sh")
    _config_with(voice_env, "stub", {"stub": stub}, rate=rate)
    monkeypatch.setenv("STUB_RATE", str(rate))
    monkeypatch.setenv("STUB_FRAMES", str(frames))

    channel = SatellitesChannel(
        Config().channels.satellites, MessageBus(), tts_fn=None
    )
    pcm = channel._synthesize("hello")
    samples = np.frombuffer(pcm, dtype="<i2")
    assert len(pcm) == len(samples) * 2
    assert len(samples) == frames * 24_000 // rate
    assert len(samples) / 24_000 == pytest.approx(0.1)
    assert set(samples.tolist()) == {16}


def test_cli_tts_set_and_status(voice_env: Path, tmp_path: Path) -> None:
    stub = _stub(tmp_path / "stub.sh")
    _config_with(voice_env, "stub", {"stub": stub}, ["stub"])
    runner = CliRunner()

    result = runner.invoke(app, ["tts", "set", "stub"])
    assert result.exit_code == 0, result.output
    assert "engine=stub" in result.output
    assert load_config(voice_env).voice.tts.engine == "stub"

    status = runner.invoke(app, ["tts", "status"])
    assert status.exit_code == 0, status.output
    assert "fallback=stub" in status.output
    assert "satellite=stub" in status.output
    assert "note=stub" in status.output
    assert "status=available" in status.output

    switched = runner.invoke(app, ["tts", "set", "missing"])
    assert switched.exit_code == 0, switched.output
    status = runner.invoke(app, ["tts", "status"])
    assert status.exit_code == 0, status.output
    assert "engine=missing" in status.output
    assert "satellite=stub" in status.output
    assert "status=unavailable reason=script not found" in status.output

    note = runner.invoke(
        app, ["tts", "note", "--text", "hello", "--out", str(tmp_path / "note.wav")]
    )
    assert note.exit_code == 0, note.output
    assert "engine=stub sample_rate=16000 format=wav" in note.output
    assert (tmp_path / "note.wav").is_file()


async def test_dashboard_voice_tts_endpoint(voice_env: Path, tmp_path: Path) -> None:
    stub = _stub(tmp_path / "stub.sh")
    _config_with(voice_env, "stub", {"stub": stub}, ["stub"])
    channel = DashboardChannel(
        DashboardConfig(),
        MessageBus(),
        config_path=voice_env,
        devices_path=tmp_path / "devices.json",
    )
    response = await channel._api_voice_tts(None)  # type: ignore[arg-type]
    data = json.loads(response.text)
    assert set(data) == {"engine", "fallback", "resolved", "engines"}
    assert data["engine"] == "stub"
    assert data["fallback"] == ["stub"]
    assert data["resolved"] == {"satellite": "stub", "note": "stub"}
    assert data["engines"][0]["available"] is True
