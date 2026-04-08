from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any, Optional

from app.domain.entities.sensor_sample import SensorSample
from app.infrastructure.buffer.ring_buffer import RingBuffer
from app.infrastructure.sensors.sensor_simulator import SensorSimulator

if TYPE_CHECKING:
    from app.application.services.cpu_simulator import CPU

DMAInterruptHandler = Callable[[int], Optional[Awaitable[None]]]


class DMAController:
    """
    Controlador DMA lógico (simulado en software).

    Modelo para la defensa:
    - En hardware real, el motor DMA transfiere bloques sensor↔memoria sin que el
      CPU ejecute una instrucción por palabra; el procesador sigue libre.
    - Aquí, una **tarea asyncio en background** hace el traslado de referencias
      hacia el RingBuffer. No invoca `CPU.process_sample` ni bucles de polling
      del Módulo 3: el “CPU simulado” solo recibe **una interrupción por bloque**
      al finalizar la transferencia (como IRQ de fin de DMA).

    Nota: `asyncio` es cooperativo; no es un hilo OS separado, pero cumple el
    rol pedido de proceso en segundo plano esquivando el trabajo del CPU en el
    sentido arquitectónico del proyecto (canal independiente del bucle de I/O).
    """

    def __init__(
        self,
        ring_buffer: RingBuffer[SensorSample],
        block_size: int = 12,
        flush_interval_s: float = 0.12,
        cpu: Optional[CPU] = None,
        on_block_complete: Optional[DMAInterruptHandler] = None,
    ) -> None:
        if block_size <= 0:
            raise ValueError("block_size must be > 0")

        self._ring_buffer = ring_buffer
        self._block_size = block_size
        self._flush_interval_s = flush_interval_s
        self._cpu = cpu
        self._on_block_complete = on_block_complete

        self._ingress: asyncio.Queue[SensorSample] = asyncio.Queue()
        self._stop_event = asyncio.Event()
        self._task: Optional[asyncio.Task[Any]] = None
        self._sensor: Optional[SensorSimulator] = None
        self._consumer_ref: Optional[Callable[[SensorSample], None]] = None

    def attach_sensor(self, sensor: SensorSimulator) -> None:
        """
        Conecta Sensores → cola del DMA (no al buffer directamente).

        En modo DMA, la aplicación no debe suscribir el mismo sensor al buffer
        en paralelo, o duplicaría muestras.
        """
        if self._sensor is not None:
            raise RuntimeError("DMAController: sensor ya conectado")

        self._sensor = sensor

        def _enqueue(sample: SensorSample) -> None:
            self._ingress.put_nowait(sample)

        self._consumer_ref = _enqueue
        sensor.subscribe(self._consumer_ref)

    def detach_sensor(self) -> None:
        """Desconecta el sensor (p. ej. al salir de DMAStrategy)."""
        if self._sensor is None or self._consumer_ref is None:
            return
        self._sensor.unsubscribe(self._consumer_ref)
        self._sensor = None
        self._consumer_ref = None

    async def start(self) -> None:
        """Habilita el canal DMA (tarea de transferencia en background)."""
        if self._task is not None:
            return
        self._stop_event.clear()
        self._task = asyncio.create_task(self._dma_transfer_loop(), name="dma-controller")

    async def stop(self) -> None:
        """Detiene el canal DMA y espera a que termine la tarea."""
        if self._task is None:
            return
        self._stop_event.set()
        await self._task
        self._task = None

    async def _dma_transfer_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                first = await asyncio.wait_for(
                    self._ingress.get(),
                    timeout=self._flush_interval_s,
                )
            except asyncio.TimeoutError:
                continue

            block: list[SensorSample] = [first]
            while len(block) < self._block_size:
                try:
                    # Esperamos obligatoriamente hasta el _flush_interval_s por la siguiente muestra
                    nxt = await asyncio.wait_for(
                        self._ingress.get(),
                        timeout=self._flush_interval_s
                    )
                    block.append(nxt)
                except asyncio.TimeoutError:
                    break

            # Transferencia “por hardware”: el CPU principal no mueve el bloque.
            self._ring_buffer.extend(block)

            await self._emit_block_interrupt(len(block))

    async def _emit_block_interrupt(self, transferred: int) -> None:
        """
        Una sola señal por bloque (IRQ de fin de DMA), no por muestra.
        """
        if self._on_block_complete is not None:
            result = self._on_block_complete(transferred)
            if asyncio.iscoroutine(result):
                await result
            return

        if self._cpu is not None:
            await self._cpu.handle_dma_interrupt(transferred)
