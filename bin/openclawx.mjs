#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { detectAgentscopeRuntime, ensureAgentscopeRuntime } from '../scripts/lib/agentscope-runtime.mjs';
import { startWebLauncher } from '../scripts/lib/web-launcher.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const command = process.argv[2] || 'start';
const args = new Set(process.argv.slice(3));

function printDoctor() {
  const info = detectAgentscopeRuntime(projectRoot);
  process.stdout.write(`OpenClawX ${packageJson.version}\n`);
  process.stdout.write(`projectRoot: ${projectRoot}\n`);
  process.stdout.write(`dataDir: ${info.dataDir}\n`);
  process.stdout.write(`runtimeSource: ${info.sourceRoot} (${info.hasSource ? 'ok' : 'missing'})\n`);
  process.stdout.write(`runtimeInstall: ${info.runtimeRoot} (${info.hasRuntime ? 'ok' : 'missing'})\n`);
  process.stdout.write(`runtimePython: ${info.python} (${info.hasPython ? 'ok' : 'missing'}${info.pythonVersion ? ` v${info.pythonVersion.major}.${info.pythonVersion.minor}.${info.pythonVersion.patch}` : ''})\n`);
  process.stdout.write(`basePython: ${info.basePython || 'missing'}\n`);
}

switch (command) {
  case 'version':
  case '--version':
  case '-v':
    process.stdout.write(`${packageJson.version}\n`);
    break;
  case 'doctor':
    printDoctor();
    break;
  case 'init': {
    const runtime = ensureAgentscopeRuntime(projectRoot, { reinstall: args.has('--reinstall') });
    process.stdout.write(`AgentScope runtime ready\nroot: ${runtime.runtimeRoot}\npython: ${runtime.python}\n`);
    break;
  }
  case 'start':
  default:
    await startWebLauncher(projectRoot, {
      reinstallRuntime: args.has('--reinstall-runtime'),
      engine: args.has('--pi') ? 'pi' : 'agentscope',
    });
    break;
}
