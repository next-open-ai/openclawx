/** UI-only return origin; the API still authorizes every template/project operation. */
export interface ProjectTemplateOrigin { projectId: string; definitionId: string; userId: string }
export function projectTemplateReturnTarget(origin: ProjectTemplateOrigin | null, projectId: string, userId: string | undefined): string | null {
  return origin && origin.projectId === projectId && origin.userId === userId ? origin.definitionId : null;
}
