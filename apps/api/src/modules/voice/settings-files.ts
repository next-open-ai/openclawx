import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function voiceSettingsPath(name: string) {
  const root = process.env.OPENCLAWX_DATA_DIR || path.join(os.homedir(), '.openclawx');
  return path.join(root, name);
}
export function readSettingsFile<T>(name: string): Partial<T> | null {
  try { return JSON.parse(fs.readFileSync(voiceSettingsPath(name), 'utf8')) as Partial<T>; } catch { return null; }
}
export function writeSettingsFile<T>(name: string, value: T): T {
  const file = voiceSettingsPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  return value;
}
