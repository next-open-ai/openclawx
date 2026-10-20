import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { FastifyPluginAsync } from 'fastify';
import { HealthResponseSchema } from '@openclawx/contracts';
import {
  DSH_ENV_FIX_TIMEOUT_MS,
  WORKSPACE_SCRAP_TOP_LEVEL,
  buildDshEnvironmentCheck,
  cleanManagedWorkspaceScrap,
  formatByteSize,
  formatPythonVersion,
  isDshEnvFixAction,
  resolveScriptPython,
  scanManagedWorkspaceScrap,
  scriptPythonHasPip,
  runDshEnvironmentFix,
  runDshEnvironmentFixWithProgress,
  workspacesRootDir,
  type DshInstallProgressEvent,
  type ScriptPythonDecision,
} from '@openclawx/agent-core';
import { getOrchestrator } from '../orchestration/routes.js';

type EnvCheckItem = {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'error';
  required: string;
  found: string;
  command?: string;
  help: string;
};

type EnvCheckReport = {
  platform: string;
  checks: EnvCheckItem[];
  summary: { total: number; ok: number; warn: number; error: number };
  checkedAt: number;
  /** Agent script Python selection after detection. */
  pythonDecision?: {
    source: ScriptPythonDecision['source'];
    command: string | null;
    version: string | null;
    reason: string;
    isolationNote: string;
    systemFound: string | null;
    bundledFound: string | null;
  };
  /** Agent process scrap under staging / project workspaces. */
  workspaceScrap?: {
    totalBytes: number;
    totalBytesLabel: string;
    stagingRoot: string;
    rootCount: number;
    entryCount: number;
    scrapNames: string[];
    manualHelp: string;
  };
};

function dataDir() {
  return process.env.OPENCLAWX_DATA_DIR || path.join(os.homedir(), '.openclawx');
}

function runtimeSourceRoot(projectRoot: string) {
  return path.join(projectRoot, 'runtimes', 'agentscope-runtime');
}

function installedRuntimePython(runtimeRoot: string) {
  return process.platform === 'win32'
    ? path.join(runtimeRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(runtimeRoot, '.venv', 'bin', 'python3');
}

function semverFirstTwo(text: string) {
  const match = String(text).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: match[3] ? Number(match[3]) : 0 } : null;
}

function execCapture(command: string, args: string[], timeoutMs = 8_000) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, env: process.env });
    return {
      code: result.status ?? 1,
      stdout: String(result.stdout || '').trim(),
      stderr: String(result.stderr || '').trim(),
    };
  } catch {
    return null;
  }
}

function readPythonVersion(command: string) {
  const args = command === 'py'
    ? ['-3', '-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}")']
    : ['-c', 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}")'];
  const result = execCapture(command, args, 8_000);
  if (!result || result.code !== 0) return null;
  const match = `${result.stdout}${result.stderr}`.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

function isSupportedPython(version: { major: number; minor: number; patch: number } | null) {
  return Boolean(version && version.major === 3 && version.minor >= 10);
}

function resolveBundledAgentscopeRuntime(projectRoot: string) {
  const roots = [
    process.env.OPENCLAWX_AGENTSCOPE_ROOT?.trim(),
    runtimeSourceRoot(projectRoot),
  ].filter(Boolean) as string[];
  const override = process.env.OPENCLAWX_AGENTSCOPE_PYTHON?.trim();
  if (override && fs.existsSync(override)) {
    const pythonVersion = readPythonVersion(override);
    if (isSupportedPython(pythonVersion)) {
      return { runtimeRoot: path.dirname(path.dirname(override)), python: override, pythonVersion };
    }
  }
  for (const runtimeRoot of roots) {
    const python = installedRuntimePython(runtimeRoot);
    const pythonVersion = fs.existsSync(python) ? readPythonVersion(python) : null;
    if (!fs.existsSync(python) || !isSupportedPython(pythonVersion)) continue;
    return { runtimeRoot, python, pythonVersion };
  }
  return null;
}

function platformLabel() {
  const base = process.platform === 'darwin'
    ? 'macOS'
    : process.platform === 'win32'
      ? 'Windows'
      : process.platform === 'linux'
        ? 'Linux'
        : process.platform;
  const inDocker = fs.existsSync('/.dockerenv') || process.env.container === 'docker';
  return inDocker ? `${base} / Docker` : `${base} / Web`;
}

async function listKnownProjectWorkspaceRoots(): Promise<string[]> {
  try {
    const projects = await getOrchestrator().projects.listProjects();
    return [...new Set(projects.map((project) => String(project.workspacePath || '').trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

function pythonInstallPlan() {
  const recommended = '3.12（同时满足 Agent 脚本 ≥3.9 与 AgentScope ≥3.10）';
  if (process.platform === 'darwin') {
    return {
      label: `Homebrew 安装 Python ${recommended}`,
      script: 'brew install python@3.12',
      command: 'brew',
      args: ['install', 'python@3.12'],
      timeoutMs: 10 * 60_000,
    };
  }
  if (process.platform === 'win32') {
    return {
      label: `winget 安装 Python ${recommended}`,
      script: 'winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements',
      command: 'winget',
      args: ['install', '-e', '--id', 'Python.Python.3.12', '--accept-package-agreements', '--accept-source-agreements'],
      timeoutMs: 10 * 60_000,
    };
  }
  return {
    label: `apt 安装 Python ${recommended}`,
    script: 'sudo apt update && sudo apt install -y python3 python3-pip python3-venv',
    command: 'apt-get',
    args: ['install', '-y', 'python3', 'python3-pip', 'python3-venv'],
    timeoutMs: 10 * 60_000,
  };
}

function scrapManualHelp(stagingRoot: string) {
  const names = WORKSPACE_SCRAP_TOP_LEVEL.join(' ');
  if (process.platform === 'win32') {
    return [
      `对话临时工作区：${stagingRoot}`,
      `可删除各 run 目录下的过程目录：${names}`,
      'PowerShell 示例：',
      `Get-ChildItem -Path "${stagingRoot}" -Recurse -Directory -Force | Where-Object { @(${WORKSPACE_SCRAP_TOP_LEVEL.map((n) => `'${n}'`).join(',')}) -contains $_.Name } | Remove-Item -Recurse -Force`,
      '项目工作区仅清理上述过程目录，勿整夹删除交付物。',
    ].join('\n');
  }
  return [
    `对话临时工作区：${stagingRoot}`,
    `可删除各 run / 项目根下过程目录：${names}`,
    'Shell 示例：',
    `find "${stagingRoot}" -mindepth 2 -maxdepth 2 \\( ${WORKSPACE_SCRAP_TOP_LEVEL.map((n) => `-name '${n}'`).join(' -o ')} \\) -exec rm -rf {} +`,
    '项目工作区请只删过程目录，保留交付文件；删除对话时会自动清理对应 staging。',
  ].join('\n');
}

async function buildEnvironmentReport(): Promise<EnvCheckReport> {
  const isWin = process.platform === 'win32';
  const items: EnvCheckItem[] = [];

  const nodeVersion = semverFirstTwo(process.versions.node);
  const nodeOk = Boolean(nodeVersion && nodeVersion.major >= 22);
  items.push({
    id: 'node',
    name: 'Node.js（运行时）',
    status: nodeOk ? 'ok' : 'error',
    required: '>= 22',
    found: `v${process.versions.node}`,
    help: nodeOk
      ? 'Web/API 运行形态依赖 Node 22+ 运行时。'
      : `当前 Node 为 v${process.versions.node}。请安装 Node.js 22+ 后重启服务。`,
  });

  items.push({
    id: 'launcher',
    name: 'Web / API 启动形态',
    status: 'ok',
    required: '可通过 HTTP 提供页面与 API',
    found: process.env.OPENCLAWX_WEB_STATIC_DIR?.trim() ? '静态页面 + API 已启用' : 'API 模式',
    help: process.env.OPENCLAWX_WEB_STATIC_DIR?.trim()
      ? '当前进程同时托管前端静态页与 API，适用于 npm Web Launcher 与 Docker。'
      : '当前进程仅提供 API；若需完整 Web 界面，请同时提供前端静态构建目录。',
  });

  const decision = resolveScriptPython();
  const system = decision.system;
  const systemOk = Boolean(system && system.version.major === 3 && system.version.minor >= 9);
  items.push({
    id: 'python',
    name: '系统 Python 3',
    status: systemOk ? 'ok' : decision.source === 'bundled' ? 'warn' : 'error',
    required: '3.9+（优先用于 Agent 自编脚本）',
    found: system ? `${system.command} ${formatPythonVersion(system.version)}` : '未检测到可用的 Python 3',
    command: system ? `${system.command} --version` : undefined,
    help: systemOk
      ? `系统 Python 可用。Agent 自编脚本将优先使用：${system?.command}。`
      : decision.source === 'bundled'
        ? '系统 Python 不可用或不满足 3.9+；将回退预装 agentscope-runtime 解释器执行 Agent 脚本（依赖仍隔离到工作区）。'
        : isWin
          ? '未找到满足 3.9+ 的系统 Python。可安装后重启，或依赖安装包内预装 runtime。'
          : process.platform === 'darwin'
            ? '未找到满足 3.9+ 的系统 Python。推荐：brew install python@3.12；或依赖预装 runtime。'
            : '未找到满足 3.9+ 的系统 Python。推荐：sudo apt install -y python3 python3-pip；或依赖预装 runtime。',
  });

  const scriptCommand = decision.command;
  let pipOk = false;
  let pipFound = '未检测到 pip';
  if (scriptCommand) {
    pipOk = scriptPythonHasPip(scriptCommand);
    pipFound = pipOk ? `${scriptCommand} -m pip` : '当前选用的解释器无法执行 python -m pip';
  }
  items.push({
    id: 'pip',
    name: 'pip（隔离安装到工作区）',
    status: pipOk ? 'ok' : 'error',
    required: '可用（选用解释器 -m pip）',
    found: pipFound,
    help: pipOk
      ? '依赖通过 pip install --target <工作区>/.python-packages 安装，不污染 agentscope-runtime。'
      : scriptCommand
        ? '当前选用的 Python 无可用 pip。可尝试 ensurepip，或改用带 pip 的解释器。'
        : '需先有可用的脚本 Python（系统 3.9+ 或预装 runtime）。',
  });

  const sourceLabel =
    decision.source === 'system' ? '系统 Python'
      : decision.source === 'bundled' ? '预装 agentscope-runtime'
        : decision.source === 'override' ? 'OPENCLAWX_PYTHON 覆盖'
          : '无可用解释器';
  items.push({
    id: 'python-script-env',
    name: 'Agent 脚本 Python（当前决策）',
    status: decision.source === 'none' ? 'error' : decision.source === 'bundled' ? 'warn' : 'ok',
    required: '系统 3.9+ 优先，否则预装 runtime',
    found: decision.command
      ? `${sourceLabel} · ${decision.command} ${formatPythonVersion(decision.version)}`
      : '未选定',
    command: decision.command || undefined,
    help: `${decision.reason}\n${decision.isolationNote}`,
  });

  const bundled = resolveBundledAgentscopeRuntime(process.cwd());
  const agentscopeVersion = bundled?.pythonVersion ?? system?.version ?? null;
  const agentscopePython = bundled ? { command: bundled.python, version: bundled.pythonVersion } : system;
  const agentscopeOk = Boolean(agentscopeVersion && agentscopeVersion.major === 3 && agentscopeVersion.minor >= 10);
  items.push({
    id: 'agentscope-python',
    name: 'AgentScope 引擎 Runtime',
    status: agentscopeOk ? 'ok' : 'error',
    required: '>= 3.10（引擎专用；与脚本依赖隔离）',
    found: bundled
      ? `内置 ${bundled.python}${bundled.pythonVersion ? ` ${formatPythonVersion(bundled.pythonVersion)}` : ''}`
      : agentscopePython && agentscopePython.version
        ? `${agentscopePython.command} ${formatPythonVersion(agentscopePython.version)}`
        : `未检测到 AgentScope 可用 Python（查找目录 ${runtimeSourceRoot(process.cwd())}）`,
    command: bundled?.python || (agentscopePython ? `${agentscopePython.command} --version` : undefined),
    help: bundled
      ? `AgentScope Sidecar 使用：${bundled.runtimeRoot}。Agent 自编脚本即使回退到该解释器，也不得向此环境 pip install（仅 --target 工作区）。`
      : agentscopeOk
        ? '未发现内置 runtime，引擎将回退到系统 Python 3.10+。'
        : 'AgentScope 运行时需要 Python 3.10+；Docker 镜像建议预装，npm Web 启动可使用系统 Python。',
  });

  const git = execCapture('git', ['--version'], 5_000);
  const gitOk = Boolean(git && git.code === 0);
  items.push({
    id: 'git',
    name: 'Git（Skills 仓库导入/克隆）',
    status: gitOk ? 'ok' : 'error',
    required: '可用（git --version）',
    found: gitOk ? (git?.stdout || git?.stderr || 'git') : '未检测到 git',
    help: gitOk
      ? '用于拉取或导入 Skills 仓库。'
      : process.platform === 'darwin'
        ? '未检测到 git。可执行 xcode-select --install，或 brew install git。'
        : isWin
          ? '未检测到 git。请安装 Git for Windows 并加入 PATH。'
          : '未检测到 git。Debian/Ubuntu: sudo apt install -y git；Fedora: sudo dnf install git。',
  });

  const npx = execCapture(isWin ? 'npx.cmd' : 'npx', ['--version'], 8_000);
  const npxOk = Boolean(npx && npx.code === 0);
  items.push({
    id: 'npx',
    name: 'npx（Skills 生态安装器）',
    status: npxOk ? 'ok' : 'warn',
    required: '可用（随 Node 提供）',
    found: npxOk ? `v${npx?.stdout || npx?.stderr || ''}`.trim() || 'npx' : '未检测到 npx',
    help: npxOk ? '用于安装公开 Skill 包。' : '未检测到 npx。通常随 Node.js 一起提供，可通过重装 Node 修复。',
  });

  let storageOk = true;
  let storageFound = dataDir();
  try {
    fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    const probe = path.join(dataDir(), '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
  } catch (error) {
    storageOk = false;
    storageFound = error instanceof Error ? error.message : String(error);
  }
  items.push({
    id: 'storage',
    name: '本地数据目录',
    status: storageOk ? 'ok' : 'error',
    required: '可读写',
    found: storageOk ? dataDir() : storageFound,
    help: storageOk
      ? '会话、项目、资产、通道配置与运行时数据都保存在该目录。'
      : `无法写入 ${dataDir()}。请检查卷挂载、磁盘空间或目录权限。`,
  });

  items.push(buildDshEnvironmentCheck());

  const projectRoots = await listKnownProjectWorkspaceRoots();
  const scrapScan = await scanManagedWorkspaceScrap(projectRoots);
  const scrapNames = [...WORKSPACE_SCRAP_TOP_LEVEL];
  const scrapEntryCount = scrapScan.reports.reduce((sum, report) => sum + report.entries.length, 0);
  const scrapOk = scrapScan.totalBytes === 0;
  items.push({
    id: 'workspace-scrap',
    name: '工作区临时脚本 / 依赖',
    status: scrapOk ? 'ok' : 'warn',
    required: '过程物可清理（scripts / .python-packages 等）',
    found: scrapOk
      ? '未发现可清理过程物'
      : `${formatByteSize(scrapScan.totalBytes)} · ${scrapScan.reports.length} 个工作区 · ${scrapEntryCount} 项`,
    help: scrapOk
      ? `删除对话会清理对应 staging；删除项目会清理过程目录（保留交付物）。过程目录：${scrapNames.join(', ')}。`
      : `可一键清理 Agent 临时脚本与隔离依赖。若自动清理失败，请按下方手动方式处理。\n${scrapManualHelp(scrapScan.stagingRoot)}`,
  });

  const summary = {
    total: items.length,
    ok: items.filter((item) => item.status === 'ok').length,
    warn: items.filter((item) => item.status === 'warn').length,
    error: items.filter((item) => item.status === 'error').length,
  };
  return {
    platform: platformLabel(),
    checks: items,
    summary,
    checkedAt: Date.now(),
    pythonDecision: {
      source: decision.source,
      command: decision.command,
      version: formatPythonVersion(decision.version) || null,
      reason: decision.reason,
      isolationNote: decision.isolationNote,
      systemFound: decision.system
        ? `${decision.system.command} ${formatPythonVersion(decision.system.version)}`
        : null,
      bundledFound: decision.bundled
        ? `${decision.bundled.command} ${formatPythonVersion(decision.bundled.version)}`
        : null,
    },
    workspaceScrap: {
      totalBytes: scrapScan.totalBytes,
      totalBytesLabel: formatByteSize(scrapScan.totalBytes),
      stagingRoot: scrapScan.stagingRoot || workspacesRootDir(),
      rootCount: scrapScan.reports.length,
      entryCount: scrapEntryCount,
      scrapNames,
      manualHelp: scrapManualHelp(scrapScan.stagingRoot || workspacesRootDir()),
    },
  };
}

type EnvFixActionId =
  | 'fix-storage'
  | 'fix-pip'
  | 'fix-agentscope'
  | 'fix-dsh'
  | 'install-python'
  | 'clean-workspace-scrap';

function runFixStorage() {
  const root = dataDir();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(root, 0o700);
  } catch {
    /* Windows may ignore chmod */
  }
  const probe = path.join(root, '.write-probe');
  fs.writeFileSync(probe, 'ok');
  fs.rmSync(probe, { force: true });
  return { ok: true as const, message: `数据目录已就绪：${root}`, detail: root };
}

function runFixPip() {
  const decision = resolveScriptPython();
  const command = decision.command;
  if (!command) throw new Error('未找到可用的脚本 Python，无法执行 ensurepip。请安装系统 Python 3.9+ 或提供预装 runtime。');
  const args = command === 'py' ? ['-3', '-m', 'ensurepip', '--upgrade'] : ['-m', 'ensurepip', '--upgrade'];
  const result = execCapture(command, args, 60_000);
  if (!result || result.code !== 0) {
    throw new Error(`ensurepip 失败：${result?.stderr || result?.stdout || 'unknown error'}`);
  }
  return {
    ok: true as const,
    message: `已对脚本解释器执行 ${command} -m ensurepip --upgrade`,
    detail: result.stdout || result.stderr || '',
  };
}

function runFixAgentscope() {
  const entry = path.join(process.cwd(), 'bin', 'openclawx.mjs');
  if (!fs.existsSync(entry)) {
    throw new Error(`找不到 OpenClawX CLI：${entry}。请在项目根目录启动服务后再试。`);
  }
  const result = spawnSync(process.execPath, [entry, 'init'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10 * 60_000,
    env: process.env,
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`AgentScope runtime 初始化失败：${String(result.stderr || result.stdout || 'unknown error').slice(-1200)}`);
  }
  return {
    ok: true as const,
    message: 'AgentScope runtime 已初始化（openclawx init）',
    detail: String(result.stdout || '').trim().slice(0, 1200),
  };
}

function runInstallPython() {
  const inDocker = fs.existsSync('/.dockerenv') || process.env.container === 'docker';
  const plan = pythonInstallPlan();
  if (inDocker) {
    throw new Error(
      `Docker 环境请在镜像中预装 Python，勿在运行中自动安装。建议写入 Dockerfile：\nRUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv\n主机也可手动执行：${plan.script}`,
    );
  }
  const result = spawnSync(plan.command, plan.args, {
    encoding: 'utf8',
    timeout: plan.timeoutMs,
    env: process.env,
    shell: process.platform === 'win32',
  });
  if ((result.status ?? 1) !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || 'unknown error').slice(-1500);
    throw new Error(
      `尝试安装系统 Python 失败（${plan.label}）。请在终端手动执行：\n${plan.script}\n\n详情：${detail}`,
    );
  }
  return {
    ok: true as const,
    message: `已尝试安装：${plan.label}。请重新打开终端/应用后再跑环境检查。`,
    detail: String(result.stdout || result.stderr || '').trim().slice(0, 1200) || plan.script,
  };
}

async function runCleanWorkspaceScrap() {
  const projectRoots = await listKnownProjectWorkspaceRoots();
  const result = await cleanManagedWorkspaceScrap(projectRoots);
  if (result.failedCount > 0 && result.freedBytes === 0) {
    throw new Error(
      `自动清理失败（${result.failedCount} 项）。请按环境报告中的手动清理说明处理。\n${scrapManualHelp(workspacesRootDir())}`,
    );
  }
  const message = result.freedBytes > 0
    ? `已清理约 ${formatByteSize(result.freedBytes)} 临时脚本/依赖${result.failedCount ? `（另有 ${result.failedCount} 项失败，见手动清理说明）` : ''}`
    : '未发现可清理的过程物';
  return {
    ok: true as const,
    message,
    detail: result.results
      .filter((item) => item.removed.length || item.failed.length)
      .map((item) => `${item.root}: removed=${item.removed.join(',') || '-'}; failed=${item.failed.map((f) => f.relative).join(',') || '-'}`)
      .join('\n')
      .slice(0, 1500),
  };
}

async function runEnvironmentFix(actionId: string) {
  if (actionId === 'fix-storage') return runFixStorage();
  if (actionId === 'fix-pip') return runFixPip();
  if (actionId === 'fix-agentscope') return runFixAgentscope();
  if (actionId === 'install-python') return runInstallPython();
  if (actionId === 'clean-workspace-scrap') return runCleanWorkspaceScrap();
  if (isDshEnvFixAction(actionId)) return runDshEnvironmentFix({ reinstall: true });
  throw new Error(
    `不支持的修复动作：${actionId}（仅允许 fix-storage / fix-pip / fix-agentscope / fix-dsh / install-python / clean-workspace-scrap）`,
  );
}

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => HealthResponseSchema.parse({
    status: 'ok',
    service: 'openclawx-api',
    version: process.env.npm_package_version ?? '0.1.0',
  }));
  app.get('/environment', async () => buildEnvironmentReport());
  app.post('/environment/fix', async (request, reply) => {
    const body = (request.body ?? {}) as { actionId?: string };
    const actionId = String(body.actionId || '').trim() as EnvFixActionId | '';
    if (!actionId) return reply.code(400).send({ message: '缺少 actionId' });
    try {
      // Prefer streaming endpoint for dsh; keep sync fallback for simple clients.
      if (isDshEnvFixAction(actionId)) {
        request.raw.setTimeout(DSH_ENV_FIX_TIMEOUT_MS);
        reply.raw.setTimeout(DSH_ENV_FIX_TIMEOUT_MS);
      }
      const result = await runEnvironmentFix(actionId);
      return { ...result, actionId, report: await buildEnvironmentReport() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ message, actionId });
    }
  });
  app.post('/environment/dsh/install', async (request, reply) => {
    const body = (request.body ?? {}) as { reinstall?: boolean };
    const reinstall = Boolean(body.reinstall);
    request.raw.setTimeout(DSH_ENV_FIX_TIMEOUT_MS);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (payload: Record<string, unknown>) => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const onProgress = (event: DshInstallProgressEvent) => {
      send(event);
    };

    try {
      const result = await runDshEnvironmentFixWithProgress({ reinstall, onProgress });
      send({
        type: 'complete',
        ok: true,
        message: result.message,
        detail: result.detail,
        skipped: result.skipped,
        actionId: 'fix-dsh',
        report: await buildEnvironmentReport(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send({ type: 'error', ok: false, message, actionId: 'fix-dsh' });
    } finally {
      reply.raw.end();
    }
  });
};
