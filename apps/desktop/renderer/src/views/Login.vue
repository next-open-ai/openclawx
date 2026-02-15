<template>
  <div class="login-view">
    <div class="login-bg" aria-hidden="true" />
    <div class="login-card">
      <header class="login-header">
        <div class="login-logo-wrap">
          <img src="@/assets/logo.svg" alt="OpenBot" class="login-logo" />
        </div>
        <h1 class="login-title">{{ t('login.title') }}</h1>
        <p class="login-subtitle">{{ t('login.subtitle') }}</p>
      </header>

      <form class="login-form" @submit.prevent="submit">
        <div class="form-group">
          <label for="login-username">{{ t('login.username') }}</label>
          <input
            id="login-username"
            v-model="username"
            type="text"
            class="form-input"
            :placeholder="t('login.usernamePlaceholder')"
            autocomplete="username"
          />
        </div>
        <div class="form-group">
          <label for="login-password">{{ t('login.password') }}</label>
          <input
            id="login-password"
            v-model="password"
            type="password"
            class="form-input"
            :placeholder="t('login.passwordPlaceholder')"
            autocomplete="current-password"
          />
        </div>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button type="submit" class="btn-login" :disabled="loading">
          {{ loading ? t('common.loading') : t('login.submit') }}
        </button>
      </form>

      <footer class="login-footer">
        <p class="login-default-credential">
          <span class="label">{{ t('login.defaultUser') }}:</span> admin &nbsp; <span class="label">{{ t('login.defaultPassword') }}:</span> 123456
        </p>
        <p class="login-hint">{{ t('login.defaultHint') }}</p>
      </footer>
    </div>
  </div>
</template>

<script>
import { ref } from 'vue';
import { useI18n } from '@/composables/useI18n';
import { useAuthStore } from '@/store/modules/auth';

export default {
  name: 'Login',
  setup() {
    const { t } = useI18n();
    const authStore = useAuthStore();
    const username = ref('admin');
    const password = ref('123456');
    const error = ref('');
    const loading = ref(false);

    async function submit() {
      error.value = '';
      loading.value = true;
      try {
        await authStore.login(username.value, password.value);
      } catch (e) {
        const msg = e.response?.data?.message ?? e.message ?? t('login.invalidCredentials');
        error.value = msg;
      } finally {
        loading.value = false;
      }
    }

    return { t, username, password, error, loading, submit };
  },
};
</script>

<style scoped>
.login-view {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-xl);
  z-index: 0;
}

.login-bg {
  position: absolute;
  inset: 0;
  background: linear-gradient(160deg, var(--color-bg-primary) 0%, var(--color-bg-secondary) 45%, var(--color-bg-tertiary) 100%);
  opacity: 0.99;
}

.login-bg::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    radial-gradient(ellipse 80% 50% at 50% -20%, rgba(99, 102, 241, 0.12) 0%, transparent 55%),
    radial-gradient(ellipse 60% 40% at 100% 100%, rgba(99, 102, 241, 0.06) 0%, transparent 50%);
  pointer-events: none;
}

.login-card {
  position: relative;
  width: 100%;
  max-width: 420px;
  padding: 2.5rem 2.75rem;
  border-radius: 24px;
  border: 1px solid var(--glass-border);
  background: var(--color-bg-primary);
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.04) inset,
    0 24px 48px -12px rgba(0, 0, 0, 0.25),
    0 12px 24px -8px rgba(0, 0, 0, 0.15);
}

/* Header：Logo + 标题 */
.login-header {
  text-align: center;
  margin-bottom: 2rem;
}

.login-logo-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 72px;
  height: 72px;
  margin: 0 auto 1.25rem;
  border-radius: 18px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--glass-border);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}

.login-logo {
  width: 40px;
  height: 40px;
  object-fit: contain;
}

.login-title {
  font-size: 1.5rem;
  font-weight: 700;
  margin: 0 0 0.25rem;
  color: var(--color-text-primary);
  letter-spacing: -0.025em;
  line-height: 1.3;
}

.login-subtitle {
  font-size: 0.875rem;
  color: var(--color-text-tertiary);
  margin: 0;
  font-weight: 400;
  letter-spacing: 0.01em;
}

/* 表单区 */
.login-form {
  margin-bottom: 1.5rem;
}

.form-group {
  margin-bottom: 1.25rem;
}

.form-group:last-of-type {
  margin-bottom: 1.5rem;
}

.form-group label {
  display: block;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--color-text-secondary);
  margin-bottom: 0.375rem;
  letter-spacing: 0.01em;
}

.form-input {
  display: block;
  width: 100%;
  height: 44px;
  padding: 0 1rem;
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  font-size: 0.9375rem;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
  box-sizing: border-box;
}

.form-input::placeholder {
  color: var(--color-text-tertiary);
}

.form-input:hover {
  border-color: var(--color-text-tertiary);
}

.form-input:focus {
  outline: none;
  border-color: var(--color-accent-primary);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.12);
}

.form-error {
  color: var(--color-error, #e53e3e);
  font-size: 0.8125rem;
  margin: 0 0 1rem;
  padding: 0.75rem 1rem;
  background: rgba(229, 62, 62, 0.08);
  border-radius: 10px;
  border: 1px solid rgba(229, 62, 62, 0.2);
  line-height: 1.4;
}

.btn-login {
  width: 100%;
  height: 44px;
  padding: 0 1.5rem;
  border: none;
  border-radius: 12px;
  background: var(--color-accent-primary);
  color: #fff;
  font-size: 0.9375rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: background-color 0.2s ease, transform 0.1s ease;
  box-shadow: 0 2px 8px rgba(99, 102, 241, 0.35);
}

.btn-login:hover:not(:disabled) {
  background: var(--color-accent-secondary, #5a67d8);
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
}

.btn-login:active:not(:disabled) {
  transform: scale(0.99);
}

.btn-login:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

/* 底部说明 */
.login-footer {
  padding-top: 1.25rem;
  border-top: 1px solid var(--glass-border);
}

.login-default-credential {
  font-size: 0.8125rem;
  color: var(--color-text-secondary);
  margin: 0 0 0.5rem;
  text-align: center;
  line-height: 1.5;
}

.login-default-credential .label {
  color: var(--color-text-tertiary);
  font-weight: 500;
}

.login-hint {
  font-size: 0.75rem;
  color: var(--color-text-tertiary);
  margin: 0;
  text-align: center;
  line-height: 1.5;
  max-width: 320px;
  margin-left: auto;
  margin-right: auto;
}
</style>
