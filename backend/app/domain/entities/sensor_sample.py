from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
import uuid


@dataclass
class SensorSample:
    """
    DTO de dominio para un dato generado por sensores edge.

    Este objeto desacopla el origen del dato (sensores) de su destino (buffer,
    CPU manager, persistencia, etc.), permitiendo que la arquitectura limpia
    transporte datos sin depender de FastAPI ni de detalles de infraestructura.
    """

    sensor_type: str
    payload: dict[str, Any]
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    sample_id: str = field(default_factory=lambda: str(uuid.uuid4()))

    def to_dict(self) -> dict[str, Any]:
        """Representación serializable para logging/API/almacenamiento."""
        return {
            "sample_id": self.sample_id,
            "sensor_type": self.sensor_type,
            "created_at": self.created_at.isoformat(),
            "payload": self.payload,
        }

