from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Literal

from app.domain.entities.sensor_sample import SensorSample

IOMode = Literal["polling", "interrupt", "dma"]


@dataclass
class CPUStats:
    """Contadores básicos de actividad del CPU simulado."""

    processed_samples: int = 0
    polling_busy_iterations: int = 0
    interrupts_received: int = 0
    dma_interrupts_received: int = 0


class CPU:
    """
    Simula el procesador central que procesa muestras ya extraídas del buffer.

    La diferencia clave entre modos (para defender ante el jurado):

    - **Polling:** el software no puede “bloquearse” esperando datos: el CPU
      ejecuta bucles ajustados (busy-wait) que consumen ciclos aunque no haya
      trabajo útil. El SO ve el proceso activo casi todo el tiempo → uso de CPU
      alto y riesgo de cuello de botella.

    - **Interrupciones / DMA:** el CPU no está en un sondeo continuo; entre
      eventos cede el control con `asyncio.sleep`, que en la práctica modela
      “halt/wait for IRQ” o ejecutar otras tareas: el hilo no gasta ciclos en
      comprobar el buffer vacío, por eso el uso de CPU cae de forma notable
      (en medición con psutil verás la diferencia).
    """

    def __init__(
        self,
        io_mode: IOMode = "polling",
        polling_spin_work: int = 25_000,
        polling_outer_rounds: int = 8,
        cooperative_yield_every: int = 150,
    ) -> None:
        self._io_mode: IOMode = io_mode
        self._polling_spin_work = polling_spin_work
        self._polling_outer_rounds = polling_outer_rounds
        self._cooperative_yield_every = cooperative_yield_every
        self._stats = CPUStats()
        self._loop_counter = 0

    @property
    def io_mode(self) -> IOMode:
        return self._io_mode

    def set_io_mode(self, mode: IOMode) -> None:
        """Debe alinearse con la estrategia activa del IOManager (Módulo 2)."""
        self._io_mode = mode

    @property
    def stats(self) -> CPUStats:
        return CPUStats(
            processed_samples=self._stats.processed_samples,
            polling_busy_iterations=self._stats.polling_busy_iterations,
            interrupts_received=self._stats.interrupts_received,
            dma_interrupts_received=self._stats.dma_interrupts_received,
        )

    async def process_sample(self, sample: SensorSample, source: str) -> None:
        """
        Trabajo útil sobre una muestra (decodificar, validar, etc.).

        En polling el coste por muestra se mantiene alto (micro-bucle).
        En interrupt/dma se modela procesamiento breve y ceder, coherente con
        un CPU que no está quemando el 100 % solo en espera activa.
        """
        _ = sample.sample_id, sample.sensor_type, source
        self._stats.processed_samples += 1

        if self._io_mode == "polling":
            acc = 0
            for i in range(8_000):
                acc ^= (i * 17) & 0xFF
            _ = acc
            await asyncio.sleep(0)
        else:
            await asyncio.sleep(0)

    async def handle_interrupt(self) -> None:
        self._stats.interrupts_received += 1
        if self._io_mode in ("interrupt", "dma"):
            await asyncio.sleep(0)
        else:
            await asyncio.sleep(0)

    async def handle_dma_interrupt(self, transferred_block_size: int) -> None:
        _ = transferred_block_size
        self._stats.dma_interrupts_received += 1
        await asyncio.sleep(0)

    async def busy_polling_step(self) -> None:
        """
        Camino del **polling**: buffer vacío → el CPU no duerme; repite trabajo
        pesado como si hiciera `while True: revisar dispositivo / buffer`.

        No leemos el RingBuffer aquí (eso es el IOManager); lo que simulamos es
        el costo de CPU de **volver a intentar** una y otra vez sin bloqueo.
        """
        if self._io_mode != "polling":
            await asyncio.sleep(0)
            return

        outer = 0
        while outer < self._polling_outer_rounds:
            accumulator = 0
            for i in range(self._polling_spin_work):
                accumulator ^= (i * 31) & 0xFF
            _ = accumulator
            outer += 1

        self._stats.polling_busy_iterations += 1
        self._loop_counter += 1

        if self._loop_counter % self._cooperative_yield_every == 0:
            await asyncio.sleep(0)

    async def wait_idle(self, duration_s: float) -> None:
        """
        Espera cuando **no** hay datos: en interrupt/DMA el CPU debe estar
        “libre” (bajo uso), no en busy-wait.

        Úsalo desde el IOManager en lugar de `asyncio.sleep` directo si quieres
        centralizar el comportamiento en el Módulo 3.
        """
        if self._io_mode == "polling":
            await self.busy_polling_step()
        else:
            await asyncio.sleep(duration_s)


CPUSimulator = CPU
