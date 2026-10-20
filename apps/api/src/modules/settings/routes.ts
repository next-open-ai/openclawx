import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyPluginAsync } from 'fastify';
import { detectBundledPython, doclingEnhancedComponentRoot, pptxEnhancedComponentRoot, pythonArgv } from '@openclawx/agent-core';
import { authenticateRequest, requireAuth, requireAdmin, sendAuthError } from '../auth/service.js';
import { executeStorageCleanup, scanStorageCleanup } from './storage-cleanup.js';
import { publicRealtimeVoiceSettings, saveRealtimeVoiceSettings } from '../voice/settings.js';
import { publicVoiceInputSettings, saveVoiceInputSettings } from '../voice/asr-settings.js';
import {KnowledgeBaseRuntimeSchema} from '@openclawx/contracts';
import { legacyRealtimeMigrationSource, publicRealtimeConversationSettings, saveRealtimeConversationSettings } from '../voice/realtime-settings.js';
import { readVoicePreferences, saveVoicePreferences } from '../voice/voice-preferences.js';

type SettingName =
  | 'model-settings'
  | 'search-settings'
  | 'knowledge-providers'
  | 'knowledge-bases'
  | 'mcp-connections'
  | 'capability-skills'
  | 'capability-policies'
  | 'runtime-settings';

type SettingsEnvelope = {
  meta: unknown;
  secrets?: unknown;
};

const execFileAsync = promisify(execFile);
const PPTX_COMPONENT_VERSION = 1;
const DOCLING_COMPONENT_VERSION = 1;

function agentscopeRoot() {
  return process.env.OPENCLAWX_AGENTSCOPE_ROOT?.trim() || path.resolve(process.cwd(), 'runtimes', 'agentscope-runtime');
}

function pptxComponentPaths() {
  const root = pptxEnhancedComponentRoot();
  return { root, packages: path.join(root, 'python-packages'), marker: path.join(root, 'installed.json') };
}

function pptxPython() {
  return process.env.OPENCLAWX_AGENTSCOPE_PYTHON?.trim()
    || detectBundledPython(agentscopeRoot())?.command
    || (process.platform === 'win32' ? 'python' : 'python3');
}

function doclingComponentPaths() {
  const root = doclingEnhancedComponentRoot();
  return { root, packages: path.join(root, 'python-packages'), marker: path.join(root, 'installed.json') };
}

async function doclingComponentStatus() {
  const paths = doclingComponentPaths();
  if (!fs.existsSync(paths.marker)) return { state: 'not-installed' as const, installed: false, version: null, location: paths.root };
  try {
    const invocation = pythonArgv(pptxPython(), ['-c', 'import docling; print(getattr(docling, "__version__", "installed"))']);
    const result = await execFileAsync(invocation.command, invocation.args, {
      timeout: 15_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, PYTHONPATH: [paths.packages, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter), PYTHONIOENCODING: 'utf-8' },
    });
    return { state: 'ready' as const, installed: true, version: String(result.stdout || '').trim() || 'installed', location: paths.root };
  } catch (error) {
    return { state: 'broken' as const, installed: true, version: null, location: paths.root, message: error instanceof Error ? error.message : String(error) };
  }
}

async function installDoclingComponent() {
  const paths = doclingComponentPaths();
  fs.mkdirSync(paths.packages, { recursive: true, mode: 0o700 });
  const invocation = pythonArgv(pptxPython(), ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', '--target', paths.packages, 'markitdown[pdf,docx]>=0.1.3,<0.2', 'docling-slim[convert-core,format-pdf,format-docx]>=2.70,<3']);
  try {
    await execFileAsync(invocation.command, invocation.args, { timeout: 600_000, maxBuffer: 16 * 1024 * 1024, env: process.env });
    fs.writeFileSync(paths.marker, JSON.stringify({ schemaVersion: DOCLING_COMPONENT_VERSION, installedAt: Date.now(), packages: ['markitdown[pdf,docx]>=0.1.3,<0.2', 'docling-slim[convert-core,format-pdf,format-docx]>=2.70,<3'] }, null, 2), { mode: 0o600 });
    const status = await doclingComponentStatus();
    if (status.state !== 'ready') throw new Error(status.message || '安装完成但组件校验失败。');
    return status;
  } catch (error) { fs.rmSync(paths.root, { recursive: true, force: true }); throw error; }
}

async function pptxComponentStatus() {
  const paths = pptxComponentPaths();
  if (!fs.existsSync(paths.marker)) {
    return { state: 'not-installed' as const, installed: false, version: null, location: paths.root };
  }
  try {
    const invocation = pythonArgv(pptxPython(), ['-c', 'from markitdown import MarkItDown; import pptx; MarkItDown(); print(getattr(pptx, "__version__", "unknown"))']);
    const result = await execFileAsync(invocation.command, invocation.args, {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PYTHONPATH: [paths.packages, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter), PYTHONIOENCODING: 'utf-8' },
    });
    return { state: 'ready' as const, installed: true, version: String(result.stdout || '').trim() || 'unknown', location: paths.root };
  } catch (error) {
    return {
      state: 'broken' as const,
      installed: true,
      version: null,
      location: paths.root,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function installPptxComponent() {
  const paths = pptxComponentPaths();
  fs.mkdirSync(paths.packages, { recursive: true, mode: 0o700 });
  const invocation = pythonArgv(pptxPython(), [
    '-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', '--target', paths.packages, 'markitdown[pptx]>=0.1.3,<0.2',
  ]);
  try {
    await execFileAsync(invocation.command, invocation.args, { timeout: 180_000, maxBuffer: 8 * 1024 * 1024, env: process.env });
    fs.writeFileSync(paths.marker, JSON.stringify({ schemaVersion: PPTX_COMPONENT_VERSION, installedAt: Date.now(), package: 'markitdown[pptx]>=0.1.3,<0.2' }, null, 2), { mode: 0o600 });
    const status = await pptxComponentStatus();
    if (status.state !== 'ready') throw new Error(status.message || '安装完成但组件校验失败。');
    return status;
  } catch (error) {
    fs.rmSync(paths.root, { recursive: true, force: true });
    throw error;
  }
}

function dataDir(): string {
  return process.env.OPENCLAWX_DATA_DIR || path.join(os.homedir(), '.openclawx');
}

function settingsFile(name: SettingName) {
  return path.join(dataDir(), `${name}.json`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map((item) => asRecord(item)) : [];
}

function readJson(name: SettingName) {
  try {
    const file = settingsFile(name);
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(name: SettingName, value: unknown) {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const file = settingsFile(name);
  fs.writeFileSync(file, JSON.stringify(value ?? {}, null, 2), { mode: 0o600 });
  return value;
}

function isEnvelope(value: unknown): value is SettingsEnvelope {
  const row = asRecord(value);
  return Object.prototype.hasOwnProperty.call(row, 'meta');
}

function splitModelSettings(value: unknown): SettingsEnvelope {
  const raw = asRecord(value);
  const providerInstances = arrayOfRecords(raw.providerInstances).map((provider) => ({
    id: String(provider.id || ''),
    type: String(provider.type || ''),
    name: String(provider.name || ''),
    baseUrl: String(provider.baseUrl || ''),
    ...(provider.service ? { service: String(provider.service) } : {}),
    ...(provider.endpoints && typeof provider.endpoints === 'object' ? { endpoints: asRecord(provider.endpoints) } : {}),
    ...(provider.workspaceId ? { workspaceId: String(provider.workspaceId) } : {}),
    ...(provider.appId ? { appId: String(provider.appId) } : {}),
    disableThinking: Boolean(provider.disableThinking),
  }));
  const providerSecrets = Object.fromEntries(arrayOfRecords(raw.providerInstances)
    .map((provider) => [String(provider.id || ''), { apiKey: String(provider.apiKey || ''), apiSecret: String(provider.apiSecret || '') }])
    .filter(([id]) => Boolean(id)));
  if (providerInstances.length) {
    return {
      meta: {
        version: Number(raw.version) || 2,
        providerInstances,
        models: arrayOfRecords(raw.models).map((model) => ({
          id: String(model.id || ''),
          providerInstanceId: String(model.providerInstanceId || ''),
          capability: String(model.capability || ''),
          modelId: String(model.modelId || ''),
          ...(model.voice ? { voice: String(model.voice) } : {}),
          ...(model.label ? { label: String(model.label) } : {}),
          ...(model.imageProtocol ? { imageProtocol: String(model.imageProtocol) } : {}),
          ...(model.decisionProtocol ? { decisionProtocol: String(model.decisionProtocol) } : {}),
          ...(model.meta && typeof model.meta === 'object'
            ? {
                meta: {
                  ...(Number(asRecord(model.meta).dimension) ? { dimension: Number(asRecord(model.meta).dimension) } : {}),
                  ...(typeof asRecord(model.meta).normalize === 'boolean' ? { normalize: Boolean(asRecord(model.meta).normalize) } : {}),
                  ...(Number(asRecord(model.meta).maxBatch) ? { maxBatch: Number(asRecord(model.meta).maxBatch) } : {}),
                  ...(Number(asRecord(model.meta).maxInputChars) ? { maxInputChars: Number(asRecord(model.meta).maxInputChars) } : {}),
                },
              }
            : {}),
          supportsVision: model.capability === 'chat' && Boolean(model.supportsVision),
          ...(Object.prototype.hasOwnProperty.call(model, 'supportsBuiltinWebSearch')
            ? { supportsBuiltinWebSearch: Boolean(model.supportsBuiltinWebSearch) }
            : {}),
          ...(model.health && typeof model.health === 'object'
            ? {
                health: {
                  status: String(asRecord(model.health).status || ''),
                  checkedAt: String(asRecord(model.health).checkedAt || ''),
                  summary: String(asRecord(model.health).summary || '').slice(0, 500),
                },
              }
            : {}),
        })),
        activeChatModelId: raw.activeChatModelId ? String(raw.activeChatModelId) : null,
        activeEmbeddingModelId: raw.activeEmbeddingModelId ? String(raw.activeEmbeddingModelId) : null,
        employeeDefaultModelIds: asRecord(raw.employeeDefaultModelIds),
        capabilityBindings: arrayOfRecords(raw.capabilityBindings),
        agentCapabilityAssignments: arrayOfRecords(raw.agentCapabilityAssignments),
        ...(raw.decisionRuntime && typeof raw.decisionRuntime === 'object' ? { decisionRuntime: { ...asRecord(raw.decisionRuntime), apiKey: undefined } } : {}),
      },
      secrets: { providerInstances: providerSecrets, decisionRuntime: { apiKey: String(asRecord(raw.decisionRuntime).apiKey || '') } },
    };
  }
  const providers = arrayOfRecords(raw.providers).map((provider) => ({
    provider: String(provider.provider || ''),
    baseUrl: String(provider.baseUrl || ''),
    chatModel: String(provider.chatModel || ''),
    chatModels: Array.isArray(provider.chatModels) ? provider.chatModels.map((item) => String(item)) : [],
    disableThinking: Boolean(provider.disableThinking),
    imageModel: String(provider.imageModel || ''),
    embeddingModel: String(provider.embeddingModel || ''),
    asrModel: String(provider.asrModel || ''),
    ttsModel: String(provider.ttsModel || ''),
  }));
  return {
    meta: {
      activeProvider: String(raw.activeProvider || 'openai'),
      providers,
      baseUrl: String(raw.baseUrl || ''),
      model: String(raw.model || ''),
    },
    secrets: {
      providers: Object.fromEntries(arrayOfRecords(raw.providers)
        .map((provider, index) => [String(index), { apiKey: String(provider.apiKey || '') }])),
      apiKey: String(raw.apiKey || ''),
    },
  };
}

function mergeModelSettings(value: unknown) {
  const envelope = isEnvelope(value) ? value : splitModelSettings(value);
  const meta = asRecord(envelope.meta);
  const secrets = asRecord(envelope.secrets);
  if (Array.isArray(meta.providerInstances)) {
    const providerSecrets = asRecord(secrets.providerInstances);
    return {
      version: Number(meta.version) || 2,
      providerInstances: arrayOfRecords(meta.providerInstances).map((provider) => ({
        ...provider,
        apiKey: String(asRecord(providerSecrets[String(provider.id || '')]).apiKey || ''),
        apiSecret: String(asRecord(providerSecrets[String(provider.id || '')]).apiSecret || ''),
      })),
      models: Array.isArray(meta.models) ? meta.models : [],
      activeChatModelId: meta.activeChatModelId ? String(meta.activeChatModelId) : null,
      activeEmbeddingModelId: meta.activeEmbeddingModelId ? String(meta.activeEmbeddingModelId) : null,
      employeeDefaultModelIds: asRecord(meta.employeeDefaultModelIds),
      capabilityBindings: Array.isArray(meta.capabilityBindings) ? meta.capabilityBindings : [],
      agentCapabilityAssignments: Array.isArray(meta.agentCapabilityAssignments) ? meta.agentCapabilityAssignments : [],
      ...(meta.decisionRuntime && typeof meta.decisionRuntime === 'object' ? { decisionRuntime: { ...asRecord(meta.decisionRuntime), apiKey: String(asRecord(secrets.decisionRuntime).apiKey || '') } } : {}),
    };
  }
  const providerSecrets = asRecord(secrets.providers);
  return {
    activeProvider: String(meta.activeProvider || 'openai'),
    providers: arrayOfRecords(meta.providers).map((provider, index) => ({
      ...provider,
      apiKey: String(asRecord(providerSecrets[String(index)]).apiKey || ''),
    })),
    baseUrl: String(meta.baseUrl || ''),
    model: String(meta.model || ''),
    apiKey: String(secrets.apiKey || ''),
  };
}

function splitSearchSettings(value: unknown): SettingsEnvelope {
  const raw = asRecord(value);
  const providers = arrayOfRecords(raw.providers);
  return {
    meta: {
      version: Number(raw.version) || 1,
      defaultProvider: String(raw.defaultProvider || 'auto'),
      providers: providers.map((provider) => ({
        id: String(provider.id || ''),
        label: String(provider.label || provider.id || ''),
        baseUrl: String(provider.baseUrl || ''),
        enabled: Boolean(provider.enabled),
      })),
    },
    secrets: {
      providers: Object.fromEntries(providers.map((provider) => [String(provider.id || ''), { apiKey: String(provider.apiKey || '') }])),
    },
  };
}

function mergeSearchSettings(value: unknown) {
  const envelope = isEnvelope(value) ? value : splitSearchSettings(value);
  const meta = asRecord(envelope.meta);
  const secrets = asRecord(envelope.secrets);
  const providerSecrets = asRecord(secrets.providers);
  return {
    version: Number(meta.version) || 1,
    defaultProvider: String(meta.defaultProvider || 'auto'),
    providers: arrayOfRecords(meta.providers).map((provider) => ({
      ...provider,
      apiKey: String(asRecord(providerSecrets[String(provider.id || '')]).apiKey || ''),
    })),
  };
}

function splitKnowledgeProviders(value: unknown): SettingsEnvelope {
  const raw = asRecord(value);
  const providers = arrayOfRecords(raw.providers);
  return {
    meta: {
      version: Number(raw.version) || 1,
      providers: providers.map((provider) => ({
        id: String(provider.id || ''),
        enabled: Boolean(provider.enabled),
        defaultBaseUrl: String(provider.defaultBaseUrl || ''),
        defaultWorkspaceId: String(provider.defaultWorkspaceId || ''),
        defaultAccessKeyId: String(provider.defaultAccessKeyId || ''),
      })),
    },
    secrets: {
      providers: Object.fromEntries(providers.map((provider) => [String(provider.id || ''), {
        defaultApiKey: String(provider.defaultApiKey || ''),
        defaultAccessKeySecret: String(provider.defaultAccessKeySecret || ''),
      }])),
    },
  };
}

function mergeKnowledgeProviders(value: unknown) {
  const envelope = isEnvelope(value) ? value : splitKnowledgeProviders(value);
  const meta = asRecord(envelope.meta);
  const secrets = asRecord(envelope.secrets);
  const providerSecrets = asRecord(secrets.providers);
  return {
    version: Number(meta.version) || 1,
    providers: arrayOfRecords(meta.providers).map((provider) => ({
      ...provider,
      defaultApiKey: String(asRecord(providerSecrets[String(provider.id || '')]).defaultApiKey || ''),
      defaultAccessKeySecret: String(asRecord(providerSecrets[String(provider.id || '')]).defaultAccessKeySecret || ''),
    })),
  };
}

function splitKnowledgeBases(value: unknown): SettingsEnvelope {
  const rows = arrayOfRecords(value);
  return {
    meta: rows.map((item) => ({
      id: String(item.id || ''),
      name: String(item.name || ''),
      provider: String(item.provider || ''),
      enabled: item.enabled !== false,
      description: String(item.description || ''),
      dataDir: String(item.dataDir || ''),
      baseUrl: String(item.baseUrl || ''),
      externalId: String(item.externalId || ''),
      categoryId: String(item.categoryId || ''),
      workspaceId: String(item.workspaceId || ''),
      accessKeyId: String(item.accessKeyId || ''),
      embeddingBaseUrl: String(item.embeddingBaseUrl || ''),
      embeddingModel: String(item.embeddingModel || ''),
      embeddingMode: item.embeddingMode === 'model' ? 'model' : item.embeddingMode === 'system' ? 'system' : undefined,
      embeddingModelConfigId: String(item.embeddingModelConfigId || ''),
      ...(item.embeddingMeta && typeof item.embeddingMeta === 'object'
        ? {
            embeddingMeta: {
              ...(Number(asRecord(item.embeddingMeta).dimension) ? { dimension: Number(asRecord(item.embeddingMeta).dimension) } : {}),
              ...(typeof asRecord(item.embeddingMeta).normalize === 'boolean' ? { normalize: Boolean(asRecord(item.embeddingMeta).normalize) } : {}),
              ...(Number(asRecord(item.embeddingMeta).maxBatch) ? { maxBatch: Number(asRecord(item.embeddingMeta).maxBatch) } : {}),
              ...(Number(asRecord(item.embeddingMeta).maxInputChars) ? { maxInputChars: Number(asRecord(item.embeddingMeta).maxInputChars) } : {}),
            },
          }
        : {}),
      ...(item.indexState && typeof item.indexState === 'object'
        ? {
            indexState: {
              status: String(asRecord(item.indexState).status || 'ready'),
              ...(asRecord(item.indexState).signature ? { signature: String(asRecord(item.indexState).signature) } : {}),
              ...(Number(asRecord(item.indexState).lastBuildAt) ? { lastBuildAt: Number(asRecord(item.indexState).lastBuildAt) } : {}),
              ...(asRecord(item.indexState).lastBuildModel ? { lastBuildModel: String(asRecord(item.indexState).lastBuildModel) } : {}),
              ...(asRecord(item.indexState).lastBuildError ? { lastBuildError: String(asRecord(item.indexState).lastBuildError) } : {}),
            },
          }
        : {}),
      documentCount: Number(item.documentCount) || 0,
      updatedAt: Number(item.updatedAt) || Date.now(),
    })),
    secrets: {
      bases: Object.fromEntries(rows.map((item) => [String(item.id || ''), {
        apiKey: String(item.apiKey || ''),
        accessKeySecret: String(item.accessKeySecret || ''),
        embeddingApiKey: String(item.embeddingApiKey || ''),
      }])),
    },
  };
}

function mergeKnowledgeBases(value: unknown) {
  const envelope = isEnvelope(value) ? value : splitKnowledgeBases(value);
  const meta = Array.isArray(asRecord({ meta: envelope.meta }).meta) ? envelope.meta : [];
  const secrets = asRecord(envelope.secrets);
  const baseSecrets = asRecord(secrets.bases);
  return arrayOfRecords(meta).map((item) => ({
    ...item,
    apiKey: String(asRecord(baseSecrets[String(item.id || '')]).apiKey || ''),
    accessKeySecret: String(asRecord(baseSecrets[String(item.id || '')]).accessKeySecret || ''),
    embeddingApiKey: String(asRecord(baseSecrets[String(item.id || '')]).embeddingApiKey || ''),
  }));
}

/** Server-only resolution; experience settings persist only the target ID and a hash. */
export function readExperienceKnowledgeTarget(id:string){
  const base=arrayOfRecords(mergeKnowledgeBases(readJson('knowledge-bases'))).find(row=>row.id===id);
  if(!base||base.enabled===false)return undefined;
  const provider=arrayOfRecords(mergeKnowledgeProviders(readJson('knowledge-providers')).providers).find(row=>row.id===base.provider);
  if(provider?.enabled===false)return undefined;
  const settings=asRecord(mergeModelSettings(readJson('model-settings'))),models=arrayOfRecords(settings.models),instances=arrayOfRecords(settings.providerInstances);
  const modelId=base.embeddingMode==='model'?base.embeddingModelConfigId:settings.activeEmbeddingModelId;
  const model=models.find(m=>m.id===modelId&&m.capability==='embedding'),connection=model?instances.find(p=>p.id===model.providerInstanceId):undefined;
  if(base.provider==='lancedb'&&base.embeddingMode&&(!model||!connection||connection.enabled===false))return undefined;
  const parsed=KnowledgeBaseRuntimeSchema.safeParse({...base,baseUrl:base.baseUrl||provider?.defaultBaseUrl||undefined,apiKey:base.apiKey||provider?.defaultApiKey||undefined,workspaceId:base.workspaceId||provider?.defaultWorkspaceId||undefined,accessKeyId:base.accessKeyId||provider?.defaultAccessKeyId||undefined,accessKeySecret:base.accessKeySecret||provider?.defaultAccessKeySecret||undefined,
    ...(model&&connection?{embeddingModel:String(model.modelId||''),embeddingBaseUrl:String(connection.baseUrl||''),embeddingApiKey:String(connection.apiKey||'')}:{}),});
  return parsed.success?parsed.data:undefined;
}

function splitMcpConnections(value: unknown): SettingsEnvelope {
  const rows = arrayOfRecords(value);
  return {
    meta: rows.map((item) => ({
      id: String(item.id || ''),
      name: String(item.name || ''),
      kind: String(item.kind || ''),
      transport: String(item.transport || ''),
      url: String(item.url || ''),
      command: String(item.command || ''),
      args: Array.isArray(item.args) ? item.args.map((arg) => String(arg)) : [],
      cwd: String(item.cwd || ''),
      runner: String(item.runner || ''),
      enabled: item.enabled !== false,
      description: String(item.description || ''),
      lastTestStatus: item.lastTestStatus ? String(item.lastTestStatus) : undefined,
      lastTestAt: Number(item.lastTestAt) || undefined,
      lastTestMessage: item.lastTestMessage ? String(item.lastTestMessage) : undefined,
      lastTestToolCount: Number(item.lastTestToolCount) || undefined,
      lastTestTools: Array.isArray(item.lastTestTools) ? item.lastTestTools : undefined,
      updatedAt: Number(item.updatedAt) || Date.now(),
    })),
    secrets: {
      connections: Object.fromEntries(rows.map((item) => [String(item.id || ''), {
        apiKey: String(item.apiKey || ''),
        env: asRecord(item.env),
      }])),
    },
  };
}

function mergeMcpConnections(value: unknown) {
  const envelope = isEnvelope(value) ? value : splitMcpConnections(value);
  const meta = Array.isArray(asRecord({ meta: envelope.meta }).meta) ? envelope.meta : [];
  const secrets = asRecord(envelope.secrets);
  const connectionSecrets = asRecord(secrets.connections);
  return arrayOfRecords(meta).map((item) => ({
    ...item,
    apiKey: String(asRecord(connectionSecrets[String(item.id || '')]).apiKey || ''),
    env: asRecord(asRecord(connectionSecrets[String(item.id || '')]).env),
  }));
}

function splitRuntimeSettings(value: unknown): SettingsEnvelope {
  const raw = asRecord(value);
  const enabledRaw = Array.isArray(raw.enabledEngines) ? raw.enabledEngines : [];
  const enabledEngines = [...new Set(
    enabledRaw
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((id) => ['pi', 'agentscope', 'dsh', 'opencode', 'claude-code'].includes(id)),
  )];
  const defaultCandidate = String(raw.defaultEngine || '').trim().toLowerCase();
  const defaultEngine =
    (['pi', 'agentscope', 'dsh', 'opencode', 'claude-code'].includes(defaultCandidate))
      ? defaultCandidate
      : 'pi';
  const enabled = enabledEngines.length ? enabledEngines : ['pi', 'agentscope', 'dsh'];
  const resolvedDefault = enabled.includes(defaultEngine) ? defaultEngine : enabled[0];
  return {
    meta: {
      sidecarPoolSize: Math.max(1, Number(raw.sidecarPoolSize) || 1),
      sidecarSharedMaxRuns: Math.max(1, Number(raw.sidecarSharedMaxRuns) || 8),
      enabledEngines: enabled,
      defaultEngine: resolvedDefault,
    },
  };
}

function mergeRuntimeSettings(value: unknown) {
  const envelope = isEnvelope(value) ? value : splitRuntimeSettings(value);
  const meta = asRecord(envelope.meta);
  const enabledRaw = Array.isArray(meta.enabledEngines) ? meta.enabledEngines : [];
  const enabledEngines = [...new Set(
    enabledRaw
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((id) => ['pi', 'agentscope', 'dsh', 'opencode', 'claude-code'].includes(id)),
  )];
  const enabled = enabledEngines.length ? enabledEngines : ['pi', 'agentscope', 'dsh'];
  const defaultCandidate = String(meta.defaultEngine || 'pi').trim().toLowerCase();
  const defaultEngine = enabled.includes(defaultCandidate) ? defaultCandidate : enabled[0];
  return {
    sidecarPoolSize: Math.max(1, Number(meta.sidecarPoolSize) || 1),
    sidecarSharedMaxRuns: Math.max(1, Number(meta.sidecarSharedMaxRuns) || 8),
    enabledEngines: enabled,
    defaultEngine,
  };
}

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  const ensureAuth = (request: Parameters<typeof requireAuth>[0]) => {
    request.auth = authenticateRequest(request);
  };

  app.get('/settings/model', async () => mergeModelSettings(readJson('model-settings')));
  app.put('/settings/model', async (request) => mergeModelSettings(writeJson('model-settings', splitModelSettings(request.body ?? {}))));

  app.get('/settings/search', async () => mergeSearchSettings(readJson('search-settings')));
  app.put('/settings/search', async (request) => mergeSearchSettings(writeJson('search-settings', splitSearchSettings(request.body ?? {}))));

  app.get('/settings/knowledge/providers', async () => mergeKnowledgeProviders(readJson('knowledge-providers')));
  app.put('/settings/knowledge/providers', async (request) => mergeKnowledgeProviders(writeJson('knowledge-providers', splitKnowledgeProviders(request.body ?? {}))));

  app.get('/settings/knowledge/bases', async () => mergeKnowledgeBases(readJson('knowledge-bases')));
  app.put('/settings/knowledge/bases', async (request) => mergeKnowledgeBases(writeJson('knowledge-bases', splitKnowledgeBases(request.body ?? []))));

  app.get('/settings/mcp/connections', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAuth(request);
      return mergeMcpConnections(readJson('mcp-connections'));
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });
  app.put('/settings/mcp/connections', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAdmin(request);
      return mergeMcpConnections(writeJson('mcp-connections', splitMcpConnections(request.body ?? [])));
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.get('/settings/capabilities/skills', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAuth(request);
      return readJson('capability-skills');
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });
  app.put('/settings/capabilities/skills', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAdmin(request);
      return writeJson('capability-skills', request.body ?? []);
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.get('/settings/capabilities/policies', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAuth(request);
      return readJson('capability-policies');
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });
  app.put('/settings/capabilities/policies', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAdmin(request);
      return writeJson('capability-policies', request.body ?? []);
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.get('/settings/runtime', async () => mergeRuntimeSettings(readJson('runtime-settings')));
  app.put('/settings/runtime', async (request) => mergeRuntimeSettings(writeJson('runtime-settings', splitRuntimeSettings(request.body ?? {}))));

  app.get('/settings/voice/realtime', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAuth(request);
      return publicRealtimeVoiceSettings();
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });
  app.put('/settings/voice/realtime', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAdmin(request);
      const input = asRecord(request.body);
      return publicRealtimeVoiceSettings(saveRealtimeVoiceSettings(input));
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });
  app.get('/settings/voice/input', async (request, reply) => {
    try { ensureAuth(request); requireAuth(request); return publicVoiceInputSettings(); }
    catch (error) { return sendAuthError(reply, error); }
  });
  app.put('/settings/voice/input', async (request, reply) => {
    try { ensureAuth(request); requireAdmin(request); return publicVoiceInputSettings(saveVoiceInputSettings(asRecord(request.body))); }
    catch (error) { return sendAuthError(reply, error); }
  });
  app.get('/settings/voice/conversation/migration-source', async (request, reply) => {
    try { ensureAuth(request); requireAdmin(request); return legacyRealtimeMigrationSource(); }
    catch (error) { return sendAuthError(reply, error); }
  });
  app.get('/settings/voice/conversation', async (request, reply) => {
    try { ensureAuth(request); requireAuth(request); return publicRealtimeConversationSettings(); }
    catch (error) { return sendAuthError(reply, error); }
  });
  app.put('/settings/voice/conversation', async (request, reply) => {
    try { ensureAuth(request); requireAdmin(request); return publicRealtimeConversationSettings(saveRealtimeConversationSettings(asRecord(request.body))); }
    catch (error) { return sendAuthError(reply, error); }
  });
  app.get('/settings/voice/preferences', async (request, reply) => {
    try { ensureAuth(request); requireAuth(request); return readVoicePreferences(); }
    catch (error) { return sendAuthError(reply, error); }
  });
  app.put('/settings/voice/preferences', async (request, reply) => {
    try { ensureAuth(request); requireAdmin(request); return saveVoicePreferences(asRecord(request.body)); }
    catch (error) { return sendAuthError(reply, error); }
  });

  app.get('/settings/storage/scan', async (request, reply) => {
    let auth;
    try { ensureAuth(request); auth = requireAuth(request); }
    catch (error) { return sendAuthError(reply, error); }
    try { return await scanStorageCleanup(auth); }
    catch (error) { return reply.code(500).send({ message: `空间扫描失败：${error instanceof Error ? error.message : String(error)}` }); }
  });
  app.post('/settings/storage/cleanup', async (request, reply) => {
    let auth;
    try { ensureAuth(request); requireAdmin(request); auth = requireAuth(request); }
    catch (error) { return sendAuthError(reply, error); }
    try { return await executeStorageCleanup(auth); }
    catch (error) { return reply.code(500).send({ message: `空间清理失败：${error instanceof Error ? error.message : String(error)}` }); }
  });

  app.get('/settings/components/pptx-enhanced', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAuth(request);
      return await pptxComponentStatus();
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });
  app.post('/settings/components/pptx-enhanced/install', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAdmin(request);
    } catch (error) {
      return sendAuthError(reply, error);
    }
    try {
      return await installPptxComponent();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ message: `PPTX 增强解析组件安装失败：${message}` });
    }
  });
  app.delete('/settings/components/pptx-enhanced', async (request, reply) => {
    try {
      ensureAuth(request);
      requireAdmin(request);
      fs.rmSync(pptxComponentPaths().root, { recursive: true, force: true });
      return await pptxComponentStatus();
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });
  app.get('/settings/components/docling-enhanced', async (request, reply) => {
    try { ensureAuth(request); requireAuth(request); return await doclingComponentStatus(); }
    catch (error) { return sendAuthError(reply, error); }
  });
  app.post('/settings/components/docling-enhanced/install', async (request, reply) => {
    try { ensureAuth(request); requireAdmin(request); }
    catch (error) { return sendAuthError(reply, error); }
    try { return await installDoclingComponent(); }
    catch (error) { return reply.code(500).send({ message: `Docling 增强解析组件安装失败：${error instanceof Error ? error.message : String(error)}` }); }
  });
  app.delete('/settings/components/docling-enhanced', async (request, reply) => {
    try { ensureAuth(request); requireAdmin(request); fs.rmSync(doclingComponentPaths().root, { recursive: true, force: true }); return await doclingComponentStatus(); }
    catch (error) { return sendAuthError(reply, error); }
  });
};
