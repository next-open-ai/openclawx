/**
 * Gateway 内嵌 Nest、按 path 分流 e2e（Node 执行，依赖 dist）。
 * 运行：npm run build && node test/gateway/server.e2e.mjs
 */
import { startGatewayServer } from '../../dist/gateway/server.js';
import { PATHS } from '../../dist/gateway/paths.js';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
    process.env.OPENBOT_DB_PATH = process.env.OPENBOT_DB_PATH || ':memory:';

    const { port, close } = await startGatewayServer(0);
    const baseUrl = `http://localhost:${port}`;
    let passed = 0;
    let failed = 0;

    try {
        let res = await fetch(`${baseUrl}${PATHS.HEALTH}`);
        if (res.status === 200) {
            const body = await res.json();
            if (body.status === 'ok') {
                passed++;
                console.log('✓ GET /health 200 ok');
            } else {
                failed++;
                console.log('✗ GET /health body.status !== ok');
            }
        } else {
            failed++;
            console.log('✗ GET /health status', res.status);
        }

        res = await fetch(`${baseUrl}${PATHS.SSE}`);
        if (res.status === 501) {
            passed++;
            console.log('✓ GET /sse 501');
        } else {
            failed++;
            console.log('✗ GET /sse status', res.status);
        }

        res = await fetch(`${baseUrl}${PATHS.CHANNEL}`);
        if (res.status === 501) {
            passed++;
            console.log('✓ GET /channel 501');
        } else {
            failed++;
            console.log('✗ GET /channel status', res.status);
        }

        res = await fetch(`${baseUrl}${PATHS.SERVER_API}/config`);
        if (res.status === 200 || res.status === 401) {
            passed++;
            console.log('✓ GET /server-api/config', res.status);
        } else {
            failed++;
            console.log('✗ GET /server-api/config status', res.status);
        }

        const wsUrl = baseUrl.replace(/^http/, 'ws') + PATHS.WS;
        const ws = new WebSocket(wsUrl);
        await new Promise((resolve, reject) => {
            ws.on('open', () => resolve());
            ws.on('error', reject);
        });
        ws.close();
        passed++;
        console.log('✓ WebSocket /ws upgrade');

        const voiceUrl = baseUrl.replace(/^http/, 'ws') + PATHS.WS_VOICE;
        const voiceWs = new WebSocket(voiceUrl);
        let got501 = false;
        await new Promise((resolve) => {
            const t = setTimeout(() => resolve(), 5000);
            voiceWs.on('unexpected-response', (_req, res) => {
                got501 = res.statusCode === 501;
                clearTimeout(t);
                resolve();
            });
            voiceWs.on('open', () => {
                clearTimeout(t);
                resolve();
            });
            voiceWs.on('error', () => {
                clearTimeout(t);
                resolve();
            });
        });
        voiceWs.close();
        if (got501) {
            passed++;
            console.log('✓ WebSocket /ws/voice 501');
        } else {
            failed++;
            console.log('✗ WebSocket /ws/voice expected 501');
        }
    } finally {
        await close();
    }

    console.log('');
    console.log(`Result: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
