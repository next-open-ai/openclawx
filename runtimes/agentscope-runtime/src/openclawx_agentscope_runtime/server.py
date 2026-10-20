from __future__ import annotations

import asyncio
import json
import sys
import time
import uuid
from typing import Any
from urllib.parse import parse_qs, urlparse

import websockets
from websockets.server import WebSocketServerProtocol

from . import PROTOCOL_VERSION, __version__
from .memory import summarize_session
from .protocol import (
    RUNTIME_VERSION,
    RunState,
    Session,
    jsonrpc_error,
    jsonrpc_notify,
    jsonrpc_result,
    make_event,
    next_seq,
)
from .react_runner import run_agentscope_react


async def _send(ws: WebSocketServerProtocol, payload: str) -> None:
    await ws.send(payload)


class HostBridge:
    """JSON-RPC client role on the server socket: ask the TS host to run tools."""

    def __init__(self, ws: WebSocketServerProtocol) -> None:
        self.ws = ws
        self._pending: dict[str, asyncio.Future[Any]] = {}
        self._next = 1

    def resolve_response(self, message: dict[str, Any]) -> bool:
        req_id = message.get("id")
        if req_id is None:
            return False
        key = str(req_id)
        fut = self._pending.get(key)
        if fut is None:
            return False
        self._pending.pop(key, None)
        if message.get("error"):
            err = message["error"]
            fut.set_exception(RuntimeError(err.get("message") if isinstance(err, dict) else str(err)))
        else:
            fut.set_result(message.get("result"))
        return True

    async def invoke(self, method: str, params: dict[str, Any], timeout: float = 120.0) -> Any:
        req_id = f"host-{self._next}"
        self._next += 1
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[Any] = loop.create_future()
        self._pending[req_id] = fut
        await _send(
            self.ws,
            json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}, ensure_ascii=False),
        )
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        finally:
            self._pending.pop(req_id, None)


async def _emit_event(ws: WebSocketServerProtocol, run: RunState, event: dict[str, Any]) -> None:
    seq = next_seq(run)
    await _send(
        ws,
        jsonrpc_notify(
            "agent.event",
            {"runId": run.run_id, "seq": seq, "event": event},
        ),
    )


async def _finish(ws: WebSocketServerProtocol, session: Session, run: RunState, status: str, message: str | None = None) -> None:
    run.status = status
    params: dict[str, Any] = {"runId": run.run_id, "status": status}
    if message:
        params["message"] = message
    await _send(ws, jsonrpc_notify("agent.run.finished", params))
    if status != "waiting-approval":
        session.active.pop(run.run_id, None)


async def _stub_echo_run(ws: WebSocketServerProtocol, session: Session, run: RunState, params: dict[str, Any]) -> None:
    await _emit_event(ws, run, make_event(run.run_id, "run.started"))
    messages = params.get("messages") or []
    last_user = ""
    for msg in messages:
        if isinstance(msg, dict) and msg.get("role") == "user":
            content = msg.get("content")
            if isinstance(content, str):
                last_user = content
    text = last_user.strip() or "(empty)"
    preview = f"[openclawx-agentscope stub] {text}"
    for i in range(0, len(preview), 24):
        if run.abort:
            await _emit_event(
                ws,
                run,
                make_event(run.run_id, "run.cancelled", reason="user", message="Aborted by client."),
            )
            await _finish(ws, session, run, "cancelled", "Aborted by client.")
            return
        await _emit_event(ws, run, make_event(run.run_id, "message.delta", text=preview[i : i + 24]))
        await asyncio.sleep(0.01)
    await _emit_event(ws, run, make_event(run.run_id, "run.completed"))
    await _finish(ws, session, run, "completed")


def _want_real_engine(params: dict[str, Any]) -> bool:
    if params.get("forceStub"):
        return False
    model = params.get("model") if isinstance(params.get("model"), dict) else {}
    if not model.get("chatModel"):
        return False
    provider = str(model.get("provider") or "")
    api_key = str(model.get("apiKey") or "").strip()
    if provider == "ollama":
        return True
    # Ignore placeholder keys used by protocol smoke tests.
    if not api_key or api_key in {"x", "EMPTY", "test", "sk-test"}:
        return False
    return True


async def _start_run(
    ws: WebSocketServerProtocol,
    session: Session,
    bridge: HostBridge,
    run: RunState,
    params: dict[str, Any],
    resume_payload: dict[str, Any] | None = None,
) -> None:
    async def emit(event: dict[str, Any]) -> None:
        await _emit_event(ws, run, event)

    async def finish(status: str, message: str | None = None) -> None:
        await _finish(ws, session, run, status, message)

    async def host_invoke(_run_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        result = await bridge.invoke("host.tool.invoke", payload)
        return result if isinstance(result, dict) else {"executionResults": []}

    if not _want_real_engine(params) and resume_payload is None:
        await _stub_echo_run(ws, session, run, params)
        return

    await run_agentscope_react(
        run=run,
        params=params,
        emit=emit,
        finish=finish,
        host_invoke=host_invoke,
        resume_payload=resume_payload,
    )


async def handle_rpc(
    ws: WebSocketServerProtocol,
    session: Session,
    bridge: HostBridge,
    message: dict[str, Any],
) -> None:
    # Responses to host.* requests initiated by the runtime.
    if bridge.resolve_response(message):
        return

    req_id = message.get("id")
    method = message.get("method")
    params = message.get("params") if isinstance(message.get("params"), dict) else {}

    if not isinstance(method, str):
        if req_id is not None:
            await _send(ws, jsonrpc_error(req_id, -32600, "Invalid Request"))
        return

    if req_id is None:
        return

    if method == "runtime.hello":
        await _send(
            ws,
            jsonrpc_result(
                req_id,
                {
                    "runtimeVersion": RUNTIME_VERSION,
                    "protocolVersion": PROTOCOL_VERSION,
                    "packageVersion": __version__,
                    "engine": "agentscope",
                    "capabilities": [
                        "stub.echo",
                        "runtime.health",
                        "agent.run",
                        "tools.host",
                        "tools.mcp",
                        "skills.catalog",
                        "memory.session",
                    ],
                },
            ),
        )
        return

    if method == "runtime.health":
        await _send(
            ws,
            jsonrpc_result(
                req_id,
                {
                    "ok": True,
                    "uptimeMs": int((time.monotonic() - session.started_at) * 1000),
                    "activeRuns": len(session.active),
                },
            ),
        )
        return

    if method == "agent.memory.summarize":
        try:
            summary = await summarize_session(params)
            await _send(ws, jsonrpc_result(req_id, {"summary": summary}))
        except Exception as exc:  # noqa: BLE001
            await _send(ws, jsonrpc_error(req_id, -32020, f"memory.summarize failed: {exc}"))
        return

    if method == "agent.run.start":
        run_id = str(params.get("runId") or uuid.uuid4().hex)
        if run_id in session.active:
            await _send(ws, jsonrpc_error(req_id, -32001, "run already active", {"runId": run_id}))
            return
        run = RunState(run_id=run_id, params=params)
        session.active[run_id] = run
        await _send(ws, jsonrpc_result(req_id, {"runId": run_id, "accepted": True}))
        run.task = asyncio.create_task(_start_run(ws, session, bridge, run, params))
        return

    if method == "agent.run.abort":
        run_id = str(params.get("runId") or "")
        run = session.active.get(run_id)
        if not run:
            await _send(ws, jsonrpc_error(req_id, -32002, "run not found", {"runId": run_id}))
            return
        run.abort = True
        await _send(ws, jsonrpc_result(req_id, {"runId": run_id, "aborted": True}))
        return

    if method == "agent.run.resume":
        run_id = str(params.get("runId") or "")
        run = session.active.get(run_id)
        if not run or run.status != "waiting-approval":
            await _send(ws, jsonrpc_error(req_id, -32002, "run not waiting for approval", {"runId": run_id}))
            return
        grants = params.get("grants") if isinstance(params.get("grants"), list) else []
        confirmed = bool(params.get("confirmed", True))
        pending = run.pending_confirm or {}
        tool_calls = pending.get("toolCalls") or []
        from agentscope.event import ConfirmResult
        from agentscope.message import ToolCallBlock

        confirm_results = []
        for call in tool_calls:
            if not isinstance(call, dict):
                continue
            confirm_results.append(
                ConfirmResult(
                    confirmed=confirmed,
                    tool_call=ToolCallBlock(
                        id=str(call.get("id") or ""),
                        name=str(call.get("name") or "tool"),
                        input=json.dumps(call.get("input") or {}, ensure_ascii=False),
                    ),
                ),
            )
        run.status = "running"
        run.abort = False
        resume_payload = {
            "kind": "confirm",
            "replyId": pending.get("replyId") or run.reply_id,
            "confirmResults": confirm_results,
            "grants": grants,
        }
        await _send(ws, jsonrpc_result(req_id, {"runId": run_id, "accepted": True}))
        run.task = asyncio.create_task(
            _start_run(ws, session, bridge, run, run.params, resume_payload=resume_payload),
        )
        return

    await _send(ws, jsonrpc_error(req_id, -32601, f"Method not found: {method}"))


def _request_path(ws: WebSocketServerProtocol) -> str:
    request = getattr(ws, "request", None)
    if request is not None and getattr(request, "path", None):
        return str(request.path)
    path = getattr(ws, "path", None)
    return str(path or "/")


async def handler(ws: WebSocketServerProtocol, expected_token: str, expected_path: str) -> None:
    parsed = urlparse(_request_path(ws))
    if parsed.path.rstrip("/") != expected_path.rstrip("/"):
        await ws.close(1008, "invalid path")
        return
    query = parse_qs(parsed.query)
    token = (query.get("token") or [""])[0]
    if expected_token and token != expected_token:
        await ws.close(1008, "unauthorized")
        return

    session = Session(token_ok=True)
    bridge = HostBridge(ws)
    try:
        async for raw in ws:
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", errors="replace")
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await _send(ws, jsonrpc_error(None, -32700, "Parse error"))
                continue
            if not isinstance(message, dict):
                await _send(ws, jsonrpc_error(None, -32600, "Invalid Request"))
                continue
            await handle_rpc(ws, session, bridge, message)
    finally:
        for run in list(session.active.values()):
            run.abort = True
        session.active.clear()


async def serve(*, host: str, port: int, token: str, path: str) -> None:
    async def _process(ws: WebSocketServerProtocol) -> None:
        await handler(ws, token, path)

    async with websockets.serve(_process, host, port) as server:
        socks = getattr(server, "sockets", None) or []
        bound_port = socks[0].getsockname()[1] if socks else port
        print(f"OPENCLAWX_AGENTSCOPE_PORT={bound_port}", flush=True)
        # Mirror to stderr so supervisors that only tee stderr still observe the port
        # (and as a fallback when stdout buffering differs across platforms).
        print(f"OPENCLAWX_AGENTSCOPE_PORT={bound_port}", file=sys.stderr, flush=True)
        print(
            f"openclawx-agentscope-runtime listening ws://{host}:{bound_port}{path}",
            file=sys.stderr,
            flush=True,
        )
        await asyncio.Future()
