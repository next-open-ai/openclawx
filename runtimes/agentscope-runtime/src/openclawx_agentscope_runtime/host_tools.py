from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any

from agentscope.permission import PermissionBehavior, PermissionDecision
from agentscope.permission._context import PermissionContext
from agentscope.skill import Skill
from agentscope.message import TextBlock, ToolResultState
from agentscope.tool import ToolBase, ToolChunk, Toolkit


_BLOCKED_COMMAND = re.compile(r"(^|\s)(rm\s+-[a-z]*[rf][a-z]*\b|mkfs\b|diskutil\s+erase|shutdown\b|reboot\b|killall\b|curl\b|wget\b|nc\b|ssh\b)(\s|$)", re.I)


class HostExternalTool(ToolBase):
    """Tool executed by the TypeScript host via JSON-RPC `host.tool.invoke`."""

    is_external_tool = True
    is_concurrency_safe = True

    def __init__(
        self,
        *,
        name: str,
        description: str,
        input_schema: dict[str, Any],
        is_read_only: bool = True,
        permission: PermissionBehavior = PermissionBehavior.ALLOW,
        capability: str | None = None,
    ) -> None:
        super().__init__()
        self.name = name
        self.description = description
        self.input_schema = input_schema
        self.is_read_only = is_read_only
        self._permission = permission
        self.capability = capability

    async def check_permissions(
        self,
        tool_input: dict[str, Any],
        context: PermissionContext,
    ) -> PermissionDecision:
        return PermissionDecision(
            behavior=self._permission,
            message=f"Host tool `{self.name}` permission check.",
        )


class WorkspaceNativeTool(ToolBase):
    """AgentScope-native filesystem / bash tool, rooted in one run workspace."""

    is_external_tool = False
    is_concurrency_safe = False

    def __init__(self, *, name: str, description: str, input_schema: dict[str, Any], workspace_root: str, workspace_access: str, is_read_only: bool) -> None:
        super().__init__()
        self.name = name
        self.description = description
        self.input_schema = input_schema
        self.workspace_root = Path(workspace_root).resolve()
        self.workspace_access = workspace_access
        self.is_read_only = is_read_only

    def _path(self, value: Any) -> Path:
        raw = str(value or "")
        candidate = (self.workspace_root / raw).resolve()
        if candidate == self.workspace_root or self.workspace_root not in candidate.parents:
            raise ValueError("Path is outside the authorized workspace.")
        return candidate

    async def check_permissions(self, tool_input: dict[str, Any], context: PermissionContext) -> PermissionDecision:
        if not self.is_read_only and self.workspace_access == "read":
            return PermissionDecision(behavior=PermissionBehavior.DENY, message="Workspace write is not permitted for this run.")
        return PermissionDecision(behavior=PermissionBehavior.ALLOW, message=f"OpenClawX workspace policy allows `{self.name}`.")

    async def call(self, **kwargs: Any) -> ToolChunk:
        try:
            if self.name == "read":
                target = self._path(kwargs.get("path"))
                text = await asyncio.to_thread(target.read_text, "utf-8")
                offset = max(0, int(kwargs.get("offset") or 0))
                limit = max(1, min(48_000, int(kwargs.get("limit") or 12_000)))
                output = text[offset:offset + limit]
            elif self.name == "write":
                target = self._path(kwargs.get("path"))
                content = str(kwargs.get("content") or "")
                await asyncio.to_thread(target.parent.mkdir, parents=True, exist_ok=True)
                await asyncio.to_thread(target.write_text, content, "utf-8")
                output = json.dumps({"ok": True, "path": str(target.relative_to(self.workspace_root)), "bytes": len(content.encode("utf-8"))})
            elif self.name == "edit":
                target = self._path(kwargs.get("path"))
                old = str(kwargs.get("oldText") or "")
                new = str(kwargs.get("newText") or "")
                text = await asyncio.to_thread(target.read_text, "utf-8")
                if not old or text.count(old) != 1:
                    raise ValueError("edit requires oldText to occur exactly once.")
                await asyncio.to_thread(target.write_text, text.replace(old, new, 1), "utf-8")
                output = json.dumps({"ok": True, "path": str(target.relative_to(self.workspace_root))})
            elif self.name == "bash":
                command = str(kwargs.get("command") or "")
                if not command or _BLOCKED_COMMAND.search(command):
                    raise ValueError("Command is blocked by the workspace policy.")
                timeout = max(1, min(60, int(kwargs.get("timeout") or 30)))
                process = await asyncio.create_subprocess_shell(command, cwd=str(self.workspace_root), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                try:
                    stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
                except TimeoutError:
                    process.kill()
                    await process.communicate()
                    raise ValueError("Command timed out.")
                output = json.dumps({"ok": process.returncode == 0, "exitCode": process.returncode, "stdout": stdout.decode("utf-8", "replace")[-32_000:], "stderr": stderr.decode("utf-8", "replace")[-8_000:]})
            else:
                raise ValueError(f"Unsupported native tool: {self.name}")
            return ToolChunk(content=[TextBlock(text=output)], state=ToolResultState.SUCCESS)
        except Exception as error:
            return ToolChunk(content=[TextBlock(text=json.dumps({"ok": False, "error": str(error)}))], state=ToolResultState.ERROR)


def _append_mcp_tools(tools: list[ToolBase], mcp_tools: list[dict[str, Any]] | None) -> None:
    for raw in mcp_tools or []:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()
        description = str(raw.get("description") or "").strip()
        input_schema = raw.get("inputSchema") if isinstance(raw.get("inputSchema"), dict) else {"type": "object"}
        capability = str(raw.get("capability") or "").strip() or None
        if not name or not description:
            continue
        tools.append(
            HostExternalTool(
                name=name,
                description=description[:500],
                input_schema=input_schema,
                is_read_only=False,
                permission=PermissionBehavior.ASK if capability == "network-access" else PermissionBehavior.ALLOW,
                capability=capability,
            ),
        )


def build_host_toolkit(
    skills: list[dict[str, Any]] | None = None,
    mcp_tools: list[dict[str, Any]] | None = None,
    workspace_root: str | None = None,
    workspace_access: str = "write",
) -> Toolkit:
    skill_objs: list[Skill] = []
    for raw in skills or []:
        name = str(raw.get("name") or raw.get("id") or "").strip()
        description = str(raw.get("description") or "").strip()
        if not name or not description:
            continue
        markdown = str(raw.get("instructions") or f"# {name}\n\n{description}\n")
        directory = str(raw.get("rootPath") or f"/virtual/skills/{raw.get('id') or name}")
        skill_objs.append(
            Skill(
                name=name,
                description=description[:500],
                dir=directory,
                markdown=markdown[:24_000],
                updated_at=0.0,
            ),
        )

    root = workspace_root or "."
    tools = [
        HostExternalTool(
            name="host_ping",
            description="Health/echo tool executed by the OpenClawX host. Use to verify host tool bridge.",
            input_schema={
                "type": "object",
                "properties": {"message": {"type": "string", "description": "Optional message to echo"}},
                "additionalProperties": False,
            },
            is_read_only=True,
            permission=PermissionBehavior.ALLOW,
        ),
        WorkspaceNativeTool(
            name="read",
            description="Read a file from the current run workspace.",
            input_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path inside the run workspace"},
                    "offset": {"type": "number"},
                    "limit": {"type": "number"},
                },
                "required": ["path"],
                "additionalProperties": False,
            },
            is_read_only=True,
            workspace_root=root,
            workspace_access=workspace_access,
        ),
        WorkspaceNativeTool(
            name="write",
            description="Write/replace a UTF-8 file in the current run workspace.",
            input_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
                "additionalProperties": False,
            },
            is_read_only=False,
            workspace_root=root,
            workspace_access=workspace_access,
        ),
        WorkspaceNativeTool(
            name="edit",
            description="Replace an exact text fragment in a workspace file.",
            input_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "oldText": {"type": "string"},
                    "newText": {"type": "string"},
                },
                "required": ["path", "oldText", "newText"],
                "additionalProperties": False,
            },
            is_read_only=False,
            workspace_root=root,
            workspace_access=workspace_access,
        ),
        WorkspaceNativeTool(
            name="bash",
            description="Run a safe local build command inside the workspace.",
            input_schema={
                "type": "object",
                "properties": {"command": {"type": "string"}, "timeout": {"type": "number"}},
                "required": ["command"],
                "additionalProperties": False,
            },
            is_read_only=False,
            workspace_root=root,
            workspace_access=workspace_access,
        ),
        HostExternalTool(
            name="commit_artifact",
            description="Verify and atomically publish a finished user-facing file. Only committed files appear in the asset library.",
            input_schema={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
                "additionalProperties": False,
            },
            is_read_only=False,
            permission=PermissionBehavior.ASK,
        ),
        HostExternalTool(
            name="preview_server_start",
            description=(
                "Start a static website server (ports from 8000). "
                "access=local (default): 127.0.0.1 this-machine preview. "
                "access=lan: 本地部署 / LAN multi-device — bind 0.0.0.0; returns url/lanUrls/localUrl. "
                "Prefer this over bash http.server; do not rebuild for preview/deploy."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "root": {"type": "string"},
                    "access": {"type": "string", "enum": ["local", "lan"]},
                    "portHint": {"type": "number"},
                },
                "additionalProperties": False,
            },
            is_read_only=False,
            permission=PermissionBehavior.ALLOW,
        ),
        HostExternalTool(
            name="preview_server_stop",
            description=(
                "Stop local website preview / 本地部署 / LAN deploy. "
                "Use for 关闭本地部署、关闭预览、关闭本地网站. "
                "Pass id or port; omit both to stop all current site servers."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "port": {"type": "number"},
                },
                "additionalProperties": False,
            },
            is_read_only=False,
            permission=PermissionBehavior.ALLOW,
        ),
        HostExternalTool(
            name="preview_server_status",
            description="List running preview / LAN deploy / local website servers (url, access, port, root).",
            input_schema={
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
            is_read_only=True,
            permission=PermissionBehavior.ALLOW,
        ),
    ]
    _append_mcp_tools(tools, mcp_tools)
    return Toolkit(tools=tools, skills_or_loaders=skill_objs if skill_objs else None)
