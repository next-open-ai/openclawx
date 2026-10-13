import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const apiPort = process.env.WORKMATE_API_PORT || '47832';
const apiEntry = path.join(repoRoot, 'apps', 'api', 'dist', 'main.cjs');
const dataDir = process.env.WORKMATE_DATA_DIR || path.join(homedir(), '.workmate');
const internalToken = process.env.WORKMATE_INTERNAL_TOKEN || randomBytes(24).toString('hex');
const supervisorKey = createHash('sha256').update(`${repoRoot}:${apiPort}`).digest('hex').slice(0, 16);
const supervisorLock = path.join(tmpdir(), `workmate-dev-${supervisorKey}.lock`);
let ownsSupervisorLock = false;

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function localLanAddresses() {
  return Object.values(networkInterfaces()).flatMap((entries) => entries || [])
    .filter((entry) => String(entry.family) === 'IPv4' && !entry.internal && entry.address)
    .map((entry) => entry.address);
}

async function hasLanApi() {
  for (const address of localLanAddresses()) {
    try {
      const response = await fetch(`http://${address}:${apiPort}/api/health`, { signal: AbortSignal.timeout(800) });
      if (response.ok) return true;
    } catch (_) { /* try the next interface */ }
  }
  return false;
}

function acquireSupervisorLock() {
  try {
    mkdirSync(supervisorLock, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let ownerPid = 0;
    try { ownerPid = Number(readFileSync(path.join(supervisorLock, 'pid'), 'utf8').trim()); } catch { /* stale/incomplete lock */ }
    if (processExists(ownerPid)) {
      console.error(`[workmate-dev] another supervisor is already running (pid=${ownerPid}). Stop it before starting a second npm run dev.`);
      process.exit(1);
    }
    rmSync(supervisorLock, { recursive: true, force: true });
    mkdirSync(supervisorLock, { mode: 0o700 });
  }
  writeFileSync(path.join(supervisorLock, 'pid'), `${process.pid}\n`, { mode: 0o600 });
  ownsSupervisorLock = true;
}

function releaseSupervisorLock() {
  if (!ownsSupervisorLock) return;
  ownsSupervisorLock = false;
  try { rmSync(supervisorLock, { recursive: true, force: true }); } catch { /* best effort */ }
}

acquireSupervisorLock();
process.once('exit', releaseSupervisorLock);

let vite;
let electron;
let api;
let stopping = false;
let restarting = false;
let restartTimer;
let apiBuildTimer;
let apiBuildInFlight = false;
let apiBuildQueued = false;

function run(command, args, options = {}) {
  return spawn(command, args, { cwd: repoRoot, stdio: 'inherit', ...options });
}

function stopChildTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { try { child.kill(signal); } catch { /* already stopped */ } }
}

function sharedEnv(extra = {}) {
  return {
    ...process.env,
    WORKMATE_API_PORT: apiPort,
    // Bind all interfaces so published data-app QR / LAN links work on the same Wi‑Fi.
    WORKMATE_API_HOST: process.env.WORKMATE_API_HOST || '0.0.0.0',
    WORKMATE_INTERNAL_TOKEN: internalToken,
    WORKMATE_DATA_DIR: dataDir,
    WORKMATE_SKILLS_DIR: path.join(dataDir, 'skills'),
    WORKMATE_WORKSPACES_DIR: path.join(dataDir, 'workspaces'),
    WORKMATE_KNOWLEDGE_DIR: path.join(dataDir, 'knowledge'),
    WORKMATE_EXPERIENCE_DIR: path.join(dataDir, 'experience'),
    WORKMATE_MOBILE_HTTPS_ENABLED: process.env.WORKMATE_MOBILE_HTTPS_ENABLED || '1',
    ...extra,
  };
}

async function waitForApi(timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/api/health`);
      if (response.ok) return;
    } catch (_) { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Workmate API did not become ready on :${apiPort}`);
}

function startApiProcess() {
  const replacingOwnedApi = Boolean(api && !api.killed);
  if (api && !api.killed) {
    try { api.kill('SIGTERM'); } catch (_) { /* ignore */ }
  }
  return (async () => {
    // Multiple `npm run dev` supervisors may coexist during desktop restarts.
    // Reuse a healthy API instead of binding a loopback-only second process,
    // whose in-memory sql.js snapshot would diverge from the LAN listener.
    if (!replacingOwnedApi) {
      let existingApi = false;
      try {
        const response = await fetch(`http://127.0.0.1:${apiPort}/api/health`, { signal: AbortSignal.timeout(800) });
        existingApi = response.ok;
      } catch (_) { /* no reusable API */ }
      if (existingApi) {
        if (!await hasLanApi()) {
          throw new Error(`An existing API on :${apiPort} is loopback-only. Stop the legacy Workmate dev process before restarting.`);
        }
          api = undefined;
          console.log(`[workmate-dev] reusing existing API on :${apiPort}`);
          return;
      }
    }
    console.log(`[workmate-dev] starting API on :${apiPort}`);
    api = spawn(process.execPath, [apiEntry], {
      cwd: repoRoot,
      env: sharedEnv({ WORKMATE_REQUIRE_DESKTOP_CREDENTIALS: '1' }),
      stdio: 'inherit',
    });
    api.on('exit', (code, signal) => {
      if (stopping) return;
      console.warn(`[workmate-dev] API exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    });
    await waitForApi();
  })();
}

function startElectron() {
  electron = run(pnpm, ['exec', 'electron', '.'], {
    cwd: desktopRoot,
    // Make the pnpm wrapper and the real Electron binary one process group so
    // hot restart cannot orphan the binary (and leave another Dock icon).
    detached: process.platform !== 'win32',
    env: sharedEnv({
      WORKMATE_RENDERER_URL: 'http://127.0.0.1:47831',
      // API is owned by this supervisor — Electron must not bind :47832 again.
      WORKMATE_API_EXTERNAL: '1',
    }),
  });
  electron.on('exit', (code, signal) => {
    if (restarting) { restarting = false; startElectron(); return; }
    if (!stopping) {
      console.log(`[workmate-dev] Electron exited code=${code ?? 'null'} signal=${signal ?? 'null'}; shutting down Vite/API`);
      stopping = true;
      vite?.kill('SIGTERM');
      api?.kill('SIGTERM');
      // Give children a moment, then force-exit the supervisor.
      setTimeout(() => process.exit(code ?? 0), 200);
    }
  });
}

function restartElectron() {
  if (!electron || restarting) return;
  restarting = true;
  stopChildTree(electron);
}

function rebuildApiAndRestart() {
  if (apiBuildInFlight) { apiBuildQueued = true; return; }
  apiBuildInFlight = true;
  const apiBuild = run(pnpm, ['--filter', '@workmate/api', 'build']);
  apiBuild.on('exit', (code) => {
    apiBuildInFlight = false;
    if (code === 0) {
      startApiProcess()
        .then(() => restartElectron())
        .catch((error) => {
          console.error('[workmate-dev] API restart failed:', error instanceof Error ? error.message : error);
        });
    } else {
      console.error('[workmate-dev] API rebuild failed; keeping the current API process running.');
    }
    if (apiBuildQueued) { apiBuildQueued = false; rebuildApiAndRestart(); }
  });
}

function watchApiSource() {
  const apiSource = path.join(repoRoot, 'apps', 'api', 'src');
  watch(apiSource, { recursive: process.platform !== 'linux' }, () => {
    clearTimeout(apiBuildTimer);
    apiBuildTimer = setTimeout(rebuildApiAndRestart, 220);
  });
}

function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  clearTimeout(apiBuildTimer);
  stopChildTree(electron);
  vite?.kill('SIGTERM');
  api?.kill('SIGTERM');
  // A supervisor with already-orphaned/missing children receives no child
  // `exit` event, so it used to stay alive forever and retain the dev lock.
  // Give owned children a short graceful window, then end the supervisor.
  setTimeout(() => process.exit(0), 300).unref();
}

async function waitForUrl(url, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(800) });
      // Vite may 404 some paths; any TCP response means the server is up.
      if (response.status > 0) return;
    } catch (_) { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function startUi() {
  vite = run(pnpm, ['--filter', '@workmate/renderer', 'dev']);
  const rendererUrl = 'http://127.0.0.1:47831/';
  console.log('[workmate-dev] waiting for Vite…');
  await waitForUrl(rendererUrl);
  console.log(`[workmate-dev] Vite ready at ${rendererUrl}`);
  startElectron();
  watchApiSource();
  watch(path.join(desktopRoot, 'src'), { recursive: process.platform !== 'linux' }, (_event, filename) => {
    if (!filename || !/^(main|preload)[/\\]/.test(filename)) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(restartElectron, 180);
  });
}

const build = run(pnpm, ['--filter', '@workmate/contracts', 'build']);
build.on('exit', (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const channelBuild = run(pnpm, ['--filter', '@workmate/channel', 'build']);
  channelBuild.on('exit', (channelCode) => {
    if (channelCode !== 0) process.exit(channelCode ?? 1);
    const gatewayBuild = run(pnpm, ['--filter', '@workmate/gateway', 'build']);
    gatewayBuild.on('exit', (gatewayCode) => {
      if (gatewayCode !== 0) process.exit(gatewayCode ?? 1);
      const agentBuild = run(pnpm, ['--filter', '@workmate/agent-core', 'build']);
      agentBuild.on('exit', (agentCode) => {
        if (agentCode !== 0) process.exit(agentCode ?? 1);
        const orchestratorBuild = run(pnpm, ['--filter', '@workmate/orchestrator', 'build']);
        orchestratorBuild.on('exit', (orchestratorCode) => {
          if (orchestratorCode !== 0) process.exit(orchestratorCode ?? 1);
          const apiBuild = run(pnpm, ['--filter', '@workmate/api', 'build']);
          apiBuild.on('exit', async (apiCode) => {
            if (apiCode !== 0) process.exit(apiCode ?? 1);
            try {
              // API before Vite: renderer can hit /api/* as soon as the page loads.
              await startApiProcess();
              console.log(`[workmate-dev] API ready on http://127.0.0.1:${apiPort}`);
              await startUi();
            } catch (error) {
              console.error('[workmate-dev]', error instanceof Error ? error.message : error);
              process.exit(1);
            }
          });
        });
      });
    });
  });
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
