from __future__ import annotations

from fastapi.testclient import TestClient

import server.main as main
from tajweed_ml import api


class _StubError:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class _StubChecker:
    def get_expected_phonemes(self, words):
        return list(words)

    def check(self, _audio, _words, sr=16_000):
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
