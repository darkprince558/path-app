"""Safe operational logging.

Only the whitelisted fields below are ever logged. There is deliberately no way
to pass images, prompts, keys, URLs, or provider text through this module.
"""

import json
import logging
from dataclasses import asdict, dataclass
from typing import Optional

logger = logging.getLogger("path_gemini")

EVENT_NAME = "landmark_generation"


@dataclass(frozen=True)
class TelemetryRecord:
    request_id: Optional[str]
    scan_revision_id: Optional[str]
    route_segment_id: Optional[str]
    approach_direction_id: Optional[str]
    frame_count: int
    model: str
    prompt_version: str
    elapsed_ms: int
    attempts: int
    retry_count: int
    result_category: str
    error_category: Optional[str] = None
    provider_status: Optional[int] = None
    candidate_count: Optional[int] = None

    def to_dict(self) -> dict:
        return asdict(self)


def emit(record: TelemetryRecord, log: Optional[logging.Logger] = None) -> None:
    target = log or logger
    fields = record.to_dict()
    level = logging.INFO if record.error_category is None else logging.WARNING
    target.log(
        level,
        "%s %s",
        EVENT_NAME,
        json.dumps(fields, sort_keys=True),
        extra={"path_gemini": fields},
    )
