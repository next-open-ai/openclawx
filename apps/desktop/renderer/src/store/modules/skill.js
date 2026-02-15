import { defineStore } from 'pinia';
import { skillsAPI } from '@/api';

export const useSkillStore = defineStore('skill', {
    state: () => ({
        skills: [],
        selectedSkill: null,
        skillContent: null,
        loading: false,
    }),

    getters: {
        skillsByCategory: (state) => {
            const categories = {};
            state.skills.forEach(skill => {
                const category = skill.category || 'Uncategorized';
                if (!categories[category]) {
                    categories[category] = [];
                }
                categories[category].push(skill);
            });
            return categories;
        },
    },

    actions: {
        async fetchSkills() {
            this.loading = true;
            try {
                const response = await skillsAPI.getSkills();
                this.skills = response.data.data;
            } catch (error) {
                console.error('Failed to fetch skills:', error);
            } finally {
                this.loading = false;
            }
        },

        async selectSkill(name) {
            this.loading = true;
            try {
                const [skillResponse, contentResponse] = await Promise.all([
                    skillsAPI.getSkill(name),
                    skillsAPI.getSkillContent(name),
                ]);
                this.selectedSkill = skillResponse.data.data;
                this.skillContent = contentResponse.data.data.content;
            } catch (error) {
                console.error('Failed to load skill:', error);
            } finally {
                this.loading = false;
            }
        },

        clearSelection() {
            this.selectedSkill = null;
            this.skillContent = null;
        },
    },
});
