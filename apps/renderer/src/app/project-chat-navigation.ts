/** Ephemeral navigation origin, never an authorization or execution record. */
export interface ProjectChatOrigin { projectId: string; conversationId: string; userId: string }
export function projectChatReturnTarget(origin: ProjectChatOrigin | null, projectId: string, userId: string | undefined, conversations: ReadonlyArray<{ id: string }>): string | null {
  if (!origin || origin.projectId !== projectId || origin.userId !== userId) return null;
  return conversations.some(item => item.id === origin.conversationId) ? origin.conversationId : null;
}
