from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from typing import Any, Protocol

from app.application.services.cpu_simulator import CPUSimulator
from app.domain.entities.sensor_sample import SensorSample
from app.infrastructure.buffer.ring_buffer import RingBuffer


class CPUReaderLike(Protocol):
    """
    Contrato mínimo del “CPU” para este router: procesar una muestra ya extraída
    del buffer y reaccionar a modos (polling busy, interrupciones, etc.).
    En tu proyecto concreto suele ser CPUSimulator.
    """

    async def process_sample(self, sample: SensorSample, source: str) -> None: ...

    async def busy_polling_step(self) -> None: ...

    async def handle_interrupt(self) -> None: ...


class LogicalDMAEngineLike(Protocol):
    """
    Contrato del Módulo DMA lógico: tarea en background que llena el buffer;
    el IOManager solo necesita arrancar/detener ese ciclo al activar DMAStrategy.
    Así el Módulo 2 no depende de una implementación concreta en disco.
    """

    async def start(self) -> None: ...

    async def stop(self) -> None: ...


class IOStrategy(ABC):
    """
    Patrón Strategy: el algoritmo de lectura I/O (cómo el CPU “ve” el buffer)
    es intercambiable sin reescribir IOManager.

    Cada subclase define el bucle que drena RingBuffer.popleft() y decide si el
    CPU está en sondeo agresivo (polling), esperando eventos (interrupt) o
    coordinado con transferencias por bloques (DMA).
    """

    name: str

    @abstractmethod
    async def run(self, manager: "IOManager") -> None:
        """Ejecuta hasta que `manager.stop_event` indique parada cooperativa."""
        raise NotImplementedError


class PollingStrategy(IOStrategy):
    """
    Sondeo (polling): el CPU consulta el buffer de forma continua.

    Efecto en la interacción CPU–buffer:
    - No hay señal externa que despierte al CPU; el propio CPU ejecuta el bucle
      `popleft` en bucle. Si el buffer está vacío, igual se ejecuta trabajo de
      espera activa (`busy_polling_step`), lo que modela alto uso de CPU y
      posible cuello de botella: el núcleo no puede “dormir” esperando datos.
    """

    name = "polling"

    async def run(self, manager: "IOManager") -> None:
        while not manager.stop_event.is_set():
            sample = manager.ring_buffer.popleft()
            if sample is not None:
                await manager.cpu.process_sample(sample, source=self.name)
            else:
                await manager.cpu.busy_polling_step()


class InterruptStrategy(IOStrategy):
    """
    Interrupciones (simuladas): el CPU no inspecciona el buffer en ráfaga infinita.

    Efecto en la interacción CPU–buffer:
    - Entre lecturas, el CPU puede ceder (`asyncio.sleep`), modelando que hace
      otro trabajo o está en bajo consumo hasta que haya datos. Cuando
      `popleft` devuelve algo, se trata como “llegó un evento” y se notifica
      al CPU antes de procesar (`handle_interrupt`), como un manejador de IRQ.
    """

    name = "interrupt"

    async def run(self, manager: "IOManager") -> None:
        while not manager.stop_event.is_set():
            sample = manager.ring_buffer.popleft()
            if sample is None:
                await asyncio.sleep(manager.interrupt_idle_sleep_s)
                continue

            await manager.cpu.handle_interrupt()
            await manager.cpu.process_sample(sample, source=self.name)


class DMAStrategy(IOStrategy):
    """
    DMA (lógico): el llenado pesado del buffer lo hace otro componente en paralelo;
    el CPU aquí solo consume lo que ya quedó en el ring buffer.

    Efecto en la interacción CPU–buffer:
    - El CPU no está en el camino de cada byte/muestra desde el sensor; el
      motor DMA (cuando lo conectes) escribe al buffer. El CPU lee con el mismo
      `popleft`, pero entre lecturas duerme (`dma_idle_sleep_s`), simulando que
      el procesador principal está libre mientras el controlador transfiere.
    - `dma_engine.start/stop` representa habilitar/deshabilitar ese canal de fondo.
    """

    name = "dma"

    async def run(self, manager: "IOManager") -> None:
        if manager.dma_engine is None:
            raise RuntimeError(
                "DMAStrategy requiere `dma_engine` (LogicalDMAEngineLike) configurado."
            )

        await manager.dma_engine.start()
        try:
            while not manager.stop_event.is_set():
                sample = manager.ring_buffer.popleft()
                if sample is None:
                    await asyncio.sleep(manager.dma_idle_sleep_s)
                    continue
                await manager.cpu.process_sample(sample, source=self.name)
        finally:
            await manager.dma_engine.stop()


class IOManager:
    """
    Router I/O: selecciona la estrategia y orquesta la lectura del RingBuffer
    hacia el CPU simulado.

    Responsabilidad única: decidir *cómo* se obtienen datos del buffer según el
    modo (polling / interrupt / dma), sin implementar sensores ni el propio DMA.
    """

    def __init__(
        self,
        ring_buffer: RingBuffer[SensorSample],
        cpu: CPUReaderLike,
        dma_engine: Optional[LogicalDMAEngineLike] = None,
        interrupt_idle_sleep_s: float = 0.01,
        dma_idle_sleep_s: float = 0.01,
    ) -> None:
        self.ring_buffer = ring_buffer
        self.cpu = cpu
        self.dma_engine = dma_engine
        self.interrupt_idle_sleep_s = interrupt_idle_sleep_s
        self.dma_idle_sleep_s = dma_idle_sleep_s

        self.stop_event = asyncio.Event()
        self._task: Optional[asyncio.Task[Any]] = None
        self._strategy: IOStrategy = PollingStrategy()

    @property
    def mode(self) -> str:
        return self._strategy.name

    async def set_strategy(self, strategy: IOStrategy) -> None:
        """Cambio en caliente: detiene la tarea actual y arranca la nueva."""
        await self.stop()
        self._strategy = strategy
        await self.start()

    async def start(self) -> None:
        if self._task is not None:
            return
        self.stop_event.clear()
        self._task = asyncio.create_task(self._strategy.run(self), name=f"io-{self.mode}")

    async def stop(self) -> None:
        if self._task is None:
            return

        self.stop_event.set()
        await self._task
        self._task = None
