from __future__ import annotations

import json

import numpy as np
from fastapi.testclient import TestClient

import server.main as main
from tajweed_ml import api
from tajweed_ml.config import STORAGE_ROOT_ENV


class _StubError:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class _StubChecker:
    def get_expected_phonemes(self, words, **_kwargs):
        return list(words)

    def check(self, _audio, _words, sr=16_000, **_kwargs):
        del sr
        return [
            _StubError(
                word_index=0,
                error_type="tafkheem",
                rule="tafkheem/tarqeeq",
                description_en="ص sounds like س",
                severity="high",
                expected_phoneme="sˤ",
                predicted_phoneme="s",
            )
        ]


def _patch_runtime(monkeypatch) -> None:
    monkeypatch.setattr(main, "MuaalemChecker", lambda device="cpu": _StubChecker())
    monkeypatch.setattr(main, "load_quran_data", lambda: {"1:1": ["بِسْمِ", "ٱللَّهِ"]})


def test_health_endpoint(monkeypatch) -> None:
    _patch_runtime(monkeypatch)
    with TestClient(api.app) as client:
        response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_get_ayah_endpoint(monkeypatch) -> None:
    _patch_runtime(monkeypatch)
    with TestClient(api.app) as client:
        response = client.get("/api/surah/1/ayah/1")
    assert response.status_code == 200
    assert response.json()["words"] == ["بِسْمِ", "ٱللَّهِ"]


def test_websocket_summary_flow(monkeypatch) -> None:
    _patch_runtime(monkeypatch)
    with TestClient(api.app) as client:
        with client.websocket_connect("/ws/recite") as websocket:
            websocket.send_json({"type": "start", "surah": 1, "ayah": 1})
            ready = websocket.receive_json()
            assert ready["type"] == "ready"
            websocket.send_json({"type": "stop"})
            summary = websocket.receive_json()
    assert summary["type"] == "summary"
    assert summary["total_errors"] == 0


def test_websocket_dedupes_summary_errors(monkeypatch) -> None:
    class DuplicateChecker:
        def get_expected_phonemes(self, words, **_kwargs):
            del words
            return ["p1", "p2", "p3", "p4"]

        def check(self, _audio, _words, sr=16_000, **_kwargs):
            del sr
            error = _StubError(
                word_index=0,
                error_type="missing",
                rule="missing_sound",
                description_en="Sound [بِ] was skipped",
                severity="high",
                expected_phoneme="بِ",
                predicted_phoneme="(skipped)",
            )
            return [error, error]

    monkeypatch.setattr(main, "MuaalemChecker", lambda device="cpu": DuplicateChecker())
    monkeypatch.setattr(main, "load_quran_data", lambda: {"1:1": ["بِسْمِ", "ٱللَّهِ"]})

    payload = np.zeros(32_000, dtype=np.int16).tobytes()

    with TestClient(api.app) as client:
        with client.websocket_connect("/ws/recite") as websocket:
            websocket.send_json({"type": "start", "surah": 1, "ayah": 1})
            websocket.receive_json()
            websocket.send_bytes(payload)
            websocket.send_json({"type": "stop"})
            summary = websocket.receive_json()

    assert summary["type"] == "summary"
    assert summary["total_errors"] == 1
    assert len(summary["errors"]) == 1
    assert summary["errors"][0]["description"] == "Sound [بِ] was skipped"


def test_websocket_rotates_to_unseen_corrections(monkeypatch) -> None:
    class RotatingChecker:
        def get_expected_phonemes(self, words, **_kwargs):
            del words
            return ["p1", "p2", "p3", "p4", "p5", "p6"]

        def check(self, _audio, _words, sr=16_000, **_kwargs):
            del sr
            return [
                _StubError(
                    word_index=0,
                    error_type="missing",
                    rule="missing_sound",
                    description_en="Sound [بِ] was skipped",
                    severity="high",
                    expected_phoneme="بِ",
                    predicted_phoneme="(skipped)",
                ),
                _StubError(
                    word_index=1,
                    error_type="makhraj",
                    rule="makhraj",
                    description_en="ع sounds like hamza",
                    severity="high",
                    expected_phoneme="ع",
                    predicted_phoneme="ء",
                ),
            ]

    monkeypatch.setattr(main, "MuaalemChecker", lambda device="cpu": RotatingChecker())
    monkeypatch.setattr(main, "load_quran_data", lambda: {"1:1": ["بِسْمِ", "ٱللَّهِ"]})

    speech = np.full(24_000, 1000, dtype=np.int16)
    silence = np.zeros(8_000, dtype=np.int16)
    payload = np.concatenate([speech, silence]).tobytes()

    with TestClient(api.app) as client:
        with client.websocket_connect("/ws/recite") as websocket:
            websocket.send_json({"type": "start", "surah": 1, "ayah": 1})
            websocket.receive_json()

            websocket.send_bytes(payload)
            first = websocket.receive_json()

            websocket.send_bytes(payload)
            second = websocket.receive_json()

    assert first["type"] == "correction"
    assert first["word_index"] == 0
    assert first["description"] == "Sound [بِ] was skipped"

    assert second["type"] == "correction"
    assert second["word_index"] == 1
    assert second["description"] == "ع sounds like hamza"


def test_served_audio_url_rewrites_manifest_absolute_paths(monkeypatch, tmp_path) -> None:
    audio_dir = tmp_path / "audio" / "husary" / "words" / "1"
    audio_dir.mkdir(parents=True)
    clip_path = audio_dir / "001_001_00_بسم.wav"
    clip_path.write_bytes(b"fake")
    manifest_path = audio_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "1:1": [
                    {
                        "word_index": 0,
                        "path": "/Users/ahmedelmorshedy/Downloads/dashboard-full/virona-shawq-dashboard/apps/tajweed-ml/audio/husary/words/1/001_001_00_بسم.wav",
                    }
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    monkeypatch.setenv(STORAGE_ROOT_ENV, str(tmp_path))

    assert main._served_audio_url(1, 1, 0) == "/audio/husary/words/1/001_001_00_بسم.wav"
