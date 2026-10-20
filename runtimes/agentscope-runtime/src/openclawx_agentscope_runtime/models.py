from __future__ import annotations

from typing import Any

from agentscope.credential import DashScopeCredential, OllamaCredential, OpenAICredential
from agentscope.formatter import (
    DashScopeChatFormatter,
    OllamaChatFormatter,
    OpenAIChatFormatter,
)
from agentscope.model import (
    ChatModelBase,
    DashScopeChatModel,
    OllamaChatModel,
    OpenAIChatModel,
)


def _base_url(model: dict[str, Any]) -> str | None:
    raw = model.get("baseUrl")
    return str(raw).rstrip("/") if raw else None


def build_model_and_formatter(model: dict[str, Any]) -> tuple[ChatModelBase, Any]:
    """Map OpenClawX ModelConfig → AgentScope 2.x model (formatter is attached on model)."""
    provider = str(model.get("provider") or "openai-compatible")
    chat_model = str(model.get("chatModel") or "gpt-4o-mini")
    api_key = str(model.get("apiKey") or "EMPTY")
    base = _base_url(model)
    stream = True

    if provider in {"qwen", "dashscope"} or (base and "dashscope" in (base or "")):
        cred = DashScopeCredential(api_key=api_key, **({"base_url": base} if base else {}))
        formatter = DashScopeChatFormatter()
        return (
            DashScopeChatModel(credential=cred, model=chat_model, stream=stream, formatter=formatter),
            formatter,
        )

    if provider == "ollama":
        cred = OllamaCredential(**({"host": base} if base else {}))
        formatter = OllamaChatFormatter()
        return (
            OllamaChatModel(credential=cred, model=chat_model, stream=stream, formatter=formatter),
            formatter,
        )

    cred = OpenAICredential(api_key=api_key or "EMPTY", **({"base_url": base} if base else {}))
    formatter = OpenAIChatFormatter()
    return (
        OpenAIChatModel(credential=cred, model=chat_model, stream=stream, formatter=formatter),
        formatter,
    )
