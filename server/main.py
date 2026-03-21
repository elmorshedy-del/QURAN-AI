from __future__ import annotations

import json
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

APP_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = APP_ROOT / "src"
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from server.muaalem_checker import MuaalemChecker
from tajweed_ml.config import load_config
from tajweed_ml.quran_text import load_quran_text


checker: MuaalemChecker | None = None
quran_data: dict[str, list[str]] = {}
MIN_BUFFER_BEFORE_EVAL_SEC = 2.4
MIN_NEW_AUDIO_BEFORE_EVAL_SEC = 0.8
OVERLAP_KEEP_SEC = 1.5
PROVISIONAL_CONFIRMATIONS = 2
PROVISIONAL_COOLDOWN_SEC = 1.2


def load_quran_data() -> dict[str, list[str]]:
    return load_quran_text()


def _sample_count(seconds: float) -> int:
    return int(seconds * load_config().sample_rate)


def _error_key(error) -> tuple[object, ...]:
    return (
        error.word_index,
        error.rule,
        error.error_type,
        error.expected_phoneme,
    )


def _should_emit_provisional_error(
    tracker: dict[tuple[object, ...], dict[str, int]],
    error,
    total_samples: int,
) -> bool:
    key = _error_key(error)
    state = tracker.get(key)
    if state is None or total_samples - state["last_seen"] > _sample_count(PROVISIONAL_COOLDOWN_SEC * 2):
        state = {"count": 0, "last_seen": 0, "last_emitted": -10**9}
        tracker[key] = state

    state["count"] += 1
    state["last_seen"] = total_samples
    if state["count"] < PROVISIONAL_CONFIRMATIONS:
        return False
    if total_samples - state["last_emitted"] < _sample_count(PROVISIONAL_COOLDOWN_SEC):
        return False

    state["last_emitted"] = total_samples
    return True


def _backend_health_payload() -> dict[str, object]:
    config = load_config()
    return {
        "status": "ok",
        "service": "backend",
        "ready": checker is not None,
        "model_loaded": checker is not None,
        "model": config.muaalem_model_name,
        "device": config.default_device,
        "ws_path": "/ws/recite",
        "streaming": {
            "min_buffer_ms": int(MIN_BUFFER_BEFORE_EVAL_SEC * 1000),
            "new_audio_step_ms": int(MIN_NEW_AUDIO_BEFORE_EVAL_SEC * 1000),
            "overlap_ms": int(OVERLAP_KEEP_SEC * 1000),
        },
    }


def _resolve_manifest_audio_path(path: Path, *, surah: int) -> Path | None:
    config = load_config()
    candidates: list[Path] = []
    if path:
        if path.name:
            candidates.append(config.husary_word_audio_dir / str(surah) / path.name)
        if not path.is_absolute():
            candidates.append(config.audio_dir / path)
        candidates.append(path)

    seen: set[Path] = set()
    for candidate in candidates:
        try:
            normalized = candidate.expanduser()
        except Exception:
            continue
        if normalized in seen:
            continue
        seen.add(normalized)
        if normalized.exists():
            return normalized.resolve()
    return None


def _served_audio_url(surah: int, ayah: int, word_index: int) -> str | None:
    config = load_config()
    preferred = config.served_word_audio_dir / str(surah) / str(ayah) / f"{word_index}.mp3"
    if preferred.exists():
        return f"/audio/words/{surah}/{ayah}/{word_index}.mp3"

    manifest_path = config.husary_word_audio_dir / str(surah) / "manifest.json"
    if not manifest_path.exists():
        return None
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    clips = manifest.get(f"{surah}:{ayah}", [])
    for clip in clips:
        if int(clip.get("word_index", -1)) != word_index:
            continue
        path = _resolve_manifest_audio_path(Path(str(clip.get("path", ""))), surah=surah)
        if path is None:
            continue
        try:
            relative = path.resolve().relative_to(config.audio_dir.resolve())
        except ValueError:
            return None
        return f"/audio/{relative.as_posix()}"
    return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    del app
    global checker, quran_data
    checker = MuaalemChecker(device=load_config().default_device)
    quran_data = load_quran_data()
    yield


app = FastAPI(title="Al-Tarteel API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/audio", StaticFiles(directory=str(load_config().audio_dir)), name="audio")


@app.websocket("/ws/recite")
async def recite_ws(websocket: WebSocket):
    await websocket.accept()
    window_audio = np.array([], dtype=np.float32)
    session_audio = np.array([], dtype=np.float32)
    current_surah = 1
    current_ayah = 1
    is_active = False
    total_received_samples = 0
    new_samples_since_eval = 0
    provisional_tracker: dict[tuple[object, ...], dict[str, int]] = {}

    try:
        while True:
            data = await websocket.receive()
            if data.get("type") == "websocket.disconnect":
                break
            if "text" in data:
                message = json.loads(data["text"])
                if message["type"] == "start":
                    current_surah = int(message.get("surah", 1))
                    current_ayah = int(message.get("ayah", 1))
                    window_audio = np.array([], dtype=np.float32)
                    session_audio = np.array([], dtype=np.float32)
                    is_active = True
                    total_received_samples = 0
                    new_samples_since_eval = 0
                    provisional_tracker = {}
                    words = quran_data.get(f"{current_surah}:{current_ayah}", [])
                    await websocket.send_json(
                        {
                            "type": "ready",
                            "surah": current_surah,
                            "ayah": current_ayah,
                            "words": words,
                            "total_words": len(words),
                            "backend": _backend_health_payload(),
                        }
                    )
                elif message["type"] == "stop":
                    is_active = False
                    words = quran_data.get(f"{current_surah}:{current_ayah}", [])
                    if len(session_audio) > 0 and checker is not None and words:
                        errors = checker.check(
                            session_audio,
                            words,
                            surah=current_surah,
                            ayah=current_ayah,
                        )
                        total_phonemes = max(
                            1,
                            len(
                                checker.get_expected_phonemes(
                                    words,
                                    surah=current_surah,
                                    ayah=current_ayah,
                                )
                            ),
                        )
                        error_count = len(errors)
                        score = max(0, int((1 - error_count / total_phonemes) * 100))
                        await websocket.send_json(
                            {
                                "type": "summary",
                                "score": score,
                                "total_errors": error_count,
                                "errors": [
                                    {
                                        "word_index": error.word_index,
                                        "error_type": error.error_type,
                                        "rule": error.rule,
                                        "description": error.description_en,
                                        "severity": error.severity,
                                        "expected": error.expected_phoneme,
                                        "predicted": error.predicted_phoneme,
                                    }
                                    for error in errors
                                ],
                            }
                        )
                    else:
                        await websocket.send_json(
                            {
                                "type": "summary",
                                "score": 100,
                                "total_errors": 0,
                                "errors": [],
                            }
                        )
                    window_audio = np.array([], dtype=np.float32)
                    session_audio = np.array([], dtype=np.float32)
                    provisional_tracker = {}
                elif message["type"] == "next_ayah":
                    current_ayah += 1
                    window_audio = np.array([], dtype=np.float32)
                    session_audio = np.array([], dtype=np.float32)
                    total_received_samples = 0
                    new_samples_since_eval = 0
                    provisional_tracker = {}
                    words = quran_data.get(f"{current_surah}:{current_ayah}", [])
                    await websocket.send_json(
                        {
                            "type": "ready",
                            "surah": current_surah,
                            "ayah": current_ayah,
                            "words": words,
                            "total_words": len(words),
                        }
                    )
            elif "bytes" in data and is_active and checker is not None:
                chunk = np.frombuffer(data["bytes"], dtype=np.int16).astype(np.float32) / 32768.0
                session_audio = np.concatenate([session_audio, chunk])
                window_audio = np.concatenate([window_audio, chunk])
                total_received_samples += len(chunk)
                new_samples_since_eval += len(chunk)
                if len(window_audio) < _sample_count(MIN_BUFFER_BEFORE_EVAL_SEC):
                    continue
                if new_samples_since_eval < _sample_count(MIN_NEW_AUDIO_BEFORE_EVAL_SEC):
                    continue
                new_samples_since_eval = 0
                words = quran_data.get(f"{current_surah}:{current_ayah}", [])
                if not words:
                    continue
                errors = checker.check(
                    window_audio,
                    words,
                    surah=current_surah,
                    ayah=current_ayah,
                )
                if errors:
                    top_error = errors[0]
                    if _should_emit_provisional_error(provisional_tracker, top_error, total_received_samples):
                        word_index = top_error.word_index
                        await websocket.send_json(
                            {
                                "type": "correction",
                                "word_index": word_index,
                                "word_ar": words[word_index] if word_index < len(words) else "",
                                "error_type": top_error.error_type,
                                "rule": top_error.rule,
                                "description": top_error.description_en,
                                "severity": top_error.severity,
                                "audio_url": _served_audio_url(current_surah, current_ayah, word_index),
                            }
                        )
                overlap = _sample_count(OVERLAP_KEEP_SEC)
                window_audio = window_audio[-overlap:]
    except WebSocketDisconnect:
        return


@app.get("/health")
async def health_root():
    return _backend_health_payload()


@app.get("/api/health")
async def health():
    return _backend_health_payload()


@app.get("/api/surah/{surah}/ayah/{ayah}")
async def get_ayah(surah: int, ayah: int):
    words = quran_data.get(f"{surah}:{ayah}", [])
    return {
        "surah": surah,
        "ayah": ayah,
        "words": words,
        "word_audio_urls": [
            _served_audio_url(surah, ayah, index)
            for index in range(len(words))
        ],
    }


if __name__ == "__main__":
    import uvicorn

    config = load_config()
    uvicorn.run(app, host=config.server_host, port=config.server_port)
