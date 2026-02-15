import { defineStore } from 'pinia';
import { authAPI } from '@/api';

const STORAGE_KEY = 'openbot_logged_in';
const CURRENT_USER_KEY = 'openbot_current_user';

function readLoggedIn() {
    try {
        return sessionStorage.getItem(STORAGE_KEY) === '1';
    } catch {
        return false;
    }
}

function readCurrentUser() {
    try {
        const raw = sessionStorage.getItem(CURRENT_USER_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        return data && data.id && data.username ? data : null;
    } catch {
        return null;
    }
}

export const useAuthStore = defineStore('auth', {
    state: () => ({
        isLoggedIn: readLoggedIn(),
        currentUser: readCurrentUser(),
    }),

    actions: {
        initFromStorage() {
            this.isLoggedIn = readLoggedIn();
            this.currentUser = readCurrentUser();
        },

        async login(username, password) {
            const res = await authAPI.login(username || '', password || '');
            this.isLoggedIn = true;
            const user = res.data?.user ?? null;
            this.currentUser = user;
            try {
                sessionStorage.setItem(STORAGE_KEY, '1');
                if (user) {
                    sessionStorage.setItem(CURRENT_USER_KEY, JSON.stringify(user));
                } else {
                    sessionStorage.removeItem(CURRENT_USER_KEY);
                }
            } catch {}
        },

        logout() {
            this.isLoggedIn = false;
            this.currentUser = null;
            try {
                sessionStorage.removeItem(STORAGE_KEY);
                sessionStorage.removeItem(CURRENT_USER_KEY);
            } catch {}
        },
    },
});
