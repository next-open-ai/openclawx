import { storeToRefs } from 'pinia';
import { useLocaleStore } from '@/store/modules/locale';
import { computed } from 'vue';

export function useI18n() {
  const store = useLocaleStore();
  const { locale, messages } = storeToRefs(store);
  const t = (key) => store.t(key);
  const localeLabel = computed(() => store.localeLabel);
  return {
    t,
    locale,
    localeLabel,
    setLocale: store.setLocale.bind(store),
  };
}
