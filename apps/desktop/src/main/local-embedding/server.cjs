const http = require('node:http');

function numberArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return Number(process.argv[index + 1]) || fallback;
}

function stringArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return String(process.argv[index + 1] || fallback);
}

const port = numberArg('--port', 11480);
const modelId = stringArg('--model-id', 'local-embedding-default');
const dimension = numberArg('--dimension', 1024);
const backendUrl = String(process.env.OPENCLAWX_LOCAL_EMBEDDING_BACKEND_URL || '').trim().replace(/\/$/, '');
const backendModel = String(process.env.OPENCLAWX_LOCAL_EMBEDDING_BACKEND_MODEL || '').trim();
const backendApiKey = String(process.env.OPENCLAWX_LOCAL_EMBEDDING_BACKEND_API_KEY || '').trim();

function backendReady() {
  return Boolean(backendUrl && backendModel);
}

function json(reply, status, body) {
  reply.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  reply.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const parts = [];
  for await (const chunk of request) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(parts).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (request, reply) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
  if (request.method === 'GET' && url.pathname === '/health') {
    return json(reply, 200, {
      ok: true,
      mode: backendReady() ? 'proxy' : 'bootstrap',
      ready: backendReady(),
      modelId,
      dimension,
      backendConfigured: backendReady(),
      backendUrl: backendUrl || undefined,
      backendModel: backendModel || undefined,
      pid: process.pid,
      checkedAt: Date.now(),
      message: backendReady()
        ? 'Local embedding sidecar proxy is running with a real embeddings backend.'
        : 'Local embedding sidecar bootstrap is running, but inference backend is not attached yet.',
    });
  }
  if (request.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    return json(reply, 200, {
      object: 'list',
      data: [
        {
          id: backendModel || modelId,
          object: 'model',
          owned_by: backendReady() ? 'openclawx-local-proxy' : 'openclawx-local-bootstrap',
        },
      ],
    });
  }
  if (request.method === 'POST' && url.pathname === '/v1/embeddings') {
    if (!backendReady()) {
      return json(reply, 503, {
        error: {
          code: 'EMBED_BOOTSTRAP_ONLY',
          message: 'Local embedding sidecar bootstrap is running, but embeddings backend is not attached yet.',
          type: 'service_unavailable',
        },
      });
    }
    try {
      const body = await readJsonBody(request);
      const response = await fetch(`${backendUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(backendApiKey ? { authorization: `Bearer ${backendApiKey}` } : {}),
        },
        body: JSON.stringify({
          ...body,
          model: backendModel,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const payload = await response.json().catch(() => null);
      return json(reply, response.status, payload || {
        error: {
          code: 'EMBED_BACKEND_INVALID_RESPONSE',
          message: 'Embedding backend did not return valid JSON.',
          type: 'bad_gateway',
        },
      });
    } catch (error) {
      return json(reply, 502, {
        error: {
          code: 'EMBED_BACKEND_UNREACHABLE',
          message: error instanceof Error ? error.message : 'Embedding backend is unreachable.',
          type: 'bad_gateway',
        },
      });
    }
  }
  return json(reply, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[local-embedding] bootstrap server listening on ${port}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
