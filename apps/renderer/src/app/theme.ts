import { computed, ref } from 'vue';
import { readStored, writeStored } from './storage.js';

export const themeOptions = ['system', 'light', 'dark', 'midnight', 'aurora'] as const;
export type ThemePreference = (typeof themeOptions)[number];
type ResolvedTheme = Exclude<ThemePreference, 'system'>;

/** Sidebar quick-switch glyphs (one per preference). */
export const themeIconNames = {
  system: 'theme-system',
  light: 'theme-light',
  dark: 'theme-dark',
  midnight: 'theme-midnight',
  aurora: 'theme-aurora',
} as const satisfies Record<ThemePreference, string>;

/** @deprecated Use themeIconNames with SidebarIcon */
export const themeIcons: Record<ThemePreference, string> = {
  system: '◐',
  light: '○',
  dark: '●',
  midnight: '✦',
  aurora: '◈',
};

const storageKey = 'openclawx.theme-preference';
const preference = ref<ThemePreference>(readPreference());
const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

function readPreference(): ThemePreference { return 'system'; }

function resolveTheme(value: ThemePreference): ResolvedTheme {
  return value === 'system' ? (mediaQuery.matches ? 'dark' : 'light') : value;
}

function applyTheme(value: ThemePreference) {
  const resolved = resolveTheme(value);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = ['dark', 'midnight', 'aurora'].includes(resolved) ? 'dark' : 'light';
}

applyTheme(preference.value);

/** Renderer-only theme state: works in Electron and in a future browser build. */
export function useTheme() {
  const resolvedTheme = computed(() => resolveTheme(preference.value));

  const setTheme = (value: ThemePreference) => {
    preference.value = value;
    void writeStored(storageKey, value);
    applyTheme(value);
  };

  const loadTheme = async () => { const saved = await readStored(storageKey); if (themeOptions.includes(saved as ThemePreference)) setTheme(saved as ThemePreference); };

  const cycleTheme = () => {
    const index = themeOptions.indexOf(preference.value);
    setTheme(themeOptions[(index + 1) % themeOptions.length]);
  };

  return { preference, resolvedTheme, setTheme, loadTheme, cycleTheme };
}

mediaQuery.addEventListener('change', () => {
  if (preference.value === 'system') applyTheme('system');
});
