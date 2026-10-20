import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configureDatabaseCredentialBridge, databaseCredentialPersistence, databaseSecret } from './database-secrets.js';

const require = createRequire(import.meta.url);
const { createDatabaseCredentialStore, startDatabaseCredentialBridge } = require('../../desktop/src/main/database-credential-store.cjs');

if (process.env.OPENCLAWX_TEST_CREDENTIAL_CHILD === '1') {
  configureDatabaseCredentialBridge(JSON.parse(process.env.OPENCLAWX_TEST_BRIDGE!));
  const value = await databaseSecret(process.env.OPENCLAWX_TEST_KEY!, process.env.OPENCLAWX_TEST_PASSWORD);
  process.stdout.write(JSON.stringify({ value, persistence: databaseCredentialPersistence() }));
} else {
  test('LDO-R8: encrypted credentials survive API and desktop bridge restarts, empty password and unavailable storage', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'openclawx-credential-')), file = path.join(root, 'ciphertext.json');
    const cryptoKey = randomBytes(32), key = randomUUID();
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString(value: string) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', cryptoKey, iv); const encrypted = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]); },
      decryptString(value: Buffer) { const decipher = createDecipheriv('aes-256-gcm', cryptoKey, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(); },
    };
    const access = () => createDatabaseCredentialStore({ safeStorage, get: (id: string) => { try { return JSON.parse(readFileSync(file, 'utf8'))[id]; } catch { return undefined; } }, set: (id: string, value: string) => { let values = {}; try { values = JSON.parse(readFileSync(file, 'utf8')); } catch {} writeFileSync(file, JSON.stringify({ ...values, [id]: value }), { mode: 0o600 }); } });
    const child = (descriptor: object, password?: string) => new Promise<{ value?: string; persistence: string }>((resolve, reject) => {
      const proc = spawn(process.execPath, [process.argv[1]], { env: { ...process.env, OPENCLAWX_TEST_CREDENTIAL_CHILD: '1', OPENCLAWX_TEST_BRIDGE: JSON.stringify(descriptor), OPENCLAWX_TEST_KEY: key, ...(password === undefined ? {} : { OPENCLAWX_TEST_PASSWORD: password }) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; proc.stdout.on('data', c => { stdout += c; }); proc.on('error', reject); proc.on('exit', code => { if (code !== 0) reject(new Error('synthetic credential child failed')); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } } });
    });
    let bridge = await startDatabaseCredentialBridge(access());
    try {
      assert.equal((await child(bridge.descriptor, 'synthetic-secret')).persistence, 'desktop');
      assert.ok(!readFileSync(file, 'utf8').includes('synthetic-secret'));
      bridge.close(); bridge = await startDatabaseCredentialBridge(access());
      assert.equal((await child(bridge.descriptor)).value, 'synthetic-secret');
      await child(bridge.descriptor, ''); assert.equal((await child(bridge.descriptor)).value, '');
      const request = (body: unknown, token = bridge.descriptor.token, origin?: string) => fetch(`http://127.0.0.1:${bridge.descriptor.port}/credential`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
      assert.equal((await request({ key, operation: 'read' }, 'wrong')).status, 403);
      assert.equal((await request({ key, operation: 'read' }, bridge.descriptor.token, 'https://untrusted.example')).status, 403);
      assert.equal((await request({ key: '../outside', operation: 'read' })).status, 400);
      assert.equal((await request({ key, operation: 'write', password: 'x'.repeat(40000) })).status, 413);
      const unavailable = createDatabaseCredentialStore({ safeStorage: { ...safeStorage, isEncryptionAvailable: () => false }, get: () => undefined, set: () => { throw new Error('must not write plaintext'); } });
      assert.throws(() => unavailable({ key, operation: 'write', password: 'no' }), /keyring/);
      const broken = createDatabaseCredentialStore({ safeStorage, get: () => undefined, set: () => {} });
      assert.throws(() => broken({ key, operation: 'write', password: 'not-saved' }), /verification failed/);
    } finally { bridge.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('LDO-R8: migrate session-only password, persist updates, and fail closed when bridge disappears', async () => {
    const key = randomUUID(), values = new Map<string, string>();
    const previous = process.env.OPENCLAWX_REQUIRE_DESKTOP_CREDENTIALS;
    process.env.OPENCLAWX_REQUIRE_DESKTOP_CREDENTIALS = '1';
    try { await assert.rejects(databaseSecret(key, 'must-not-remain-in-memory'), /通道尚未就绪/); }
    finally { if (previous === undefined) delete process.env.OPENCLAWX_REQUIRE_DESKTOP_CREDENTIALS; else process.env.OPENCLAWX_REQUIRE_DESKTOP_CREDENTIALS = previous; }
    await databaseSecret(key, 'transient');
    const bridge = await startDatabaseCredentialBridge((input: { key: string; operation: string; password?: string }) => { if (input.password === 'reject') throw new Error('synthetic storage failure'); if (input.operation === 'write') values.set(input.key, input.password!); return values.get(input.key); });
    configureDatabaseCredentialBridge(bridge.descriptor);
    assert.equal(await databaseSecret(key), 'transient'); assert.equal(values.get(key), 'transient');
    await databaseSecret(key, 'updated'); assert.equal(values.get(key), 'updated');
    await assert.rejects(databaseSecret(key, 'reject'), /安全凭据存储不可用/); assert.equal(values.get(key), 'updated');
    bridge.close();
    await assert.rejects(databaseSecret(key), /安全凭据存储不可用/);
  });
}
