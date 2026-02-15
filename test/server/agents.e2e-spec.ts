import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../../src/server/database/database.module.js';
import { DatabaseService } from '../../src/server/database/database.service.js';
import { AgentsModule } from '../../src/server/agents/agents.module.js';
import { AgentsService } from '../../src/server/agents/agents.service.js';

jest.mock('../../src/core/agent/agent-manager.js', () => ({
    agentManager: { deleteSession: jest.fn(() => true) },
}));

describe('AgentsService (e2e, SQLite)', () => {
    let service: AgentsService;

    beforeAll(async () => {
        process.env.OPENBOT_DB_PATH = ':memory:';
        const module: TestingModule = await Test.createTestingModule({
            imports: [DatabaseModule, AgentsModule],
        }).compile();
        const db = module.get(DatabaseService);
        await db.onModuleInit();
        service = module.get<AgentsService>(AgentsService);
    });

    it('createSession returns session and persists', async () => {
        const session = await service.createSession({
            workspace: 'default',
            provider: 'deepseek',
            model: 'deepseek-chat',
            title: 'Test',
        });
        expect(session).toBeDefined();
        expect(session.id).toBeDefined();
        expect(session.workspace).toBe('default');
        expect(session.messageCount).toBe(0);
        expect(session.status).toBe('idle');

        const list = service.getSessions();
        expect(list.length).toBeGreaterThanOrEqual(1);
        const found = list.find((s) => s.id === session.id);
        expect(found).toBeDefined();
        expect(found?.title).toBe('Test');
    });

    it('getSession returns undefined for unknown id', () => {
        expect(service.getSession('non-existent-id')).toBeUndefined();
    });

    it('getMessageHistory returns empty for new session', async () => {
        const session = await service.createSession({});
        const history = service.getMessageHistory(session.id);
        expect(history).toEqual([]);
    });

    it('appendMessage adds message and updates session', async () => {
        const session = await service.createSession({});
        service.appendMessage(session.id, 'user', 'Hello');
        let history = service.getMessageHistory(session.id);
        expect(history.length).toBe(1);
        expect(history[0].role).toBe('user');
        expect(history[0].content).toBe('Hello');

        service.appendMessage(session.id, 'assistant', 'Hi there', { toolCalls: [] });
        history = service.getMessageHistory(session.id);
        expect(history.length).toBe(2);
        expect(history[1].role).toBe('assistant');

        const updated = service.getSession(session.id);
        expect(updated?.messageCount).toBe(2);
    });

    it('deleteSession removes session and history', async () => {
        const session = await service.createSession({});
        service.appendMessage(session.id, 'user', 'x');
        expect(service.getSession(session.id)).toBeDefined();
        expect(service.getMessageHistory(session.id).length).toBe(1);

        const deleted = await service.deleteSession(session.id);
        expect(deleted).toBe(true);
        expect(service.getSession(session.id)).toBeUndefined();
        expect(service.getMessageHistory(session.id)).toEqual([]);
    });
});
