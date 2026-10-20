import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, ChatRequest, McpConnectionRuntime } from '@openclawx/contracts';
import { DshJsonRpcClient } from './jsonrpc-client.js';
import { resolveDshLaunch, resolveDshWorkspace } from './launch.js';
import { createDshEventMapContext, mapDshSessionEvent, unwrapAssembledDelta } from './map-events.js';
import { mapOpenClawXModelToDshRoute } from './model-route.js';
import { writeOpenClawXDshCordis } from './cordis-compose.js';
import { materializeOpenClawXSkillsForDsh } from './skills-materialize.js';
import { warmMcpConnections, type McpWarmResult } from '../mcp-runtime.js';
import { openDshMcpBridges } from '../mcp-dsh-bridge.js';
import { createModelCapabilityTools, MODEL_CAPABILITY_BY_TOOL } from '../model-capability-runtime.js';
import { openUnifiedToolMcpBridge } from '../unified-tool-mcp-bridge.js';
import { createUnifiedToolSession, registrationsFromTools } from '../unified-tool-runtime.js';
import { createDecisionAgentTool, guardAgentTools } from '../decision-runtime.js';
import { DshCapabilityAdapter } from '../dsh-capability-adapter.js';
import {
  resolveWorkspaceMode,
  reconcileProjectOutputDirectory,
  snapshotWorkspaceFiles,
  workspaceModeContract,
} from '../workspace-mode.js';
import { filterMcpConnectionsForTask, STEP_BUDGET_EXCEEDED_MESSAGE } from '../pi-runtime.js';

type DshMcpCatalog = {
  labels: string[];
  toolLines: string[];
};

function cancellationEvent(runId: string, signal: AbortSignal): AgentEvent {
  const detail = signal.reason instanceof Error
    ? signal.reason.message
    : typeof signal.reason === 'string'
      ? signal.reason
      : '';
  const timedOut = /timed?\s*out|timeout/i.test(detail);
  return {
    type: 'run.cancelled',
    runId,
    reason: timedOut ? 'timeout' : 'user',
    message: timedOut ? (detail || '执行超时，已中止当前任务。') : (detail || '已由用户中止当前执行。'),
  };
}

function lastUserText(input: ChatRequest): string {
  const history = input.messages ?? [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.role === 'user') return String(history[i]?.content || '');
  }
  return '';
}

function buildPrompt(input: ChatRequest, mcpCatalog?: DshMcpCatalog): string {
  const lines: string[] = [];
  const profile = input.profile?.instructions?.trim();
  if (profile) {
    lines.push(`[OpenClawX agent profile]\n${profile.slice(0, 8_000)}`);
  }
  const skillNames = (input.skills ?? [])
    .filter((skill) => skill.mode === 'available' || skill.mode === 'default')
    .map((skill) => skill.name)
    .filter(Boolean)
    .slice(0, 24);
  if (skillNames.length) {
    lines.push(
      `[Authorized skills — use the skill tool first when the task matches]\n`
      + `${skillNames.map((name) => `- ${name}`).join('\n')}\n`
      + `For PDF / Word / slides / spreadsheet deliverables: load the matching document skill BEFORE ad-hoc bash exploration.`,
    );
  }
  lines.push(workspaceModeContract(resolveWorkspaceMode(input.projectWorkspacePath)));
  lines.push(
    'Execution discipline: write the deliverables, run at most one short verification pass, then stop. '
    + 'Do not spiral into multi-round render/DOM/CSV re-checks, taxonomy crosswalk rewrites, or unrelated MCP calls.',
  );
  const mcpNames = mcpCatalog?.labels?.length
    ? mcpCatalog.labels
    : (input.mcpConnections ?? [])
      .filter((item) => item.enabled !== false)
      .map((item) => item.name)
      .slice(0, 12);
  if (mcpNames.length) {
    lines.push(
      `[Optional MCP servers]\n`
      + `Tools are already registered as mcp__<server>__<tool>. Connected: ${mcpNames.join(', ')}.\n`
      + `MCP is optional, not preferred over engine-native tools. Choose the smallest capable tool: use read/write/edit/bash for local workspace work; use an MCP only when it provides task-specific data or an external capability that local tools cannot provide. Do NOT call market/stock/trading-day tools `
      + `unless the user explicitly asked for live market data.`,
    );
    if (mcpCatalog?.toolLines?.length) {
      lines.push(`[Discovered MCP tool names]\n${mcpCatalog.toolLines.join('\n')}`);
    }
  }
  const history = (input.messages ?? []).slice(-12);
  for (const message of history) {
    const role = message.role === 'assistant' ? 'Assistant' : 'User';
    const content = String(message.content || '').trim();
    if (!content) continue;
    lines.push(`${role}: ${content.slice(0, 12_000)}`);
  }
  if (!lines.length) lines.push('User: (empty)');
  return lines.join('\n\n');
}

function credentialEnv(route: ReturnType<typeof mapOpenClawXModelToDshRoute>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...route.env };
  env.OPENAI_API_KEY = route.apiKey;
  env.DEEPSEEK_API_KEY = route.apiKey;
  if (route.api === 'anthropic-messages') env.ANTHROPIC_API_KEY = route.apiKey;
  env.OPENAI_BASE_URL = route.baseUrl;
  env.DEEPSEEK_BASE_URL = route.baseUrl;
  return env;
}

function enabledMcpConnections(connections: McpConnectionRuntime[] | undefined): McpConnectionRuntime[] {
  return (connections ?? []).filter((item) => item.enabled !== false);
}

/**
 * Stream a ChatRequest through DeepSeek Harness JSON-RPC sidecar (coding engine).
 * Injects OpenClawX ModelConfig, MCP connections, and authorized skills into cordis.
 *
 * MCP strategy:
 * 1. Warm/pin connectors in the OpenClawX process pool (first call cold, later hits fast).
 * 2. Bridge warmed stdio MCPs over localhost HTTP so dsh reuses the live process
 *    (no second npx cold start) and we can gate the first prompt on tools/list.
 * 3. Release bridge + warm pin after the run so idle TTL can reap unused servers.
 */
export async function* streamAgentReplyViaDsh(input: ChatRequest & {
  abortSignal?: AbortSignal;
  runId?: string;
}): AsyncGenerator<AgentEvent> {
  const runId = input.runId?.trim() || randomUUID();
  yield { type: 'run.started', runId };

  // DSH works directly in its cwd and does not proxy filesystem operations
  // through the TypeScript host. Until it has an OS-level read-only sandbox,
  // accepting a read-only run here would silently bypass the platform contract.
  if (input.workspaceAccess === 'read') {
    yield {
      type: 'run.failed',
      runId,
      message: 'DSH 当前不支持只读工作区任务；请改用 PI 或 AgentScope，或将任务权限调整为可写。',
    };
    return;
  }

  let client: DshJsonRpcClient | null = null;
  let warm: McpWarmResult | null = null;
  let bridges: Awaited<ReturnType<typeof openDshMcpBridges>> | null = null;
  let applicationModelBridge: Awaited<ReturnType<typeof openUnifiedToolMcpBridge>> | null = null;
  const runStartedAtMs = Date.now();
  const maxSteps = Math.min(64, Math.max(50, Math.round(Number(input.maxSteps) || 50)));
  try {
    const cwd = resolveDshWorkspace({
      runId,
      projectWorkspacePath: input.projectWorkspacePath,
    });
    const projectBound = Boolean(input.projectWorkspacePath?.trim());
    const capabilityAdapter = new DshCapabilityAdapter({
      runId,
      workspaceRoot: cwd,
      workspaceAccess: input.workspaceAccess ?? 'write',
      workspaceMode: projectBound ? 'project' : 'conversation',
    });
    const modelCapabilityTools = createModelCapabilityTools({ configs: input.modelCapabilities, workspaceRoot: cwd });
    const guardedModelCapabilityTools = guardAgentTools(modelCapabilityTools, input.decisionRuntime);
    const decisionTools = createDecisionAgentTool(input.decisionRuntime);
    const applicationModels = createUnifiedToolSession([
      ...registrationsFromTools(guardedModelCapabilityTools, {
        category: 'model-capability',
        capabilities: MODEL_CAPABILITY_BY_TOOL,
      }),
      ...registrationsFromTools(decisionTools, { category: 'platform' }),
    ]);
    if (applicationModels.descriptors.length) {
      applicationModelBridge = await openUnifiedToolMcpBridge({ runId, session: applicationModels, name: 'application-models' });
    }
    const projectFilesBefore = projectBound ? await snapshotWorkspaceFiles(cwd) : null;
    const route = mapOpenClawXModelToDshRoute(input.model);
    const userText = lastUserText(input);
    const mcpEnabled = filterMcpConnectionsForTask(
      enabledMcpConnections(input.mcpConnections),
      userText,
      { projectBound },
    );

    const publishProjectDiff = async function* (): AsyncGenerator<AgentEvent> {
      if (!projectFilesBefore) return;
      await reconcileProjectOutputDirectory(cwd);
      const after = await snapshotWorkspaceFiles(cwd);
      for (const [relative, fingerprint] of after) {
        if (projectFilesBefore.get(relative) === fingerprint) continue;
        yield { type: 'project.file.published', runId, path: relative, projectPath: relative };
      }
    };

    if (mcpEnabled.length) {
      yield {
        type: 'tool.started',
        runId,
        toolName: 'mcp.warm',
        summary: `预热 MCP（${mcpEnabled.map((item) => item.name).join('、')}）…`,
      };
      warm = await warmMcpConnections(mcpEnabled, { toolTimeoutMs: input.mcpToolTimeoutMs });
      const okCount = warm.items.filter((item) => item.ok).length;
      const hitCount = warm.items.filter((item) => item.ok && item.cacheHit).length;
      const failCount = warm.items.filter((item) => !item.ok).length;
      const summary = failCount
        ? `MCP 预热：${okCount}/${mcpEnabled.length} 可用（缓存命中 ${hitCount}），${failCount} 失败`
        : warm.hadColdStart
          ? `MCP 预热完成（冷启动 ${okCount} 个；下次同连接将复用进程）`
          : `MCP 预热命中缓存（${hitCount} 个，即时可用）`;
      yield {
        type: 'tool.completed',
        runId,
        toolName: 'mcp.warm',
        summary,
        ok: okCount > 0 || mcpEnabled.length === 0,
      };
      if (okCount === 0) {
        yield {
          type: 'run.failed',
          runId,
          message: `MCP 预热全部失败，已中止本轮以免退回 bash 探测：${warm.items.map((item) => `${item.name}: ${item.error || 'unknown'}`).join('; ')}`,
        };
        return;
      }
    }

    const mcpCatalog: DshMcpCatalog = {
      labels: warm?.labels?.length
        ? warm.labels
        : mcpEnabled.map((item) => item.name).slice(0, 12),
      toolLines: warm?.toolLines ?? [],
    };
    if (applicationModelBridge) {
      mcpCatalog.labels.push('application-models');
      mcpCatalog.toolLines.push(...applicationModels.descriptors.map((item) => `- application-models: ${item.name}`));
    }

    const warmedOk = mcpEnabled.filter((conn) => {
      if (!warm) return true;
      const item = warm.items.find((row) => row.name === conn.name);
      return !item || item.ok;
    });
    if (warmedOk.length) {
      bridges = await openDshMcpBridges(warmedOk);
    }
    const mcpForCordis: McpConnectionRuntime[] = [
      ...(bridges?.cordisConnections ?? warmedOk),
      ...(applicationModelBridge ? [applicationModelBridge.connection] : []),
    ];

    const skillsRoot = materializeOpenClawXSkillsForDsh(cwd, input.skills);
    const customCordis = process.env.OPENCLAWX_DSH_CORDIS?.trim();
    const cordisConfig = customCordis
      ? path.resolve(customCordis)
      : writeOpenClawXDshCordis(cwd, {
          route,
          // Bridged http URLs when possible; never pass connectors that failed warm
          // (failOnStartupError:true would otherwise block the whole dsh boot).
          mcpConnections: mcpForCordis,
          skillsEnabled: Boolean(skillsRoot),
          customSkillDirs: skillsRoot ? [skillsRoot] : [],
          mcpToolTimeoutMs: input.mcpToolTimeoutMs,
        });
    const launch = resolveDshLaunch({ cordisConfig });

    const env: NodeJS.ProcessEnv = {
      ...credentialEnv(route),
      DSH_CORDIS_CONFIG: launch.cordisConfig,
      DSH_CWD: cwd,
      DSH_SESSION_ROOT: path.join(cwd, '.dsh-sessions'),
      DSH_SYSTEM_PROMPT: (() => {
        const base = input.profile?.instructions?.slice(0, 4_000)
          || 'You are a careful coding agent working inside a OpenClawX workspace.';
        const mcpNames = mcpCatalog.labels;
        const deliverable = `\n\n${workspaceModeContract(projectBound ? 'project' : 'conversation')}\n\n${capabilityAdapter.systemPromptContract()}`
          + '\n\nAfter deliverables exist and one short verification pass succeeds, stop. '
          + 'Do not run multi-round DOM/CSV re-validation or call unrelated market/stock MCP tools.';
        if (!mcpNames.length) return `${base}${deliverable}`;
        const discovered = mcpCatalog.toolLines.length
          ? `\nAvailable MCP tools:\n${mcpCatalog.toolLines.join('\n')}`
          : '';
        return `${base}${deliverable}\n\nConnected MCP servers (use only when they directly help the deliverable): ${mcpNames.join(', ')}.${discovered}`;
      })(),
    };

    if (mcpCatalog.labels.length) {
      yield {
        type: 'tool.started',
        runId,
        toolName: 'mcp.dsh-boot',
        summary: bridges?.bridges.length
          ? `启动编码引擎并挂载 MCP（经本地桥接复用预热进程）…`
          : warm?.hadColdStart
            ? '启动编码引擎并挂载 MCP（已预热包缓存，仍需短暂拉起 sidecar）…'
            : '启动编码引擎并挂载 MCP（复用预热缓存）…',
      };
    }

    client = new DshJsonRpcClient(launch.command, launch.args, env, launch.spawnCwd ?? cwd);
    await client.initialize({
      cwd,
      provider: route.provider,
      model: route.model,
    });

    if (bridges?.bridges.length) {
      const listed = await Promise.all(
        bridges.bridges.map((bridge) => bridge.waitUntilListed(90_000)),
      );
      const missing = bridges.bridges
        .filter((_, index) => !listed[index])
        .map((bridge) => bridge.name);
      if (missing.length) {
        yield {
          type: 'run.failed',
          runId,
          message: `编码引擎已启动，但 MCP 工具未在时限内挂载（${missing.join('、')}）。已中止以免退回 bash 探测；请重试或检查连接器。`,
        };
        return;
      }
    }
    if (applicationModelBridge && !(await applicationModelBridge.waitUntilListed(90_000))) {
      yield { type: 'run.failed', runId, message: '编码引擎已启动，但应用模型工具未在时限内挂载。' };
      return;
    }

    if (mcpCatalog.labels.length) {
      yield {
        type: 'tool.completed',
        runId,
        toolName: 'mcp.dsh-boot',
        summary: bridges?.bridges.length
          ? `编码引擎已就绪，MCP 经桥接挂载：${mcpCatalog.labels.join('、')}`
          : `编码引擎已就绪，MCP 工具已注册：${mcpCatalog.labels.join('、')}`,
        ok: true,
      };
    }

    const sessionId = `wm-${runId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || randomUUID().replace(/-/g, '')}`;
    const queue: AgentEvent[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    let failed = false;
    let stepBudgetExceeded = false;
    let toolTurns = 0;
    let emittedText = false;
    const eventMapCtx = createDshEventMapContext();
    const bump = () => { wake?.(); wake = null; };

    const off = client.onNotification((note) => {
      if (note.method === 'session.status') {
        if (note.params.sessionId === sessionId && note.params.status === 'idle') {
          done = true;
          bump();
        }
        return;
      }
      if (note.method !== 'session.event') return;
      if (note.params.sessionId !== sessionId) return;
      const mapped = mapDshSessionEvent(runId, note.params.event, eventMapCtx);
      for (const event of mapped) {
        if (event.type === 'message.delta') {
          const { assembled, text } = unwrapAssembledDelta(event.text);
          if (assembled) {
            if (emittedText || !text) continue;
            queue.push({ type: 'message.delta', runId, text });
            emittedText = true;
          } else {
            queue.push({ type: 'message.delta', runId, text });
            emittedText = true;
          }
          bump();
          continue;
        }
        if (event.type === 'tool.started' || event.type === 'tool.completed' || event.type === 'tool.failed') {
          const key = (Object.keys(MODEL_CAPABILITY_BY_TOOL) as Array<keyof typeof MODEL_CAPABILITY_BY_TOOL>)
            .find((name) => event.toolName.endsWith(name));
          const capability = key ? MODEL_CAPABILITY_BY_TOOL[key] : undefined;
          const modelId = capability ? input.modelCapabilities?.find((item) => item.capability === capability)?.modelId : undefined;
          if (capability && modelId) {
            queue.push(event.type === 'tool.started'
              ? { type: 'capability.started', runId, invocationId: event.invocationId, capability, modelId, summary: event.summary }
              : event.type === 'tool.completed'
                  ? { type: 'capability.completed', runId, invocationId: event.invocationId, capability, modelId, summary: event.summary, ok: event.ok }
                  : { type: 'capability.failed', runId, invocationId: event.invocationId, capability, modelId, summary: event.summary });
            bump();
            continue;
          }
        }
        if (event.type === 'tool.started'
          && event.toolName !== 'mcp.warm'
          && event.toolName !== 'mcp.dsh-boot') {
          toolTurns += 1;
          if (toolTurns > maxSteps) {
            stepBudgetExceeded = true;
            failed = true;
            done = true;
            void client?.shutdown();
            // Drop further tool noise; budget failure is emitted after harvest.
            bump();
            continue;
          }
        }
        if (event.type === 'run.failed') failed = true;
        queue.push(event);
        bump();
      }
    });

    const onAbort = () => {
      done = true;
      bump();
      void client?.shutdown();
    };
    input.abortSignal?.addEventListener('abort', onAbort, { once: true });

    try {
      await client.prompt(sessionId, buildPrompt(input, mcpCatalog));

      while (!done || queue.length) {
        if (input.abortSignal?.aborted) {
          yield cancellationEvent(runId, input.abortSignal);
          return;
        }
        while (queue.length) {
          const event = queue.shift()!;
          yield event;
          if (event.type === 'run.failed') {
            // Still publish files so step-budget soft-complete (and UI) can see them.
            yield* publishProjectDiff();
            return;
          }
        }
        if (stepBudgetExceeded) break;
        if (done) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (queue.length || done || stepBudgetExceeded) resolve();
        });
        wake = null;
      }

      // onAbort also flips `done`; re-check after the loop so a timeout can
      // never be converted into a successful completion.
      if (input.abortSignal?.aborted) {
        yield cancellationEvent(runId, input.abortSignal);
        return;
      }

      if (stepBudgetExceeded) {
        yield* publishProjectDiff();
        yield { type: 'run.failed', runId, message: STEP_BUDGET_EXCEEDED_MESSAGE(maxSteps) };
        return;
      }

      if (!failed) {
        if (projectFilesBefore) {
          yield* publishProjectDiff();
        } else {
          // DSH owns its filesystem plugin; publish only after the successful
          // run has ended and the shared capability adapter verifies each file.
          const committed = await capabilityAdapter.commitCompletedArtifacts(runStartedAtMs).catch(() => []);
          for (const relative of committed) {
            yield { type: 'artifact.created', runId, path: relative };
          }
        }
        yield { type: 'run.completed', runId };
      } else if (projectFilesBefore) {
        yield* publishProjectDiff();
      }
    } finally {
      off();
      input.abortSignal?.removeEventListener('abort', onAbort);
    }
  } catch (error) {
    if (input.abortSignal?.aborted) {
      yield cancellationEvent(runId, input.abortSignal);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const mcpHint = /mcp-client|initial connection|tool synchronization/i.test(message)
      ? '（MCP 启动失败：请在「技能与连接」中重新测试对应连接器，或稍后再试；首次 npx 冷启动可能较慢。）'
      : '';
    yield { type: 'run.failed', runId, message: `${message}${mcpHint}` };
  } finally {
    await client?.shutdown().catch(() => undefined);
    await applicationModelBridge?.close().catch(() => undefined);
    await bridges?.close().catch(() => undefined);
    warm?.release();
  }
}
