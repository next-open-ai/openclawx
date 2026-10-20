import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const out = {
    write: false,
    dataDir: process.env.OPENCLAWX_DATA_DIR || path.join(os.homedir(), '.openclawx'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') out.write = true;
    else if (arg === '--data-dir' && argv[i + 1]) {
      out.dataDir = path.resolve(argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

function normalizeOwnerFields(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { changed: false, record };
  }
  const ownerUserId = typeof record.ownerUserId === 'string' && record.ownerUserId.trim()
    ? record.ownerUserId.trim()
    : typeof record.userId === 'string' && record.userId.trim()
      ? record.userId.trim()
      : '';
  if (!ownerUserId) return { changed: false, record };
  let changed = false;
  if (record.ownerUserId !== ownerUserId) {
    record.ownerUserId = ownerUserId;
    changed = true;
  }
  if (record.userId !== ownerUserId) {
    record.userId = ownerUserId;
    changed = true;
  }
  if (record.accessScope !== 'private' && record.accessScope !== 'org-shared' && record.accessScope !== 'delegated') {
    record.accessScope = 'private';
    changed = true;
  }
  if (!Array.isArray(record.accessGrants)) {
    record.accessGrants = [];
    changed = true;
  }
  return { changed, record };
}

function migrateDomain(domain) {
  const kv = domain?.kv;
  if (!kv || typeof kv !== 'object') {
    throw new Error('Invalid domain.json: missing kv object.');
  }

  const prefixes = ['sessions:', 'run:', 'projects:', 'project-run:'];
  const stats = {
    scanned: 0,
    changed: 0,
    byPrefix: {
      'sessions:': 0,
      'run:': 0,
      'projects:': 0,
      'project-run:': 0,
    },
  };

  for (const [key, raw] of Object.entries(kv)) {
    const prefix = prefixes.find((item) => key.startsWith(item));
    if (!prefix || typeof raw !== 'string') continue;
    stats.scanned += 1;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const { changed, record } = normalizeOwnerFields(parsed);
    if (!changed) continue;
    kv[key] = JSON.stringify(record);
    stats.changed += 1;
    stats.byPrefix[prefix] += 1;
  }

  return stats;
}

async function openSqlite(file) {
  const sqlJsRoot = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
  const initSqlJs = require(path.join(sqlJsRoot, 'sql-wasm.js'));
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(path.join(sqlJsRoot, 'sql-wasm.wasm')) });
  return new SQL.Database(fs.existsSync(file) ? fs.readFileSync(file) : undefined);
}

async function migrateAssetsDatabase(file, write) {
  if (!fs.existsSync(file)) {
    return { present: false, scanned: 0, changed: 0 };
  }

  const db = await openSqlite(file);
  const cols = new Set((db.exec('PRAGMA table_info(assets)')[0]?.values || []).map((row) => String(row[1])));
  if (!cols.size) {
    return { present: true, scanned: 0, changed: 0 };
  }
  if (!cols.has('owner_user_id') && write) db.run('ALTER TABLE assets ADD COLUMN owner_user_id TEXT');
  if (!cols.has('access_scope') && write) db.run(`ALTER TABLE assets ADD COLUMN access_scope TEXT DEFAULT 'private'`);
  if (!cols.has('access_grants') && write) db.run('ALTER TABLE assets ADD COLUMN access_grants TEXT');
  const ownerExpr = cols.has('owner_user_id') || write ? 'owner_user_id' : "''";
  const userExpr = cols.has('user_id') ? 'user_id' : "''";
  const scopeExpr = cols.has('access_scope') || write ? 'access_scope' : "''";
  const scanned = Number(db.exec(`SELECT COUNT(*) FROM assets`)[0]?.values?.[0]?.[0] || 0);
  const changed = Number(
    db.exec(
      `SELECT COUNT(*) FROM assets WHERE ((${ownerExpr} IS NULL OR ${ownerExpr} = '') AND ${userExpr} IS NOT NULL AND ${userExpr} != '') OR (${ownerExpr} IS NOT NULL AND ${ownerExpr} != '' AND (${userExpr} IS NULL OR ${userExpr} = '')) OR (${scopeExpr} IS NULL OR ${scopeExpr} = '')`,
    )[0]?.values?.[0]?.[0] || 0,
  );

  if (write) {
    if (!cols.has('user_id')) db.run('ALTER TABLE assets ADD COLUMN user_id TEXT');
    db.run(`UPDATE assets SET owner_user_id = user_id WHERE (owner_user_id IS NULL OR owner_user_id = '') AND user_id IS NOT NULL AND user_id != ''`);
    db.run(`UPDATE assets SET user_id = owner_user_id WHERE (user_id IS NULL OR user_id = '') AND owner_user_id IS NOT NULL AND owner_user_id != ''`);
    db.run(`UPDATE assets SET access_scope = 'private' WHERE access_scope IS NULL OR access_scope = ''`);
    db.run(`UPDATE assets SET access_grants = '[]' WHERE access_grants IS NULL OR access_grants = ''`);
    fs.writeFileSync(file, Buffer.from(db.export()), { mode: 0o600 });
  }

  return { present: true, scanned, changed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const domainFile = path.join(args.dataDir, 'domain.json');
  const sqliteFile = path.join(args.dataDir, 'openclawx.sqlite');
  if (!fs.existsSync(domainFile)) throw new Error(`domain.json not found: ${domainFile}`);

  const raw = fs.readFileSync(domainFile, 'utf8');
  const domain = JSON.parse(raw);
  const domainStats = migrateDomain(domain);
  const sqliteStats = await migrateAssetsDatabase(sqliteFile, false);

  if (!args.write) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      domainFile,
      sqliteFile,
      domain: domainStats,
      assets: sqliteStats,
      next: `Run: node scripts/migrate-owner-fields.mjs --write --data-dir ${args.dataDir}`,
    }, null, 2));
    return;
  }

  const timestamp = Date.now();
  const domainBackup = `${domainFile}.bak-${timestamp}`;
  fs.copyFileSync(domainFile, domainBackup);
  fs.writeFileSync(domainFile, JSON.stringify(domain), { mode: 0o600 });
  let sqliteBackup = null;
  if (fs.existsSync(sqliteFile)) {
    sqliteBackup = `${sqliteFile}.bak-${timestamp}`;
    fs.copyFileSync(sqliteFile, sqliteBackup);
  }
  const writtenAssets = await migrateAssetsDatabase(sqliteFile, true);
  console.log(JSON.stringify({
    mode: 'write',
    domainFile,
    domainBackup,
    sqliteFile,
    sqliteBackup,
    domain: domainStats,
    assets: writtenAssets,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
