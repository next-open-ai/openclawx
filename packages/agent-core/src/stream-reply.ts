import type { AgentEvent } from '@workmate/contracts';
import { DEFAULT_RUN_TIMEOUT_MS } from './pi-runtime.js';
import './execution-backends.js';
import {
  resolveExecutionBackend,
  resolveAgentEngine,
  type AgentEngineId,
  type BackendResolveInput,
  type ExecutionBackendStreamInput,
} from './execution-backend.js';
import { loadExecutionRoutingConfig } from './execution-routing-config.js';
import { attachBuiltinSkillPackages } from './builtin-skill-packages.js';
import { assertVisionSupported } from './image-input.js';
import { streamTextOnlyReply } from './text-only-reply.js';

export { DEFAULT_RUN_TIMEOUT_MS };
export {
  resolveAgentEngine,
  resolveExecutionBackend,
  registerExecutionBackend,
  unregisterExecutionBackend,
  getExecutionBackend,
  listExecutionBackends,
  availableExecutionBackendIds,
  resetExecutionBackendRegistryForTests,
  type AgentEngineId,
  type ExecutionBackend,
  type ExecutionBackendCapabilities,
  type ExecutionBackendStreamInput,
  type BackendResolveInput,
} from './execution-backend.js';
export { registerBuiltinExecutionBackends } from './execution-backends.js';
export {
  loadExecutionRoutingConfig,
  type ExecutionRoutingConfig,
} from './execution-routing-config.js';

export function requiresDecisionGuardCompatibleBackend(
  input: Pick<ExecutionBackendStreamInput, 'decisionRuntime'>,
): boolean {
  const decision = input.decisionRuntime;
  return Boolean(decision?.enabled && decision.mode === 'enforce' && decision.guardTools);
}

/**
 * Single product entry: resolve an ExecutionBackend then stream AgentEvents.
 *
 * Routing: runtime-settings allowlist/default + ChatRequest.engine + optional hints.
 * Ops force: `resolve.override`, or `WORKMATE_AGENT_ENGINE` + `WORKMATE_AGENT_ENGINE_FORCE=1`.
 */
export async function* streamAgentReply(
  input: ExecutionBackendStreamInput,
  resolve?: BackendResolveInput,
): AsyncGenerator<AgentEvent> {
  if (input.responseMode === 'text-only') {
    yield* streamTextOnlyReply(input);
    return;
  }
  const preparedInput: ExecutionBackendStreamInput = {
    ...input,
    skills: await attachBuiltinSkillPackages(input.skills ?? []),
  };
  const stored = loadExecutionRoutingConfig();
  let backend = resolveExecutionBackend({
    enabledEngines: resolve?.enabledEngines ?? stored.enabledEngines,
    defaultEngine: resolve?.defaultEngine ?? stored.defaultEngine,
    override: resolve?.override,
    employeeEngine: resolve?.employeeEngine ?? preparedInput.engine ?? null,
    preferCoding: resolve?.preferCoding,
    preferProcessIsolation: resolve?.preferProcessIsolation,
  });
  if (backend.id !== 'pi' && requiresDecisionGuardCompatibleBackend(preparedInput)) {
    console.info('[workmate] decision guard requires an execution backend with complete before-tool coverage', {
      requestedEngine: backend.id,
      fallbackEngine: 'pi',
      provider: preparedInput.decisionRuntime?.provider ?? 'jev',
    });
    backend = resolveExecutionBackend({ override: 'pi' });
  }
  assertVisionSupported(input.messages, input.model.supportsVision, backend.id, input.modelCapabilities);
  console.info('[workmate] execution backend selected', {
    engine: backend.id,
    requestEngine: preparedInput.engine ?? null,
    profileId: preparedInput.profile?.id ?? null,
  });
  let annotatedStarted = false;
  for await (const event of backend.stream(preparedInput)) {
    if (event.type === 'run.started' && !annotatedStarted) {
      annotatedStarted = true;
      yield { ...event, engine: backend.id };
      continue;
    }
    yield event;
  }
}
