from __future__ import annotations

from typing import Any

from agentscope.message import SystemMsg, UserMsg


async def summarize_session(params: dict[str, Any]) -> str:
    """Phase 3: compact prior turns into a short session summary via the configured model."""
    model_cfg = params.get("model") if isinstance(params.get("model"), dict) else {}
    previous = str(params.get("previousSummary") or "").strip()
    turns = params.get("turns") if isinstance(params.get("turns"), list) else []
    lines: list[str] = []
    if previous:
        lines.append(f"Previous summary:\n{previous}")
    for turn in turns[-40:]:
        if not isinstance(turn, dict):
            continue
        role = str(turn.get("role") or "user")
        content = str(turn.get("content") or "").strip()
        if content:
            lines.append(f"{role}: {content[:4000]}")
    if not lines:
        return previous

    from .models import build_model_and_formatter

    model, formatter = build_model_and_formatter(model_cfg)
    prompt = (
        "Summarize the following conversation for durable session memory. "
        "Keep facts, decisions, open questions, and file/tool outcomes. "
        "Use concise bullet points in the same language as the user.\n\n"
        + "\n".join(lines)
    )
    messages = await formatter.format(
        [
            SystemMsg(name="system", content="You write compact session memory summaries."),
            UserMsg(name="user", content=prompt),
        ],
    )
    response = await model(messages)
    if hasattr(response, "__aiter__"):
        last = None
        async for chunk in response:
            last = chunk
        response = last
    text = ""
    content = getattr(response, "content", None)
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text += str(block.get("text") or "")
            else:
                t = getattr(block, "text", None)
                if t:
                    text += str(t)
    elif isinstance(content, str):
        text = content
    return text.strip() or previous
