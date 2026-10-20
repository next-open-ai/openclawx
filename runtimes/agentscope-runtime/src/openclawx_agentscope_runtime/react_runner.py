from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, TypeVar

from agentscope.agent import Agent, ReActConfig
from agentscope.event import (
    ExternalExecutionResultEvent,
    ModelCallEndEvent,
    ReplyEndEvent,
    ReplyStartEvent,
    RequireExternalExecutionEvent,
    RequireUserConfirmEvent,
    TextBlockDeltaEvent,
    ToolCallStartEvent,
    ToolResultEndEvent,
    UserConfirmResultEvent,
)
from agentscope.message import (
    AssistantMsg,
    ToolCallBlock,
    ToolResultBlock,
    ToolResultState,
    UserMsg,
)

from .host_tools import HostExternalTool, build_host_toolkit
from .models import build_model_and_formatter
from .protocol import RunState, make_event, next_seq

HostInvokeFn = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]
EmitFn = Callable[[dict[str, Any]], Awaitable[None]]
FinishFn = Callable[[str, str | None], Awaitable[None]]
T = TypeVar("T")

# VPN / network flaps often leave the provider HTTP stream half-open: no more
# chunks arrive, but the socket also does not fail immediately. Cap silence
# between model/tool stream events so the run can settle instead of hanging.
DEFAULT_STREAM_IDLE_SECONDS = 120.0
NETWORK_STALL_MESSAGE = (
    "网络连接超时或中断了，这次没能完成回答。请检查网络后重试；若正在使用 VPN，也可先切换网络再试。"
)


def _stream_idle_seconds(params: dict[str, Any]) -> float:
    raw = params.get("streamIdleMs")
    if isinstance(raw, (int, float)) and raw > 0:
        return max(30.0, min(300.0, float(raw) / 1000.0))
    run_timeout_ms = params.get("runTimeoutMs")
    if isinstance(run_timeout_ms, (int, float)) and run_timeout_ms > 0:
        # Keep idle well below the whole-run timeout, but never under 60s so
        # slow MCP tools (30–50s) do not false-trigger.
        return max(60.0, min(180.0, float(run_timeout_ms) / 1000.0 / 4.0))
    return DEFAULT_STREAM_IDLE_SECONDS


def _friendly_stream_error(exc: BaseException) -> str:
    text = str(exc) or exc.__class__.__name__
    lowered = text.lower()
    if isinstance(exc, asyncio.TimeoutError) or "stream idle" in lowered:
        return NETWORK_STALL_MESSAGE
    if any(
        token in lowered
        for token in (
            "connection error",
            "failed to fetch",
            "fetch failed",
            "terminated",
            "connection reset",
            "econnreset",
            "econnrefused",
            "enotfound",
            "broken pipe",
            "network",
            "ssl",
            "tls",
            "timed out",
            "timeout",
            "temporarily unavailable",
            "remote end closed",
            "socket hang up",
        )
    ):
        return NETWORK_STALL_MESSAGE
    return text


async def _aiter_with_idle(
    source: AsyncIterator[T],
    *,
    idle_seconds: float,
    is_aborted: Callable[[], bool],
) -> AsyncIterator[T]:
    iterator = source.__aiter__()
    while True:
        if is_aborted():
            return
        try:
            event = await asyncio.wait_for(iterator.__anext__(), timeout=idle_seconds)
        except StopAsyncIteration:
            return
        except asyncio.TimeoutError as exc:
            raise TimeoutError(f"stream idle for {int(idle_seconds)}s") from exc
        yield event


def _messages_from_params(params: dict[str, Any]) -> list[Any]:
    out: list[Any] = []
    for raw in params.get("messages") or []:
        if not isinstance(raw, dict):
            continue
        role = str(raw.get("role") or "user")
        content = str(raw.get("content") or "")
        if not content:
            continue
        if role == "assistant":
            out.append(AssistantMsg(name="assistant", content=content))
        else:
            out.append(UserMsg(name="user", content=content))
    return out


def _system_prompt(params: dict[str, Any]) -> str:
    profile = params.get("profile") if isinstance(params.get("profile"), dict) else {}
    name = str(profile.get("name") or "Assistant")
    instructions = str(profile.get("instructions") or "You are a helpful assistant.")
    memory = str(params.get("sessionSummary") or "").strip()
    parts = [
        f"You are {name} inside OpenClawX (AgentScope engine).",
        instructions,
        "Use host read/write/edit/bash tools for workspace work. After a finished user-facing file is verified, call commit_artifact exactly once; only committed files enter the asset library. Be concise and actionable.",
    ]
    if memory:
        parts.append(f"<session-memory>\n{memory}\n</session-memory>")
    skills = params.get("skills") if isinstance(params.get("skills"), list) else []
    if skills:
        lines = ["Authorized skills (use skill viewer / follow instructions when relevant):"]
        for skill in skills[:24]:
            if not isinstance(skill, dict):
                continue
            lines.append(f"- {skill.get('name')}: {str(skill.get('description') or '')[:200]}")
        parts.append("\n".join(lines))
    mcp_instructions = str(params.get("mcpInstructions") or "").strip()
    if mcp_instructions:
        parts.append(mcp_instructions[:12_000])
    return "\n\n".join(parts)


def _tool_call_to_dict(block: ToolCallBlock) -> dict[str, Any]:
    raw_input: Any = block.input
    if isinstance(raw_input, str):
        try:
            parsed = json.loads(raw_input)
            raw_input = parsed if isinstance(parsed, dict) else {"value": parsed}
        except json.JSONDecodeError:
            raw_input = {"value": raw_input}
    elif hasattr(raw_input, "model_dump"):
        raw_input = raw_input.model_dump()
    elif not isinstance(raw_input, dict):
        raw_input = {"value": raw_input}
    return {
        "id": block.id,
        "name": block.name,
        "input": raw_input,
    }


async def run_agentscope_react(
    *,
    run: RunState,
    params: dict[str, Any],
    emit: EmitFn,
    finish: FinishFn,
    host_invoke: HostInvokeFn,
    resume_payload: dict[str, Any] | None = None,
) -> None:
    """Drive AgentScope Agent.reply_stream and map events → OpenClawX AgentEvent."""
    model_cfg = params.get("model") if isinstance(params.get("model"), dict) else {}
    if not model_cfg.get("chatModel"):
        await emit(make_event(run.run_id, "run.failed", message="Missing model.chatModel for AgentScope run."))
        await finish("failed", "Missing model.chatModel")
        return

    model, _formatter = build_model_and_formatter(model_cfg)
    toolkit = build_host_toolkit(
        params.get("skills") if isinstance(params.get("skills"), list) else [],
        params.get("mcpTools") if isinstance(params.get("mcpTools"), list) else [],
        str(params.get("workspaceRoot") or "."),
        str(params.get("workspaceAccess") or "write"),
    )
    max_iters = int(params.get("maxSteps") or 16)
    agent = Agent(
        name=str((params.get("profile") or {}).get("name") or "OpenClawX"),
        system_prompt=_system_prompt(params),
        model=model,
        toolkit=toolkit,
        react_config=ReActConfig(max_iters=max_iters),
    )

    await emit(make_event(run.run_id, "run.started"))

    if resume_payload and resume_payload.get("kind") == "confirm":
        inputs: Any = UserConfirmResultEvent(
            reply_id=str(resume_payload.get("replyId") or run.reply_id or ""),
            confirm_results=resume_payload.get("confirmResults") or [],
        )
    elif resume_payload and resume_payload.get("kind") == "external":
        inputs = ExternalExecutionResultEvent(
            reply_id=str(resume_payload.get("replyId") or run.reply_id or ""),
            execution_results=resume_payload.get("executionResults") or [],
        )
    else:
        history = _messages_from_params(params)
        if not history:
            await emit(make_event(run.run_id, "run.failed", message="No user messages."))
            await finish("failed", "No user messages")
            return
        inputs = history if len(history) > 1 else history[0]

    step_index = 0
    idle_seconds = _stream_idle_seconds(params)
    try:
        while True:
            if run.abort:
                await emit(
                    make_event(run.run_id, "run.cancelled", reason="user", message="Aborted by client."),
                )
                await finish("cancelled", "Aborted by client.")
                return

            pending_external: RequireExternalExecutionEvent | None = None
            pending_confirm: RequireUserConfirmEvent | None = None

            async for event in _aiter_with_idle(
                agent.reply_stream(inputs),
                idle_seconds=idle_seconds,
                is_aborted=lambda: run.abort,
            ):
                if run.abort:
                    await emit(
                        make_event(run.run_id, "run.cancelled", reason="user", message="Aborted by client."),
                    )
                    await finish("cancelled", "Aborted by client.")
                    return

                if isinstance(event, ReplyStartEvent):
                    run.reply_id = event.reply_id
                    continue

                if isinstance(event, TextBlockDeltaEvent):
                    delta = event.delta or ""
                    if delta:
                        # AS text deltas are incremental in 2.x TextBlockDeltaEvent
                        await emit(make_event(run.run_id, "message.delta", text=delta))
                    continue

                if isinstance(event, ToolCallStartEvent):
                    await emit(
                        make_event(
                            run.run_id,
                            "tool.started",
                            toolName=event.tool_call_name,
                            summary=f"Calling {event.tool_call_name}",
                        ),
                    )
                    continue

                if isinstance(event, ToolResultEndEvent):
                    state_val = getattr(event.state, "value", str(event.state))
                    ok = state_val == "success"
                    if ok:
                        await emit(
                            make_event(
                                run.run_id,
                                "tool.completed",
                                toolName=str(event.tool_call_id),
                                summary=f"Tool finished ({state_val})",
                                ok=True,
                            ),
                        )
                    else:
                        await emit(
                            make_event(
                                run.run_id,
                                "tool.failed",
                                toolName=str(event.tool_call_id),
                                summary=f"Tool finished ({state_val})",
                            ),
                        )
                    continue

                if isinstance(event, ModelCallEndEvent):
                    usage = {
                        "inputTokens": int(event.input_tokens or 0),
                        "outputTokens": int(event.output_tokens or 0),
                        "totalTokens": int((event.input_tokens or 0) + (event.output_tokens or 0)),
                    }
                    if event.cache_input_tokens:
                        usage["cacheReadTokens"] = int(event.cache_input_tokens)
                    await emit(
                        make_event(
                            run.run_id,
                            "run.usage",
                            usage=usage,
                            stepIndex=step_index,
                            model={
                                "provider": str(model_cfg.get("provider") or "openai-compatible"),
                                "chatModel": str(model_cfg.get("chatModel") or ""),
                            },
                        ),
                    )
                    step_index += 1
                    continue

                if isinstance(event, RequireExternalExecutionEvent):
                    pending_external = event
                    break

                if isinstance(event, RequireUserConfirmEvent):
                    pending_confirm = event
                    break

                if isinstance(event, ReplyEndEvent):
                    reason = getattr(event.finished_reason, "value", str(event.finished_reason))
                    if event.error:
                        msg = getattr(event.error, "message", None) or str(event.error)
                        friendly = _friendly_stream_error(Exception(str(msg)))
                        await emit(make_event(run.run_id, "run.failed", message=friendly))
                        await finish("failed", friendly)
                        return
                    if reason in {"cancelled", "interrupted"}:
                        await emit(
                            make_event(run.run_id, "run.cancelled", reason="user", message="Interrupted."),
                        )
                        await finish("cancelled", "Interrupted.")
                        return
                    await emit(make_event(run.run_id, "run.completed"))
                    await finish("completed")
                    return

            if pending_confirm is not None:
                run.reply_id = pending_confirm.reply_id
                run.status = "waiting-approval"
                first = pending_confirm.tool_calls[0] if pending_confirm.tool_calls else None
                skill_id = "agentscope-host"
                capability = "workspace-write"
                summary = "AgentScope requires confirmation before continuing."
                if first is not None:
                    summary = f"Confirm tool `{first.name}`"
                    if first.name in {"write_workspace_file", "run_workspace_script"}:
                        capability = "workspace-write" if first.name.startswith("write") else "script-execution"
                    elif first.name.startswith("mcp_"):
                        capability = "network-access"
                        summary = f"Confirm MCP tool `{first.name}`"
                    else:
                        tool = next((item for item in getattr(toolkit, "tools", []) if getattr(item, "name", "") == first.name), None)
                        if isinstance(tool, HostExternalTool) and tool.capability:
                            capability = tool.capability
                await emit(
                    make_event(
                        run.run_id,
                        "tool.approval_required",
                        skillId=skill_id,
                        capability=capability,
                        summary=summary,
                    ),
                )
                run.pending_confirm = {
                    "replyId": pending_confirm.reply_id,
                    "toolCalls": [_tool_call_to_dict(b) for b in pending_confirm.tool_calls],
                }
                await finish("waiting-approval", summary)
                return

            if pending_external is not None:
                run.reply_id = pending_external.reply_id
                tool_calls = [_tool_call_to_dict(b) for b in pending_external.tool_calls]
                for call in tool_calls:
                    await emit(
                        make_event(
                            run.run_id,
                            "tool.started",
                            toolName=str(call["name"]),
                            summary=f"Host invoke {call['name']}",
                        ),
                    )
                result = await host_invoke(
                    run.run_id,
                    {
                        "runId": run.run_id,
                        "replyId": pending_external.reply_id,
                        "toolCalls": tool_calls,
                    },
                )
                execution_results_raw = result.get("executionResults") if isinstance(result, dict) else None
                blocks: list[ToolResultBlock] = []
                if isinstance(execution_results_raw, list):
                    for item in execution_results_raw:
                        if not isinstance(item, dict):
                            continue
                        output = item.get("output", "")
                        if isinstance(output, str):
                            out: Any = output
                        else:
                            out = json.dumps(output, ensure_ascii=False)
                        state_name = str(item.get("state") or "success")
                        try:
                            state = ToolResultState(state_name)
                        except Exception:
                            state = ToolResultState.SUCCESS if state_name not in {"error", "failed"} else ToolResultState.ERROR
                        blocks.append(
                            ToolResultBlock(
                                id=str(item.get("id") or ""),
                                name=str(item.get("name") or "tool"),
                                output=out,
                                state=state,
                            ),
                        )
                        ok = state == ToolResultState.SUCCESS
                        tool_name = str(item.get("name") or "tool")
                        summary = str(item.get("summary") or state_name)
                        if ok:
                            await emit(
                                make_event(
                                    run.run_id,
                                    "tool.completed",
                                    toolName=tool_name,
                                    summary=summary,
                                    ok=True,
                                ),
                            )
                        else:
                            await emit(
                                make_event(
                                    run.run_id,
                                    "tool.failed",
                                    toolName=tool_name,
                                    summary=summary,
                                ),
                            )
                        if item.get("artifactPath"):
                            await emit(
                                make_event(run.run_id, "artifact.created", path=str(item["artifactPath"])),
                            )
                inputs = ExternalExecutionResultEvent(
                    reply_id=pending_external.reply_id,
                    execution_results=blocks,
                )
                continue

            # Stream ended without ReplyEnd — treat as completed.
            await emit(make_event(run.run_id, "run.completed"))
            await finish("completed")
            return
    except Exception as exc:  # noqa: BLE001
        friendly = _friendly_stream_error(exc)
        await emit(make_event(run.run_id, "run.failed", message=friendly))
        await finish("failed", friendly)
