from __future__ import annotations

import os
import time
from collections import deque

import psutil


class MetricsCollector:
    """
    Módulo de métricas en tiempo real (offline).

    - Latencia: media móvil de las últimas muestras (ms) sensor → endpoint.
    - CPU: porcentaje del proceso actual vía psutil.
    - Throughput: inserciones SQLite en ventana deslizante de 1 s.
    """

    def __init__(self, latency_window: int = 100) -> None:
        self._process = psutil.Process(os.getpid())
        self._latencies_ms: deque[float] = deque(maxlen=latency_window)
        self._insert_monotonic: deque[float] = deque()
        self._window_s = 1.0

    def prime_cpu_sample(self) -> None:
        """Primera lectura de psutil; conviene llamar al arrancar la app."""
        self._process.cpu_percent(interval=0.05)

    def record_latency_ms(self, ms: float) -> None:
        self._latencies_ms.append(ms)

    def record_sqlite_insert(self) -> None:
        self._insert_monotonic.append(time.monotonic())
        self._prune_inserts()

    def _prune_inserts(self) -> None:
        now = time.monotonic()
        while self._insert_monotonic and now - self._insert_monotonic[0] > self._window_s:
            self._insert_monotonic.popleft()

    def snapshot(self) -> dict[str, float]:
        self._prune_inserts()
        cpu = self._process.cpu_percent(interval=None)

        if self._latencies_ms:
            latencia_ms = sum(self._latencies_ms) / len(self._latencies_ms)
        else:
            latencia_ms = 0.0

        throughput = float(len(self._insert_monotonic))

        return {
            "latencia_ms": round(latencia_ms, 3),
            "uso_cpu_porcentaje": round(cpu, 2),
            "throughput_por_segundo": round(throughput, 2),
        }
