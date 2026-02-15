import { PATHS } from '../../src/gateway/paths.js';

describe('Gateway PATHS', () => {
    it('defines distinct path for each module', () => {
        expect(PATHS.SERVER_API).toBe('/server-api');
        expect(PATHS.WS).toBe('/ws');
        expect(PATHS.WS_VOICE).toBe('/ws/voice');
        expect(PATHS.SSE).toBe('/sse');
        expect(PATHS.CHANNEL).toBe('/channel');
        expect(PATHS.HEALTH).toBe('/health');
        expect(PATHS.RUN_SCHEDULED_TASK).toBe('/run-scheduled-task');
    });

    it('has no duplicate values', () => {
        const values = Object.values(PATHS);
        const unique = new Set(values);
        expect(unique.size).toBe(values.length);
    });
});
