import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import forge from 'node-forge';
import { isAllowedMobileHttpsRequest, resolveMobileHttpsProxyConfig } from './https-proxy.js';
import { ensureManagedMobileTls } from './tls-certificate.js';

test('MV-R3: scoped HTTPS proxy only accepts public mobile-chat GET/POST paths', () => {
  for (const target of ['/api/chat-mobile/token', '/api/chat-mobile/token/state?after=1', '/api/chat-mobile/token/voice/session']) {
    assert.equal(isAllowedMobileHttpsRequest('GET', target), true, target);
    assert.equal(isAllowedMobileHttpsRequest('POST', target), true, target);
  }
  for (const target of ['/api/chat/mobile-session', '/api/settings/voice/realtime', '/api/orch/sessions', '/', '/api/chat-mobile-evil/token']) {
    assert.equal(isAllowedMobileHttpsRequest('GET', target), false, target);
  }
  assert.equal(isAllowedMobileHttpsRequest('PUT', '/api/chat-mobile/token'), false);
});

test('MV-R3: HTTPS proxy configuration is opt-in and requires trusted TLS inputs', (t) => {
  assert.equal(resolveMobileHttpsProxyConfig({}), null);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclawx-mobile-tls-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const certFile = path.join(root, 'cert.pem'); const keyFile = path.join(root, 'key.pem');
  fs.writeFileSync(certFile, 'certificate'); fs.writeFileSync(keyFile, 'private-key');
  const config = resolveMobileHttpsProxyConfig({
    OPENCLAWX_MOBILE_HTTPS_ENABLED: '1',
    OPENCLAWX_MOBILE_PUBLIC_ORIGIN: 'https://192.168.1.8:47843',
    OPENCLAWX_MOBILE_HTTPS_CERT_FILE: certFile,
    OPENCLAWX_MOBILE_HTTPS_KEY_FILE: keyFile,
  });
  assert.equal(config?.port, 47843);
  assert.equal(config?.host, '0.0.0.0');
  assert.equal(config?.publicOrigin, 'https://192.168.1.8:47843');
  assert.throws(() => resolveMobileHttpsProxyConfig({ OPENCLAWX_MOBILE_HTTPS_ENABLED: '1', OPENCLAWX_MOBILE_PUBLIC_ORIGIN: 'http://example.com' }));
});

test('MV-R4: managed TLS creates a reusable CA and a server certificate with LAN SANs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclawx-managed-tls-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { OPENCLAWX_DATA_DIR: root };
  const first = ensureManagedMobileTls(['192.168.20.8'], env);
  const caBefore = fs.readFileSync(first.caFile, 'utf8');
  const leaf = forge.pki.certificateFromPem(fs.readFileSync(first.certFile, 'utf8'));
  const san = leaf.getExtension('subjectAltName') as { altNames?: Array<{ type: number; ip?: string; value?: string }> };
  assert.equal(san.altNames?.some(item => item.type === 7 && item.ip === '192.168.20.8'), true);
  assert.equal(san.altNames?.some(item => item.type === 2 && item.value === 'localhost'), true);

  const second = ensureManagedMobileTls(['192.168.20.9'], env);
  assert.equal(fs.readFileSync(second.caFile, 'utf8'), caBefore, 'LAN changes must not rotate the trusted CA');
  assert.equal(fs.statSync(second.keyFile).mode & 0o777, 0o600);
});
