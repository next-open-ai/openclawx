const { createServer } = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');

function createDatabaseCredentialStore({ safeStorage, get, set }) {
  return ({ key, operation, password }) => {
    if (typeof key !== 'string' || !/^[a-f0-9-]{36}$/.test(key) || !['read', 'write'].includes(operation)) throw new Error('invalid request');
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')) throw new Error('keyring unavailable');
    const storageKey = `secret.data-db.${key}`;
    if (operation === 'write') {
      if (typeof password !== 'string' || password.length > 4096) throw new Error('invalid credential');
      set(storageKey, safeStorage.encryptString(password).toString('base64'));
    }
    const encrypted = get(storageKey);
    const value = encrypted == null ? undefined : safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    if (operation === 'write' && value !== password) throw new Error('credential verification failed');
    return value;
  };
}

async function startDatabaseCredentialBridge(access) {
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const supplied = Buffer.from(String(req.headers.authorization || ''));
    const expected = Buffer.from(`Bearer ${token}`);
    if (req.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(403, { error: 'forbidden' });
    if (req.method !== 'POST' || req.url !== '/credential') return send(404, { error: 'not found' });
    req.setTimeout(5000, () => req.destroy());
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 32768) { send(413, { error: 'request too large' }); return; } chunks.push(chunk); }
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { return send(400, { error: 'invalid request' }); }
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['key', 'operation', 'password'].includes(k)) || typeof value.key !== 'string' || !/^[a-f0-9-]{36}$/.test(value.key) || !['read', 'write'].includes(value.operation) || (value.operation === 'write' && (typeof value.password !== 'string' || value.password.length > 4096))) return send(400, { error: 'invalid request' });
      const password = access(value);
      send(200, { ok: true, ...(password === undefined ? {} : { password }) });
    } catch { if (!res.headersSent && !res.destroyed) send(503, { error: 'secure credential storage unavailable' }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.unref();
  return { descriptor: { port: server.address().port, token }, close: () => { server.close(); server.closeAllConnections(); } };
}
module.exports = { createDatabaseCredentialStore, startDatabaseCredentialBridge };
