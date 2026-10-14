import { defineConfig } from 'tsup';
const closureEntry = { 'parameter-project.test': 'src/modules/tasks/parameter-project.test.ts', 'project-application.test': 'src/modules/orchestration/project-application.test.ts', 'data-app-closure.test': 'src/modules/data/data-app-closure.test.ts', 'app-project.test': 'src/modules/data/app-project.test.ts', 'definition-routes.test': 'src/modules/orchestration/definition-routes.test.ts', 'workflow-runs.test': 'src/modules/orchestration/workflow-runs.test.ts' };
Object.assign(closureEntry, { 'live-data.test': 'src/modules/data/live-data.test.ts' });
Object.assign(closureEntry, { 'structured-query.test': 'src/modules/data/structured-query.test.ts' });
Object.assign(closureEntry, { 'query-relations.test': 'src/modules/data/query-relations.test.ts' });
Object.assign(closureEntry, { 'agent-query.test': 'src/modules/data/agent-query.test.ts' });
Object.assign(closureEntry, { 'app-query.test': 'src/modules/data/app-query.test.ts' });
Object.assign(closureEntry, { 'app-sql.test': 'src/modules/data/app-sql.test.ts' });
Object.assign(closureEntry, { 'schema-change.test': 'src/modules/data/schema-change.test.ts' });
Object.assign(closureEntry, { 'query-assets.test': 'src/modules/data/query-assets.test.ts' });
Object.assign(closureEntry, { 'experience-settings.test': 'src/modules/experience/routes.test.ts' });
Object.assign(closureEntry, { 'work-results.test': 'src/modules/work-results/service.test.ts' });
Object.assign(closureEntry, { 'barge-in.test': 'src/modules/voice/barge-in.test.ts' });
Object.assign(closureEntry, { 'database-secrets.test': 'src/modules/data/database-secrets.test.ts' });
Object.assign(closureEntry, { 'project-draft-files.test': 'src/modules/orchestration/project-draft-files.test.ts' });
export default defineConfig({
  // LDO isolation: dedicated process/data directory, no real business database.
  // Remote database tests use synthetic sessions; real-server acceptance is opt-in.
  entry: { ...closureEntry, 'project-instructions.test': 'src/modules/orchestration/project-instructions.test.ts', 'data-object.test': 'src/modules/data/data-object.test.ts', 'work-bridge.test': 'src/modules/voice/work-bridge.test.ts', 'context-assembler.test': 'src/modules/orchestration/context-assembler.test.ts', 'asr.test': 'src/modules/voice/asr.test.ts', 'settings-modularization.test': 'src/modules/voice/settings-modularization.test.ts', 'realtime-provider-adapters.test': 'src/modules/voice/realtime-provider-adapters.test.ts', 'mobile-voice.test': 'src/modules/chat-mobile/voice.test.ts', 'mobile-https-proxy.test': 'src/modules/chat-mobile/https-proxy.test.ts' }, format: ['esm'], platform: 'node', target: 'node22',
  outDir: 'test-dist', clean: true, noExternal: ['@workmate/contracts'], removeNodeProtocol: false,
});
