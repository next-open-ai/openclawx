import {
    authHookServerApi,
    authHookChannel,
    authHookSse,
    authHookWs,
} from '../../src/gateway/auth-hooks.js';

describe('Gateway auth hooks (placeholders)', () => {
    it('authHookServerApi calls next()', () => {
        const next = jest.fn();
        authHookServerApi(
            {} as any,
            {} as any,
            next,
        );
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('authHookChannel calls next()', () => {
        const next = jest.fn();
        authHookChannel(
            {} as any,
            {} as any,
            next,
        );
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('authHookSse calls next()', () => {
        const next = jest.fn();
        authHookSse(
            {} as any,
            {} as any,
            next,
        );
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('authHookWs returns true (allow)', () => {
        expect(authHookWs({} as any, '/ws')).toBe(true);
        expect(authHookWs({} as any, '/ws/voice')).toBe(true);
    });
});
