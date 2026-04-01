from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from threading import Lock
from typing import Generic, TypeVar

T = TypeVar("T")


@dataclass
class RingBufferStats:
    """
    Métricas internas del buffer circular.

    - `total_writes`: total de escrituras realizadas.
    - `overwritten_items`: cuántos datos se perdieron por backpressure.
    """

    total_writes: int = 0
    overwritten_items: int = 0


class RingBuffer(Generic[T]):
    """
    Buffer circular estricto con política overwrite-oldest.

    Comportamiento clave para la defensa:
    - Complejidad O(1) en escritura/lectura de cabeza.
    - Capacidad fija (memoria acotada).
    - Cuando se llena, no bloquea: sobreescribe el dato más antiguo.
      Esto modela pérdida de paquetes por backpressure.
    - Thread-safe por lock, para soportar productor/consumidor concurrentes.
    """

    def __init__(self, capacity: int) -> None:
        if capacity <= 0:
            raise ValueError("RingBuffer capacity must be > 0")

        self._capacity = capacity
        self._data: list[Optional[T]] = [None] * capacity
        self._head = 0  # siguiente posición de lectura
        self._tail = 0  # siguiente posición de escritura
        self._size = 0
        self._lock = Lock()
        self._stats = RingBufferStats()

    @property
    def capacity(self) -> int:
        return self._capacity

    @property
    def size(self) -> int:
        with self._lock:
            return self._size

    @property
    def stats(self) -> RingBufferStats:
        with self._lock:
            return RingBufferStats(
                total_writes=self._stats.total_writes,
                overwritten_items=self._stats.overwritten_items,
            )

    def append(self, item: T) -> None:
        """
        Inserta un elemento.

        Si hay espacio: crece el buffer.
        Si está lleno: avanza head (descarta el más antiguo) y escribe.
        """
        with self._lock:
            self._stats.total_writes += 1

            if self._size == self._capacity:
                # Buffer lleno => se pierde el elemento más viejo.
                self._head = (self._head + 1) % self._capacity
                self._stats.overwritten_items += 1
            else:
                self._size += 1

            self._data[self._tail] = item
            self._tail = (self._tail + 1) % self._capacity

    def popleft(self) -> Optional[T]:
        """
        Extrae el elemento más antiguo (FIFO). Retorna None si está vacío.
        """
        with self._lock:
            if self._size == 0:
                return None

            value = self._data[self._head]
            self._data[self._head] = None
            self._head = (self._head + 1) % self._capacity
            self._size -= 1
            return value

    def snapshot(self) -> list[T]:
        """
        Copia ordenada (oldest -> newest) para métricas/debug/dashboard.
        """
        with self._lock:
            items: list[T] = []
            for i in range(self._size):
                idx = (self._head + i) % self._capacity
                value = self._data[idx]
                if value is not None:
                    items.append(value)
            return items

    def extend(self, items: Iterable[T]) -> None:
        for item in items:
            self.append(item)

