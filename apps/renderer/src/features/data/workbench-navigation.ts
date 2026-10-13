import { ref, watch, type Ref } from 'vue';

/** In-memory UI location only; never retain rows, connection credentials or app tokens. */
export interface WorkbenchNavigation {
  sourceId: string | null;
  tableId: string | null;
  tab: 'overview' | 'schema' | 'preview' | 'analysis' | 'apps';
  category: 'all' | 'files' | 'sqlite' | 'mysql' | 'other';
  query: string;
}

export function useWorkbenchNavigation(scope: Readonly<Ref<string>>) {
  const navigation = ref<WorkbenchNavigation>();
  watch(scope, () => { navigation.value = undefined; }, { flush: 'sync' });
  function remember(value: WorkbenchNavigation, owner: string) {
    // An old page can unmount after logout or an account switch.
    if (owner && owner === scope.value) navigation.value = value;
  }
  return { navigation, remember };
}
