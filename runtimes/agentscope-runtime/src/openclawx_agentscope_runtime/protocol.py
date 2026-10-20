from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any


PROTOCOL_VERSION = "1"
RUNTIME_VERSION = "0.1.0"


@dataclass
class RunState:
    run_id: str
    seq: int = 0
    status: str = "running"  # running | waiting-approval | completed | failed | cancelled
    abort: bool = False
    reply_id: str | None = None
    pending_confirm: dict[str, Any] | None = None
    params: dict[str, Any] = field(default_factory=dict)
    task: Any | None = None


@dataclass
class Session:
    token_ok: bool
    active: dict[str, RunState] = field(default_factory=dict)
    started_at: float = field(default_factory=time.monotonic)


def jsonrpc_result(req_id: Any, result: Any) -> str:
    return json.dumps({"jsonrpc": "2.0", "id": req_id, "result": result}, ensure_ascii=False)


def jsonrpc_error(req_id: Any, code: int, message: str, data: Any = None) -> str:
    err: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return json.dumps({"jsonrpc": "2.0", "id": req_id, "error": err}, ensure_ascii=False)


def jsonrpc_notify(method: str, params: Any) -> str:
    return json.dumps({"jsonrpc": "2.0", "method": method, "params": params}, ensure_ascii=False)


def next_seq(run: RunState) -> int:
    run.seq += 1
    return run.seq


def make_event(run_id: str, event_type: str, **fields: Any) -> dict[str, Any]:
    payload = {"type": event_type, "runId": run_id}
    payload.update(fields)
    return payload
