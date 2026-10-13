import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  // Contracts are part of the API's executable boundary, not a separate runtime package.
  noExternal: ['@workmate/contracts', '@workmate/agent-core', '@workmate/tools', '@workmate/orchestrator', 'node-sql-parser'],
  // Native addon; resolve at runtime from node_modules instead of bundling.
  external: ['@lancedb/lancedb'],
  // @mariozechner/pi-coding-agent is ESM and uses import.meta.url at module load.
  // Bundling into CJS leaves import.meta as {} unless we polyfill it here.
  banner: {
    js: 'var __import_meta_url = require("url").pathToFileURL(__filename).href;',
  },
  esbuildOptions(options) {
    options.define = {
      ...options.define,
      'import.meta.url': '__import_meta_url',
    };
  },
});
