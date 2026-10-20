import { createApp } from 'vue';
import App from './app/App.vue';
import { authSessionToken } from './app/auth';
import './styles/main.css';

const nativeFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const isApiRequest = requestUrl.startsWith('/api/')
    || requestUrl.startsWith('http://127.0.0.1:47832/api/')
    || requestUrl.startsWith('http://localhost:47832/api/');
  if (!isApiRequest) return nativeFetch(input, init);
  const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
  const token = authSessionToken();
  if (token && !headers.has('x-openclawx-session')) headers.set('x-openclawx-session', token);
  return nativeFetch(input, { ...init, headers });
};

createApp(App).mount('#app');
