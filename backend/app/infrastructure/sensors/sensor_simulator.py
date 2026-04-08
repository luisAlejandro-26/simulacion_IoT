from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable
from typing import Any, Optional

from app.domain.entities.sensor_sample import SensorSample

SampleConsumer = Callable[[SensorSample], Optional[Awaitable[None]]]
SampleFactory = Callable[[], SensorSample]


class SensorProfile:
    """
    Define un tipo de sensor: su nombre, período de muestreo y
    una función fábrica que genera cada muestra.

    Para agregar un nuevo sensor:
    1. Crear una instancia de SensorProfile con su fábrica
    2. Registrarlo con SensorSimulator.register_profile()
    3. Listo — el endpoint y el frontend se adaptan automáticamente.
    """

    def __init__(
        self,
        name: str,
        period_s: float,
        factory: SampleFactory,
    ) -> None:
        self.name = name
        self.period_s = period_s
        self.factory = factory


def _make_temperature_factory() -> SampleFactory:
    """Fábrica con estado para sensor de temperatura."""
    state = {"current_temp": 24.0}

    def factory() -> SensorSample:
        state["current_temp"] += random.uniform(-0.2, 0.2)
        return SensorSample(
            sensor_type="temperature",
            payload={
                "unit": "C",
                "value": round(state["current_temp"], 2),
            },
        )

    return factory


def _make_camera_factory() -> SampleFactory:
    """Fábrica con estado para sensor de imagen/stream."""
    state = {"frame_seq": 0}

    def factory() -> SensorSample:
        state["frame_seq"] += 1
        return SensorSample(
            sensor_type="image",
            payload={
                "frame_seq": state["frame_seq"],
                "bytes": random.randint(40_000, 300_000),
                "format": "jpeg-simulated",
            },
        )

    return factory


class SensorSimulator:
    """
    Módulo de Sensores (simulado) para la plataforma Edge I/O.

    Diseño basado en registro: cada perfil de sensor se registra como un
    SensorProfile y se ejecuta como tarea asíncrona independiente.
    Solo el perfil activo publica muestras; los demás duermen.
    """

    def __init__(self) -> None:
        self._profiles: dict[str, SensorProfile] = {}
        self._active_profile: str = ""
        self._consumers: list[SampleConsumer] = []
        self._stop_event = asyncio.Event()
        self._tasks: list[asyncio.Task[Any]] = []

    def register_profile(self, profile: SensorProfile) -> None:
        """Registra un perfil de sensor en el simulador."""
        self._profiles[profile.name] = profile
        if not self._active_profile:
            self._active_profile = profile.name

    @property
    def available_profiles(self) -> list[str]:
        return list(self._profiles.keys())

    @property
    def active_profile(self) -> str:
        return self._active_profile

    def set_profile(self, profile: str) -> None:
        if profile in self._profiles:
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
        """Arranca una tarea asíncrona por cada perfil registrado."""
        if self._tasks:
            return

        self._stop_event.clear()
        self._tasks = [
            asyncio.create_task(
                self._sensor_loop(profile),
                name=f"{name}-sensor",
            )
            for name, profile in self._profiles.items()
        ]

    async def stop(self) -> None:
        """Detiene de forma cooperativa las tareas asíncronas."""
        if not self._tasks:
            return

        self._stop_event.set()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

    async def _sensor_loop(self, profile: SensorProfile) -> None:
        """Bucle genérico: genera muestras solo cuando es el perfil activo."""
        while not self._stop_event.is_set():
            if self._active_profile != profile.name:
                await asyncio.sleep(profile.period_s)
                continue

            sample = profile.factory()
            await self._publish(sample)
            await asyncio.sleep(profile.period_s)

    async def _publish(self, sample: SensorSample) -> None:
        """
        Entrega la muestra a todos los consumidores.

        Soporta consumidores sync y async para facilitar integración incremental.
        """
        for consumer in self._consumers:
            result = consumer(sample)
            if asyncio.iscoroutine(result):
                await result
