import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { ensureManagedMobileTls } from './tls-certificate.js';

export type MobileHttpsProxyConfig = {
  host: string;
  port: number;
  certFile: string;
  keyFile: string;
  publicOrigin: string;
  managedCaFile?: string;
};

const MOBILE_PATH_PREFIX = '/api/chat-mobile/';
const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function requiredFile(value: string | undefined, label: string) {
  const file = path.resolve(String(value || '').trim());
  if (!value?.trim() || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`${label} 不存在或不是文件。`);
  }
  return file;
}

function validPort(value: string | undefined, fallback: number) {
  const port = value?.trim() ? Number(value) : fallback;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('OPENCLAWX_MOBILE_HTTPS_PORT 必须是 1–65535 的端口。');
  return port;
}

export function resolveMobileHttpsProxyConfig(env: NodeJS.ProcessEnv = process.env): MobileHttpsProxyConfig | null {
  if (env.OPENCLAWX_MOBILE_HTTPS_ENABLED !== '1') return null;
  const lanHosts = Object.values(os.networkInterfaces()).flatMap(entries => entries || [])
    .filter(entry => !entry.internal && (String(entry.family) === 'IPv4' || String(entry.family) === '4'))
    .map(entry => entry.address);
  const port = validPort(env.OPENCLAWX_MOBILE_HTTPS_PORT, 47843);
  const publicOrigin = String(env.OPENCLAWX_MOBILE_PUBLIC_ORIGIN || `https://${lanHosts[0] || '127.0.0.1'}:${port}`).trim();
  let origin: URL;
  try { origin = new URL(publicOrigin); } catch { throw new Error('启用手机 HTTPS 时必须配置有效的 OPENCLAWX_MOBILE_PUBLIC_ORIGIN。'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('OPENCLAWX_MOBILE_PUBLIC_ORIGIN 必须是无路径、账号和查询参数的 HTTPS origin。');
  }
  const configuredCert = env.OPENCLAWX_MOBILE_HTTPS_CERT_FILE?.trim();
  const configuredKey = env.OPENCLAWX_MOBILE_HTTPS_KEY_FILE?.trim();
  if (Boolean(configuredCert) !== Boolean(configuredKey)) throw new Error('手机 HTTPS 证书和私钥必须同时配置。');
  const managed = configuredCert ? null : ensureManagedMobileTls([origin.hostname, ...lanHosts], env);
  return {
    host: String(env.OPENCLAWX_MOBILE_HTTPS_HOST || '0.0.0.0').trim() || '0.0.0.0',
    port,
    certFile: configuredCert ? requiredFile(configuredCert, '手机 HTTPS 证书') : managed!.certFile,
    keyFile: configuredKey ? requiredFile(configuredKey, '手机 HTTPS 私钥') : managed!.keyFile,
    publicOrigin: origin.origin,
    managedCaFile: managed?.caFile,
  };
}

export function isAllowedMobileHttpsRequest(method: string | undefined, rawUrl: string | undefined) {
  if (method !== 'GET' && method !== 'POST') return false;
  try { return new URL(rawUrl || '/', 'https://openclawx.invalid').pathname.startsWith(MOBILE_PATH_PREFIX); }
  catch { return false; }
}

function filteredHeaders(headers: http.IncomingHttpHeaders) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())));
}

export async function startMobileHttpsProxy(input: { config: MobileHttpsProxyConfig; apiPort: number }) {
  const { config, apiPort } = input;
  const server = https.createServer({
    cert: fs.readFileSync(config.certFile),
    key: fs.readFileSync(config.keyFile),
    minVersion: 'TLSv1.2',
  }, (request, response) => {
    if (!isAllowedMobileHttpsRequest(request.method, request.url)) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ message: 'Not Found' }));
      return;
    }
    const upstream = http.request({
      host: '127.0.0.1',
      port: apiPort,
      method: request.method,
      path: request.url,
      headers: {
        ...filteredHeaders(request.headers),
        host: `127.0.0.1:${apiPort}`,
        'x-forwarded-proto': 'https',
        'x-forwarded-host': new URL(config.publicOrigin).host,
      },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, filteredHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    });
    upstream.on('error', () => {
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ message: '手机对话服务暂不可用。' }));
      }
    });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address() as AddressInfo | null;
  return {
    origin: config.publicOrigin,
    address,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
