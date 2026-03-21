from __future__ import annotations

import asyncio
import json
import ssl
from itertools import islice
from pathlib import Path

import numpy as np
import typer

from server.main import _collapse_word_level_errors
from server.muaalem_checker import MuaalemChecker

from .audio import load_audio
from .checker import check_ghunnah, check_madd, load_checker
from .config import load_config
from .optional import MissingDependencyError, dependency_report, require_dependency
from .quran_text import load_quran_text
from .schemas import RuleAnnotation, RuleKind
from .segmenter import download_segmenter_model, load_segmenter

app = typer.Typer(help="Al-Tarteel Muaalem-based CLI")


def _echo_json(payload: object) -> None:
    typer.echo(json.dumps(payload, ensure_ascii=False, indent=2))


def _resolve_manifest_audio_path(path: str | Path, *, surah: int) -> Path:
    config = load_config()
    raw_path = Path(path)
    candidates = [
        config.husary_word_audio_dir / str(surah) / raw_path.name,
        config.audio_dir / raw_path,
        raw_path,
    ]
    for candidate in candidates:
        expanded = candidate.expanduser()
        if expanded.exists():
            return expanded.resolve()
    raise FileNotFoundError(f"Could not resolve Husary clip path for {path}")


def _load_manifest_clips(surah: int, ayah: int, word_limit: int | None = None) -> tuple[list[str], list[Path]]:
    config = load_config()
    manifest_path = config.husary_word_audio_dir / str(surah) / "manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"Manifest not found for surah {surah}: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    clips = manifest.get(f"{surah}:{ayah}", [])
    if not clips:
        raise FileNotFoundError(f"No clips found for {surah}:{ayah} in {manifest_path}")
    if word_limit is not None:
        clips = list(islice(clips, word_limit))
    words = [str(clip.get("word", "")) for clip in clips]
    audio_paths = [
        _resolve_manifest_audio_path(str(clip.get("path", "")), surah=surah)
        for clip in clips
    ]
    return words, audio_paths


def _concat_audio(audio_paths: list[Path]) -> tuple[np.ndarray, int]:
    waveform, sample_rate = load_audio(audio_paths[0])
    segments = [waveform.squeeze(0).cpu().numpy()]
    for audio_path in audio_paths[1:]:
        clip_waveform, clip_sample_rate = load_audio(audio_path, target_sample_rate=sample_rate)
        if clip_sample_rate != sample_rate:
            raise RuntimeError("Unexpected sample rate mismatch while concatenating ayah clips")
        segments.append(clip_waveform.squeeze(0).cpu().numpy())
    return np.concatenate(segments, axis=0).astype(np.float32), sample_rate


def _backend_ws_url(base: str) -> str:
    normalized = base.rstrip("/")
    if normalized.startswith("https://"):
        normalized = "wss://" + normalized[len("https://") :]
    elif normalized.startswith("http://"):
        normalized = "ws://" + normalized[len("http://") :]
    return normalized + "/ws/recite"


async def _stream_smoke_session(
    *,
    ws_url: str,
    audio: np.ndarray,
    sample_rate: int,
    surah: int,
    ayah: int,
    chunk_ms: int,
    verify_tls: bool,
    summary_timeout_sec: float,
) -> dict[str, object]:
    websockets = require_dependency("websockets")
    pcm = np.clip(audio, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype(np.int16).tobytes()
    bytes_per_sample = 2
    chunk_size = max(1, int(sample_rate * (chunk_ms / 1000.0)) * bytes_per_sample)
    corrections: list[dict[str, object]] = []
    messages: list[dict[str, object]] = []
    ready: dict[str, object] | None = None
    summary: dict[str, object] | None = None

    ssl_context = None
    if ws_url.startswith("wss://") and not verify_tls:
        ssl_context = ssl._create_unverified_context()

    async with websockets.connect(
        ws_url,
        max_size=10_000_000,
        open_timeout=60,
        close_timeout=10,
        ssl=ssl_context,
    ) as websocket:
        await websocket.send(json.dumps({"type": "start", "surah": surah, "ayah": ayah}))
        ready = json.loads(await asyncio.wait_for(websocket.recv(), timeout=summary_timeout_sec))
        messages.append(ready)

        for offset in range(0, len(pcm), chunk_size):
            await websocket.send(pcm[offset : offset + chunk_size])
            while True:
                try:
                    message = json.loads(await asyncio.wait_for(websocket.recv(), timeout=0.05))
                except TimeoutError:
                    break
                messages.append(message)
                if message.get("type") == "correction":
                    corrections.append(message)

        await websocket.send(json.dumps({"type": "stop"}))
        while True:
            message = json.loads(await asyncio.wait_for(websocket.recv(), timeout=summary_timeout_sec))
            messages.append(message)
            if message.get("type") == "summary":
                summary = message
                break

    return {
        "ready": ready or {},
        "corrections": corrections,
        "summary": summary or {},
        "messages": messages,
    }


def _run_or_exit(callback, *args, **kwargs):
    try:
        return callback(*args, **kwargs)
    except MissingDependencyError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(code=2) from exc
    except Exception as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(code=1) from exc


@app.command("doctor")
def doctor() -> None:
    checker = _run_or_exit(load_checker)
    _echo_json(
        {
            "dependencies": dependency_report(),
            "config": load_config().as_dict(),
            "checker": checker.doctor_report(),
        }
    )


@app.command("setup-segmenter")
def setup_segmenter_command(
    cache_dir: Path | None = typer.Option(None, file_okay=False, dir_okay=True, writable=True),
) -> None:
    payload = _run_or_exit(download_segmenter_model, cache_dir)
    _echo_json(payload)


@app.command("segment-audio")
def segment_audio_command(
    audio_path: Path = typer.Argument(..., exists=True, file_okay=True, dir_okay=False),
    surah: int | None = typer.Option(None, min=1),
    ayah: int | None = typer.Option(None, min=1),
    chunk_length_s: float = typer.Option(15.0, min=1.0),
    stride_length_s: float = typer.Option(2.0, min=0.0),
    device: str = typer.Option(load_config().default_device),
) -> None:
    quran_data = load_quran_text()
    expected_words = quran_data.get(f"{surah}:{ayah}") if surah is not None and ayah is not None else None
    segmenter = _run_or_exit(load_segmenter, device)
    payload = _run_or_exit(
        segmenter.segment_audio,
        str(audio_path),
        transcript_words=expected_words,
        chunk_length_s=chunk_length_s,
        stride_length_s=stride_length_s,
    )
    _echo_json(payload)


@app.command("test-madd")
def test_madd_command(
    audio_path: Path = typer.Argument(..., exists=True, file_okay=True, dir_okay=False),
    reference_path: Path = typer.Argument(..., exists=True, file_okay=True, dir_okay=False),
) -> None:
    student_waveform, sample_rate = load_audio(audio_path)
    reference_waveform, _ = load_audio(reference_path, target_sample_rate=sample_rate)
    result = check_madd(
        student_waveform.squeeze(0).cpu().numpy(),
        reference_waveform.squeeze(0).cpu().numpy(),
        sr=sample_rate,
    )
    _echo_json(result)


@app.command("test-ghunnah")
def test_ghunnah_command(
    audio_path: Path = typer.Argument(..., exists=True, file_okay=True, dir_okay=False),
    reference_path: Path = typer.Argument(..., exists=True, file_okay=True, dir_okay=False),
) -> None:
    student_waveform, sample_rate = load_audio(audio_path)
    reference_waveform, _ = load_audio(reference_path, target_sample_rate=sample_rate)
    result = check_ghunnah(
        student_waveform.squeeze(0).cpu().numpy(),
        reference_waveform.squeeze(0).cpu().numpy(),
        sr=sample_rate,
    )
    _echo_json(result)


@app.command("check-rule")
def check_rule_command(
    audio_path: Path = typer.Option(..., exists=True, file_okay=True, dir_okay=False),
    rule_kind: RuleKind = typer.Option(..., "--rule"),
    letter: str | None = typer.Option(None),
    expected_letter: str | None = typer.Option(None),
    word_index: int = typer.Option(0, min=0),
    surah: int | None = typer.Option(None, min=1),
    ayah: int | None = typer.Option(None, min=1),
    start_sec: float | None = typer.Option(None),
    end_sec: float | None = typer.Option(None),
) -> None:
    checker = _run_or_exit(load_checker)
    result = _run_or_exit(
        checker.check_rule,
        str(audio_path),
        RuleAnnotation(
            rule=rule_kind,
            letter=letter,
            expected_letter=expected_letter,
        ),
        surah=surah,
        ayah=ayah,
        word_index=word_index,
        start_sec=start_sec,
        end_sec=end_sec,
    )
    _echo_json(result.model_dump())


@app.command("smoke-live-feedback")
def smoke_live_feedback_command(
    surah: int = typer.Option(1, min=1),
    ayah: int = typer.Option(1, min=1),
    audio_path: Path | None = typer.Option(None, exists=True, file_okay=True, dir_okay=False),
    word_limit: int | None = typer.Option(4, min=1),
    device: str = typer.Option(load_config().default_device),
) -> None:
    """
    Run the same live Muaalem rule-filtering path used by the websocket backend.

    If no audio path is provided, the command assembles the ayah from local Husary
    word clips in the manifest so it can be smoke-tested quickly.
    """
    quran_data = load_quran_text()
    words = quran_data.get(f"{surah}:{ayah}", [])
    if not words:
        raise typer.Exit(code=1)

    if audio_path is not None:
        waveform, sample_rate = load_audio(audio_path)
        audio = waveform.squeeze(0).cpu().numpy()
        selected_words = words[:word_limit] if word_limit is not None else words
        source = str(audio_path.resolve())
    else:
        selected_words, clip_paths = _load_manifest_clips(surah, ayah, word_limit)
        audio, sample_rate = _concat_audio(clip_paths)
        source = ", ".join(str(path) for path in clip_paths)

    checker = _run_or_exit(MuaalemChecker, device=device)
    errors = _collapse_word_level_errors(
        _run_or_exit(
            checker.check,
            audio,
            selected_words,
            sample_rate,
            surah=surah,
            ayah=ayah,
        )
    )
    flagged_words = sorted({error.word_index for error in errors})
    score = max(0, int((1 - len(flagged_words) / max(1, len(selected_words))) * 100))
    _echo_json(
        {
            "surah": surah,
            "ayah": ayah,
            "audio_source": source,
            "sample_rate": sample_rate,
            "duration_sec": round(len(audio) / sample_rate, 3),
            "words": selected_words,
            "score": score,
            "total_flagged_words": len(flagged_words),
            "errors": [
                {
                    "word_index": error.word_index,
                    "word_ar": selected_words[error.word_index] if error.word_index < len(selected_words) else "",
                    "error_type": error.error_type,
                    "rule": error.rule,
                    "severity": error.severity,
                    "description": error.description_en,
                    "expected": error.expected_phoneme,
                    "predicted": error.predicted_phoneme,
                }
                for error in errors
            ],
        }
    )


@app.command("smoke-websocket")
def smoke_websocket_command(
    backend_base: str = typer.Option("https://quran-ai-backend-ghq6pc5prq-uk.a.run.app"),
    surah: int = typer.Option(1, min=1),
    ayah: int = typer.Option(1, min=1),
    audio_path: Path | None = typer.Option(None, exists=True, file_okay=True, dir_okay=False),
    word_limit: int | None = typer.Option(4, min=1),
    chunk_ms: int = typer.Option(300, min=50),
    verify_tls: bool = typer.Option(False, "--verify-tls/--insecure"),
    timeout_sec: float = typer.Option(90.0, min=5.0),
) -> None:
    """
    Stream a real ayah to the deployed websocket backend and print the exact
    corrections/summary returned by the live service.
    """
    if audio_path is not None:
        waveform, sample_rate = load_audio(audio_path)
        audio = waveform.squeeze(0).cpu().numpy()
        words = load_quran_text().get(f"{surah}:{ayah}", [])
        selected_words = words[:word_limit] if word_limit is not None else words
        source = str(audio_path.resolve())
    else:
        selected_words, clip_paths = _load_manifest_clips(surah, ayah, word_limit)
        audio, sample_rate = _concat_audio(clip_paths)
        source = ", ".join(str(path) for path in clip_paths)

    payload = _run_or_exit(
        asyncio.run,
        _stream_smoke_session(
            ws_url=_backend_ws_url(backend_base),
            audio=audio,
            sample_rate=sample_rate,
            surah=surah,
            ayah=ayah,
            chunk_ms=chunk_ms,
            verify_tls=verify_tls,
            summary_timeout_sec=timeout_sec,
        ),
    )
    summary = payload.get("summary", {}) or {}
    _echo_json(
        {
            "backend": backend_base,
            "surah": surah,
            "ayah": ayah,
            "audio_source": source,
            "sample_rate": sample_rate,
            "duration_sec": round(len(audio) / sample_rate, 3),
            "words": selected_words,
            "total_messages": len(payload.get("messages", [])),
            "ready": payload.get("ready", {}),
            "corrections": payload.get("corrections", []),
            "summary": summary,
        }
    )


@app.command("serve")
def serve_command(
    host: str = typer.Option(load_config().server_host),
    port: int = typer.Option(load_config().server_port),
) -> None:
    import uvicorn

    uvicorn.run("server.main:app", host=host, port=port, reload=False)
