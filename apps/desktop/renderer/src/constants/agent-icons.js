/**
 * 智能体预设图标：id -> 展示用 emoji，用于列表卡片与创建/编辑时选择。
 * 缺省图标（未设置或未知 id 时）使用 default。
 */
export const AGENT_ICON_DEFAULT = 'default';

export const AGENT_ICONS = [
  { id: 'default', emoji: '✨', label: '默认' },
  { id: 'robot', emoji: '🤖', label: '机器人' },
  { id: 'star', emoji: '⭐', label: '星星' },
  { id: 'code', emoji: '💻', label: '代码' },
  { id: 'chat', emoji: '💬', label: '对话' },
  { id: 'light', emoji: '💡', label: '灯泡' },
  { id: 'book', emoji: '📚', label: '书籍' },
  { id: 'gear', emoji: '⚙️', label: '齿轮' },
  { id: 'rocket', emoji: '🚀', label: '火箭' },
  { id: 'heart', emoji: '❤️', label: '爱心' },
  { id: 'fire', emoji: '🔥', label: '火焰' },
  { id: 'leaf', emoji: '🌿', label: '叶子' },
];

const iconMap = new Map(AGENT_ICONS.map((i) => [i.id, i.emoji]));

/** 根据 icon id 取 emoji，无效或空则返回 default 的 emoji */
export function getAgentIconEmoji(iconId) {
  if (!iconId || !iconMap.has(iconId)) return iconMap.get(AGENT_ICON_DEFAULT) || '✨';
  return iconMap.get(iconId);
}
