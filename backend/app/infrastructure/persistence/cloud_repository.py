from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class CloudRepository:
    """Persistencia local offline (SQLite) para el módulo Cloud simulado."""

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _init_schema(self) -> None:
        with sqlite3.connect(self._db_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS cloud_records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    received_at TEXT NOT NULL,
                    sample_id TEXT,
                    sensor_type TEXT,
                    latency_ms REAL,
                    body_json TEXT NOT NULL
                )
                """
            )
            conn.commit()

    def save_payload(self, body: dict[str, Any], latency_ms: Optional[float]) -> None:
        received_at = datetime.now(timezone.utc).isoformat()
        sample_id = body.get("sample_id")
        sensor_type = body.get("sensor_type")
        body_json = json.dumps(body, ensure_ascii=False)

        with sqlite3.connect(self._db_path) as conn:
            conn.execute(
                """
                INSERT INTO cloud_records
                    (received_at, sample_id, sensor_type, latency_ms, body_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (received_at, sample_id, sensor_type, latency_ms, body_json),
            )
            conn.commit()
