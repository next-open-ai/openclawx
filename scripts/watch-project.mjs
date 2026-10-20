/**
 * Watch a project's orchestration events (SSE) — QA + future channel-gateway
 * reference. Requires the local API running (see scripts/*.mjs docs).
 *
 * Usage: OPENCLAWX_API_PORT=47832 node scripts/watch-project.mjs <projectId>
 */
import process from 'node:process';

const port = process.env.OPENCLAWX_API_PORT || '47832';
const projectId = process.argv[2];
if (!projectId) {
  console.error('Usage: node scripts/watch-project.mjs <projectId>');
  process.exit(2);
}

const url = `http://127.0.0.1:${port}/api/orch/events?project=${encodeURIComponent(projectId)}`;

const response = await fetch(url);
if (!response.ok || !response.body) {
  console.error('SSE failed:', response.status, response.statusText);
  process.exit(1);
}
console.log(`[watch] connected to ${url}`);
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const events = buffer.split('\n\n');
  buffer = events.pop() ?? '';
  for (const chunk of events) {
    if (!chunk.startsWith('data: ')) continue;
    try {
      const event = JSON.parse(chunk.slice(6));
      console.log(`[event] ${event.type}`, JSON.stringify(event).slice(0, 400));
    } catch {
      /* heartbeat or partial */
    }
  }
}
console.log('[watch] stream closed');
