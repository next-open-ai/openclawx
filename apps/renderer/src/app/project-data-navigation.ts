import type { WorkbenchNavigation } from '../features/data/workbench-navigation';

/** UI origin only; all project and object access is still authorized by the API. */
export interface ProjectDataOrigin { projectId: string; scope: string; navigation: WorkbenchNavigation }
export function projectDataReturnTarget(origin: ProjectDataOrigin | null, projectId: string, scope: string): WorkbenchNavigation | undefined {
  return origin && origin.projectId === projectId && origin.scope === scope && scope ? origin.navigation : undefined;
}
