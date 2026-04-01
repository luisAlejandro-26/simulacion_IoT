from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable
from typing import Any, Optional

from app.domain.entities.sensor_sample import SensorSample

SampleConsumer = Callable[[SensorSample], Optional[Awaitable[None]]]


class SensorSimulator:
    """
    Módulo de Sensores (simulado) para la plataforma Edge I/O.

    Diseño:
    - Ejecuta dos tareas asíncronas concurrentes (equivalente a "hilos livianos"):
      1) Temperatura: baja frecuencia (1 dato cada 500 ms).
      2) Imagen/stream: alta frecuencia (ráfagas cada 50 ms).
    - Publica cada muestra en consumidores registrados (patrón pub/sub simple).

    Notas de arquitectura:
    - Este módulo solo produce datos. No decide estrategia de I/O ni persistencia.
    - Eso mantiene separación limpia entre "fuente de datos" y "orquestación".
    """

    def __init__(
        self,
        temperature_period_s: float = 0.5,
        image_period_s: float = 0.05,
    ) -> None:
        self._temperature_period_s = temperature_period_s
        self._image_period_s = image_period_s
        self._active_profile: str = "temperature"
        self._consumers: list[SampleConsumer] = []
        self._stop_event = asyncio.Event()
        self._tasks: list[asyncio.Task[Any]] = []

    @property
    def active_profile(self) -> str:
        return self._active_profile

    def set_profile(self, profile: str) -> None:
        if profile in ("temperature", "camera"):
            self._active_profile = profile

    def subscribe(self, consumer: SampleConsumer) -> None:
        """Registra un consumidor (ej: RingBuffer.append)."""
        self._consumers.append(consumer)

    def unsubscribe(self, consumer: SampleConsumer) -> None:
        """Quita un consumidor (misma referencia que en subscribe)."""
        try:
            self._consumers.remove(consumer)
        except ValueError:
            pass

    async def start(self) -> None:
        """
        Arranca la simulación de sensores.

        Debe llamarse una vez durante el startup del backend.
        """
        if self._tasks:
            return

        self._stop_event.clear()
        self._tasks = [
            asyncio.create_task(self._temperature_loop(), name="temperature-sensor"),
            asyncio.create_task(self._image_stream_loop(), name="image-sensor"),
        ]

    async def stop(self) -> None:
        """
        Detiene de forma cooperativa las tareas asíncronas.
        """
        if not self._tasks:
            return

        self._stop_event.set()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

    async def _temperature_loop(self) -> None:
        """
        Sensor de temperatura:
        - baja frecuencia
        - variación pequeña para parecer señal real.
        """
        current_temp = 24.0
        while not self._stop_event.is_set():
            if self._active_profile != "temperature":
                await asyncio.sleep(self._temperature_period_s)
                continue
                
            # Ruido gaussiano leve para simular fluctuación térmica.
            current_temp += random.uniform(-0.2, 0.2)
            sample = SensorSample(
                sensor_type="temperature",
                payload={
                    "unit": "C",
                    "value": round(current_temp, 2),
                },
            )
            await self._publish(sample)
            await asyncio.sleep(self._temperature_period_s)

    async def _image_stream_loop(self) -> None:
        """
        Sensor de imagen/stream:
        - alta frecuencia (cada 50 ms por defecto)
        - modela frames con tamaño variable para simular carga irregular.
        """
        frame_seq = 0
        while not self._stop_event.is_set():
            if self._active_profile != "camera":
                await asyncio.sleep(self._image_period_s)
                continue
                
            frame_seq += 1
            sample = SensorSample(
                sensor_type="image",
                payload={
                    "frame_seq": frame_seq,
                    "bytes": random.randint(40_000, 300_000),
                    "format": "jpeg-simulated",
                },
            )
            await self._publish(sample)
            await asyncio.sleep(self._image_period_s)

    async def _publish(self, sample: SensorSample) -> None:
        """
        Entrega la muestra a todos los consumidores.

        Soporta consumidores sync y async para facilitar integración incremental.
        """
        for consumer in self._consumers:
            result = consumer(sample)
            if asyncio.iscoroutine(result):
                await result

