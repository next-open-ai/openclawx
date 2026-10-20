/**
 * Writes the channel gateway configuration into the orchestrator domain KV
 * (`channels.v1`). The desktop main process reads this key at startup and
 * forks the gateway when any channel is enabled.
 *
 * Usage (env vars):
 *   OPENCLAWX_API_PORT=47832 \
 *   OPENCLAWX_TG_BOT_TOKEN="123:ABC" \
 *   OPENCLAWX_GATEWAY_ALLOW="telegram:user:111111,telegram:chat:-100222222" \
 *   OPENCLAWX_DEFAULT_EMPLOYEE=general \
 *   node scripts/gateway-config.mjs
 *
 * Reads token from OPENCLAWX_TG_BOT_TOKEN_FILE when the token itself is set there
 * instead (avoids pasting secrets into shell history).
 */
const port = process.env.OPENCLAWX_API_PORT || '47832';
const base = `http://127.0.0.1:${port}/api/orch`;

import { readFileSync } from 'node:fs';

function token() {
  if (process.env.OPENCLAWX_TG_BOT_TOKEN) return process.env.OPENCLAWX_TG_BOT_TOKEN;
  const file = process.env.OPENCLAWX_TG_BOT_TOKEN_FILE;
  if (file) return readFileSync(file, 'utf8').trim();
  return '';
}

const botToken = token();
if (!botToken) {
  console.error('缺少 Telegram bot token：设置 OPENCLAWX_TG_BOT_TOKEN 或 OPENCLAWX_TG_BOT_TOKEN_FILE。');
  process.exit(2);
}
const allowlist = (process.env.OPENCLAWX_GATEWAY_ALLOW ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

const config = {
  version: 1,
  apiBaseUrl: base,
  defaultEmployeeId: process.env.OPENCLAWX_DEFAULT_EMPLOYEE || 'general',
  channels: {
    telegram: { enabled: true, botToken },
  },
  ...(allowlist.length ? { allowlist } : {}),
};

const response = await fetch(`${base}/kv`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key: 'channels.v1', value: JSON.stringify(config) }),
});
if (!response.ok) {
  console.error('写入 channels.v1 失败:', response.status);
  process.exit(1);
}
console.log('[gateway-config] channels.v1 已写入:', JSON.stringify({ defaultEmployeeId: config.defaultEmployeeId, channels: Object.keys(config.channels), allowlistEntries: allowlist.length }, null, 2));
console.log('[gateway-config] 重启桌面应用后，主进程将按此配置拉起网关子进程。');
