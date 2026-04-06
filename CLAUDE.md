# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

IoT Edge Node Simulator — a university project ("Organización del Computador") that demonstrates three I/O strategies (Polling, Interrupts, DMA) on a simulated edge device. The backend simulates hardware components in Python; the frontend is a real-time dashboard that visualizes CPU usage, latency, and throughput differences between strategies.

## Commands

### Backend (FastAPI + uvicorn)
```bash
cd backend
python -m venv venv && source venv/Scripts/activate  # Windows Git Bash
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### Frontend (Astro + React)
```bash
cd frontend
npm install
npm run dev      # dev server on http://localhost:4321
npm run build    # production build
npm run preview  # preview production build
```

Both must run simultaneously — the frontend polls `http://localhost:8000/metrics` every 1s.

## Architecture

### Backend (`backend/`)

Clean Architecture with Strategy pattern. All code is in `backend/app/`:

- **Domain** (`domain/entities/sensor_sample.py`): `SensorSample` dataclass — the core DTO flowing through the entire pipeline.
- **Infrastructure**:
  - `sensors/sensor_simulator.py` — async pub/sub sensor producing temperature (0.5s) or camera frames (50ms). Consumers subscribe via `subscribe(callback)`.
  - `buffer/ring_buffer.py` — generic thread-safe circular buffer with overwrite-oldest policy. Central data structure connecting producers to consumers.
  - `dma/dma_controller.py` — simulated DMA: collects samples into blocks via an `asyncio.Queue`, then batch-writes to RingBuffer and fires a single interrupt per block.
  - `persistence/cloud_repository.py` — SQLite repository at `data/edge_cloud.db` simulating cloud storage.
- **Application**:
  - `services/io_manager.py` — Strategy pattern hub. `IOManager` runs one `IOStrategy` at a time (`PollingStrategy`, `InterruptStrategy`, `DMAStrategy`), each defining how the CPU drains the RingBuffer. Hot-swappable via `set_strategy()`.
  - `services/cpu_simulator.py` — `CPU` class that models busy-wait (spin loops in polling) vs. cooperative yield (sleep in interrupt/DMA). The CPU usage difference measured by `psutil` is the key observable metric.
  - `metrics_collector.py` — rolling-window latency, CPU%, and SQLite throughput.

**Data flow**: Sensor → (subscribe) → RingBuffer (or DMA queue → RingBuffer) → IOManager strategy loop → CPU.process_sample → cloud_ingest (SQLite).

In `main.py`, `CPU.process_sample` is monkey-patched (`_wrapped_process_sample`) to also persist each processed sample to the simulated cloud endpoint.

### Frontend (`frontend/`)

Astro site with a single React island:

- `src/pages/index.astro` — shell page, loads `EdgeDashboard` via `client:load`.
- `src/components/EdgeDashboard.jsx` — the entire dashboard. Polls `/metrics` every 1s, keeps 30-point history, renders Recharts graphs (CPU area chart, latency line, throughput bar). Buttons POST to `/strategy` and `/sensor_profile` to switch I/O mode and sensor type at runtime.
- Styling: Tailwind CSS with custom terminal/neon theme in `src/styles/global.css`.

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/metrics` (alias `/metricas`) | CPU%, latency, throughput snapshot |
| GET/POST | `/strategy` | Get/set I/O strategy (polling/interrupt/dma) |
| GET/POST | `/sensor_profile` | Get/set active sensor (temperature/camera) |
| POST | `/cloud` | Ingest endpoint (called internally, not from frontend) |

## Key Design Decisions

- The project language is Spanish (variable names, comments, API field names like `latencia_ms`, `uso_cpu_porcentaje`). Keep this convention.
- The polling strategy intentionally burns CPU with spin loops (`busy_polling_step`) — this is by design to demonstrate the contrast with interrupt/DMA modes.
- `asyncio` is used throughout to model concurrency; it's cooperative, not true parallelism, but sufficient for the educational simulation.
- The `Optional` type in `ring_buffer.py` and `io_manager.py` comes from `typing` but is used without explicit import in some files (relies on `from __future__ import annotations`).
