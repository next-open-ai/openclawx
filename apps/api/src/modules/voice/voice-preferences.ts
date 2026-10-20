import { VoiceModeSchema } from '@openclawx/contracts';
import { readRealtimeVoiceSettings as readLegacySettings } from './legacy-settings.js';
import { readSettingsFile, writeSettingsFile } from './settings-files.js';
type VoicePreferences = { defaultMode: 'realtime' | 'input' };
const FILE = 'voice-preferences.json';
export function readVoicePreferences(): VoicePreferences { const saved = readSettingsFile<VoicePreferences>(FILE); if (saved) return { defaultMode: VoiceModeSchema.catch('realtime').parse(saved.defaultMode) }; return writeSettingsFile(FILE, { defaultMode: readLegacySettings().voiceMode }); }
export function saveVoicePreferences(input: Record<string, unknown>) { return writeSettingsFile(FILE, { defaultMode: VoiceModeSchema.parse(input.defaultMode ?? readVoicePreferences().defaultMode) }); }
