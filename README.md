# QURAN-AI

Standalone Qur'an recitation coaching app with:

- `Muaalem` phoneme-aware tajweed checking
- DSP checks for `madd`, `ghunnah`, and `qalqalah`
- FastAPI + WebSocket backend for streaming recitation feedback
- React frontend for bilingual Arabic/English guided practice
- Railway-ready frontend deployment files
- Cloud Run oriented backend container setup

The old classifier training pipeline is no longer the active runtime. Small track files and previous experiments are preserved under [Legacy Training](./Legacy%20Training).

## Active architecture

- [server/main.py](./server/main.py): FastAPI + WebSocket server
- [server/muaalem_checker.py](./server/muaalem_checker.py): pre-trained Muaalem inference and phoneme comparison
- [src/tajweed_ml/checker.py](./src/tajweed_ml/checker.py): app-facing rule checker
- [src/tajweed_ml/sifaat_checker.py](./src/tajweed_ml/sifaat_checker.py): DSP checks for madd, ghunnah, and qalqalah
- [frontend](./frontend): Vite/React bilingual recitation UI

## Local backend setup

```bash
pip install -r requirements.txt
python ml/setup.py
git clone https://github.com/obadx/quran-muaalem.git ml/vendor/quran-muaalem
git clone https://github.com/obadx/quran-transcript.git ml/vendor/quran-transcript
```

The segmenter model is large and may be better hosted on Cloud Run or downloaded into cloud storage instead of a constrained local disk.

## Run locally

Backend:

```bash
python -m uvicorn server.main:app --reload --host 0.0.0.0 --port 8000
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

## Railway frontend

Deploy the [frontend](./frontend) directory to Railway. Set:

```bash
VITE_API_BASE=https://your-cloud-run-backend.run.app
VITE_WS_BASE=wss://your-cloud-run-backend.run.app
```

The Railway-specific files are already included:

- [frontend/railway.toml](./frontend/railway.toml)
- [frontend/nixpacks.toml](./frontend/nixpacks.toml)
- [frontend/.env.example](./frontend/.env.example)

## Cloud Run backend

The backend container is defined in [Dockerfile](./Dockerfile). It is intended for Cloud Run deployment, ideally with:

- `Cloud Run` for the API/WebSocket service
- `NVIDIA L4` GPU for lower-latency inference
- model downloads baked into the image or mounted from cloud storage

## CLI

```bash
python -m cli doctor
python -m cli test-madd audio/example.wav audio/reference.wav
python -m cli test-ghunnah audio/example.wav audio/reference.wav
python -m cli serve
```
