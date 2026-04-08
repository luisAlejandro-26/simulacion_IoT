from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from app.application.metrics_collector import MetricsCollector
from app.infrastructure.persistence.cloud_repository import CloudRepository

# --- IMPORT MODULES PARA SIMULADOR ---
from app.infrastructure.sensors.sensor_simulator import (
    SensorSimulator,
    SensorProfile,
    _make_temperature_factory,
    _make_camera_factory,
)
from app.infrastructure.buffer.ring_buffer import RingBuffer
from app.application.services.cpu_simulator import CPU
from app.infrastructure.dma.dma_controller import DMAController
from app.application.services.io_manager import IOManager, PollingStrategy, InterruptStrategy, DMAStrategy
from app.domain.entities.sensor_sample import SensorSample

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "data" / "edge_cloud.db"

_metrics = MetricsCollector()
_repo = CloudRepository(DB_PATH)

# --- INSTANCIAR COMPONENTES DEL SIMULADOR ---
_ring_buffer = RingBuffer[SensorSample](capacity=100)

"""
Registro de perfiles de sensor.

Para agregar un nuevo sensor:
1. Crear una función fábrica en sensor_simulator.py (devuelve SensorSample)
2. Registrar un SensorProfile aquí
3. Listo — el endpoint, la validación y el frontend se adaptan automáticamente.
"""
_sensor_sim = SensorSimulator()
_sensor_sim.register_profile(SensorProfile("temperature", period_s=5, factory=_make_temperature_factory()))
_sensor_sim.register_profile(SensorProfile("camera", period_s=10, factory=_make_camera_factory()))

_cpu = CPU(io_mode="polling")
_dma_controller = DMAController(ring_buffer=_ring_buffer, block_size=12, cpu=_cpu)
_io_manager = IOManager(ring_buffer=_ring_buffer, cpu=_cpu, dma_engine=_dma_controller)

"""
Registro de estrategias I/O.

Para agregar una nueva estrategia:
1. Crear la clase en io_manager.py (extender IOStrategy)
2. Agregar una entrada aquí con su configuración
3. Listo — el endpoint, la validación y el frontend se adaptan automáticamente.

Cada entrada define:
  - strategy_class: la clase IOStrategy a instanciar
  - cpu_mode: el modo que se configura en el CPU simulado
  - uses_dma: si requiere que el sensor pase por el DMAController
"""
STRATEGY_REGISTRY: dict[str, dict[str, Any]] = {
    "polling": {
        "strategy_class": PollingStrategy,
        "cpu_mode": "polling",
        "uses_dma": False,
    },
    "interrupt": {
        "strategy_class": InterruptStrategy,
        "cpu_mode": "interrupt",
        "uses_dma": False,
    },
    "dma": {
        "strategy_class": DMAStrategy,
        "cpu_mode": "dma",
        "uses_dma": True,
    },
}

_valid_strategies = list(STRATEGY_REGISTRY.keys())
_current_strategy: str = "polling"

class StrategyPayload(BaseModel):
    strategy: str

    def model_post_init(self, __context: Any) -> None:
        if self.strategy not in STRATEGY_REGISTRY:
            raise ValueError(
                f"Estrategia '{self.strategy}' no válida. "
                f"Opciones: {_valid_strategies}"
            )

class SensorProfilePayload(BaseModel):
    profile: str

    def model_post_init(self, __context: Any) -> None:
        if self.profile not in _sensor_sim.available_profiles:
            raise ValueError(
                f"Perfil '{self.profile}' no válido. "
                f"Opciones: {_sensor_sim.available_profiles}"
            )

class CloudPayload(BaseModel):
    """Cuerpo flexible: campos conocidos + datos procesados por el CPU."""
    model_config = ConfigDict(extra="allow")

    sample_id: Optional[str] = None
    sensor_type: Optional[str] = None
    created_at: Optional[str] = Field(
        default=None,
        description="ISO 8601 del sensor; sirve para calcular latencia hasta el POST",
    )
    payload: Optional[Dict[str, Any]] = None

def _parse_sensor_time(created_at: str) -> datetime:
    s = created_at.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)

def _latency_ms_from_payload(body: Dict[str, Any]) -> Optional[float]:
    raw = body.get("created_at")
    if not raw or not isinstance(raw, str):
        return None
    try:
        t_sensor = _parse_sensor_time(raw)
        if t_sensor.tzinfo is None:
            t_sensor = t_sensor.replace(tzinfo=timezone.utc)
        t_recv = datetime.now(timezone.utc)
        return (t_recv - t_sensor).total_seconds() * 1000.0
    except (ValueError, TypeError):
        return None

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Setup the metrics
    _metrics.prime_cpu_sample()
    
    # Startup simulador I/O
    await _sensor_sim.start()
    _sensor_sim.subscribe(_ring_buffer.append)
    await _io_manager.start()
    
    yield
    
    # Shutdown simulador
    await _io_manager.stop()
    await _sensor_sim.stop()

# --- INIT FASTAPI APP FIRST ---
app = FastAPI(
    title="Edge Cloud simulado (offline)",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/cloud")
async def cloud_ingest(payload: CloudPayload) -> dict[str, Any]:
    """
    Módulo 6 (cloud simulado): persiste localmente en SQLite (sin red externa).
    """
    body = payload.model_dump(mode="json")
    latency_ms = _latency_ms_from_payload(body)
    if latency_ms is not None:
        _metrics.record_latency_ms(latency_ms)

    try:
        _repo.save_payload(body, latency_ms)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    _metrics.record_sqlite_insert()

    return {
        "ok": True,
        "guardado": True,
        "latencia_ms": None if latency_ms is None else round(latency_ms, 3),
    }

# --- WRAP CPU PARA AUTO-ENVIAR A CLOUD ---
_original_process_sample = _cpu.process_sample

async def _wrapped_process_sample(sample: SensorSample, source: str) -> None:
    await _original_process_sample(sample, source)
    
    # Crear payload empaquetado para la nube simulada
    payload = CloudPayload(
        sample_id=sample.sample_id,
        sensor_type=sample.sensor_type,
        created_at=sample.created_at.isoformat(),
        payload=sample.payload
    )
    
    # Ejecutar guardado (como si fuera un POST al router de FastAPI sincrónicamente manejado en thread)
    await cloud_ingest(payload)

_cpu.process_sample = _wrapped_process_sample

def _metrics_with_irq() -> dict[str, float]:
    """Snapshot de métricas + contadores de IRQ del CPU simulado."""
    snap = _metrics.snapshot()
    stats = _cpu.stats
    snap["interrupts_received"] = stats.interrupts_received
    snap["dma_interrupts_received"] = stats.dma_interrupts_received
    return snap


@app.get("/metricas")
async def metricas() -> dict[str, float]:
    """Módulo 7: latencia media, CPU, throughput."""
    return _metrics_with_irq()


@app.get("/metrics")
async def metrics_alias() -> dict[str, float]:
    """Alias para dashboard."""
    return _metrics_with_irq()


@app.get("/strategies")
async def list_strategies() -> dict[str, Any]:
    """Lista todas las estrategias disponibles en el registro."""
    return {"strategies": _valid_strategies}


@app.get("/strategy")
async def get_strategy() -> dict[str, Any]:
    """Estado actual de la estrategia."""
    return {"strategy": _current_strategy, "available": _valid_strategies}


@app.post("/strategy")
async def set_strategy(body: StrategyPayload) -> dict[str, Any]:
    """
    Cambio de estrategia I/O dinámico.
    Saca al sensor del ruteo previo y reasigna los hilos según la estrategia moderna IoT elegida.
    """
    global _current_strategy
    _current_strategy = body.strategy
    entry = STRATEGY_REGISTRY[_current_strategy]

    # Limpieza de topología
    _dma_controller.detach_sensor()
    _sensor_sim.unsubscribe(_ring_buffer.append)

    # Re-topologizar según configuración del registro
    if entry["uses_dma"]:
        _dma_controller.attach_sensor(_sensor_sim)
    else:
        _sensor_sim.subscribe(_ring_buffer.append)

    _cpu.set_io_mode(entry["cpu_mode"])
    await _io_manager.set_strategy(entry["strategy_class"]())

    return {"ok": True, "strategy": _current_strategy}


@app.get("/sensor_profiles")
async def list_sensor_profiles() -> dict[str, Any]:
    """Lista todos los perfiles de sensor disponibles."""
    return {"profiles": _sensor_sim.available_profiles}


@app.get("/sensor_profile")
async def get_sensor_profile() -> dict[str, Any]:
    """Obtiene el perfil de sensor activo."""
    return {"profile": _sensor_sim.active_profile, "available": _sensor_sim.available_profiles}


@app.post("/sensor_profile")
async def set_sensor_profile(body: SensorProfilePayload) -> dict[str, Any]:
    """Cambia entre simular temperatura lenta o imágenes pesadas."""
    _sensor_sim.set_profile(body.profile)
    return {"ok": True, "profile": _sensor_sim.active_profile}
