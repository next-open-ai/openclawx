import { computed, ref } from "vue";
import type { ProviderId } from "./model-config.js";
import type {
  EmployeeId,
  ProjectTaskDraft,
  ProjectTaskTranscript,
} from "./workspace.js";
import { readStored, writeStored } from "./storage.js";

export type ProjectStatus =
  | "draft"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export type ProjectTaskStatus =
  | "draft"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "stale"
  | "superseded";
export type ProjectMode = "waterfall" | "parallel" | "discussion" | "dag";
export type AccessScope = "private" | "org-shared" | "delegated";

export interface AccessGrant {
  subjectType: "user";
  subjectId: string;
  permissions: Array<"read" | "write">;
  createdAt: number;
  expiresAt?: number;
}

export interface ProjectTaskContract {
  outputs?: string[];
  acceptance?: string;
  maxSteps?: number;
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface ProjectPlan {
  version: number;
  createdAt: number;
  strategy: ProjectMode;
  taskIds: string[];
  note?: string;
}

export interface ProjectChangeSet {
  id: string;
  createdAt: number;
  kind: "instruction" | "replan" | "invalidate";
  summary: string;
  targetTaskIds: string[];
  invalidatedTaskIds: string[];
  planVersionBefore: number;
  planVersionAfter: number;
}

export interface ProjectTask {
  id: string;
  title: string;
  objective: string;
  employeeId: EmployeeId;
  provider: ProviderId;
  model: string;
  skillIds: string[];
  dependsOn: string[];
  permissionTier: "read-only" | "default" | "full";
  status: ProjectTaskStatus;
  attempts: number;
  startedAt?: number;
  finishedAt?: number;
  transcript?: ProjectTaskTranscript;
  /** Server-side run id of the current/last attempt (maps SSE events → task). */
  runId?: string;
  error?: string;
  contract?: ProjectTaskContract;
  planVersion?: number;
}

export interface ProjectMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  reasoning?: string;
  employeeId?: EmployeeId;
  taskId?: string;
  createdAt: number;
  runId?: string;
  activities?: ProjectTaskTranscript["activities"];
  approvals?: ProjectTaskTranscript["approvals"];
  assets?: ProjectTaskTranscript["assets"];
}

export interface ProjectRun {
  id: string;
  projectId: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "completed" | "failed" | "cancelled";
  taskIds: string[];
  summary?: string;
  error?: string;
  messages?: ProjectMessage[];
}

export interface Project {
  kind?: 'conversation';
  defaultEmployeeId?: string;
  id: string;
  orgId?: string;
  ownerUserId?: string;
  userId?: string;
  name: string;
  goal: string;
  status: ProjectStatus;
  accessScope?: AccessScope;
  accessGrants?: AccessGrant[];
  coordinatorProvider: ProviderId;
  coordinatorModel: string;
  mode: ProjectMode;
  workspacePath: string;
  executionWorkspaceMode?: 'isolated';
  tasks: ProjectTask[];
  messages: ProjectMessage[];
  createdAt: number;
  updatedAt: number;
  activeRunId?: string;
  summary?: string;
  plan?: ProjectPlan;
  planHistory?: ProjectPlan[];
  changeSets?: ProjectChangeSet[];
  /**
   * M0: true when this project lives on the orchestration server
   * (`/api/orch/projects`) — server owns scheduling/persistence and the page
   * only mirrors it. Legacy local projects omit this field.
   */
  managedServer?: boolean;
}

const key = "projects.v1";
const runKey = "project-runs.v1";
const projects = ref<Project[]>([]);
const runs = ref<ProjectRun[]>([]);
const loaded = ref(false);

function stamp(project: Project) {
  project.updatedAt = Date.now();
}
export interface ProjectTaskInput extends ProjectTaskDraft {
  dependsOn?: number[];
}
function makeTasks(
  drafts: ProjectTaskInput[],
  provider: ProviderId,
  model: string,
): ProjectTask[] {
  const ids = drafts.map(() => crypto.randomUUID());
  return drafts.map((draft, index) => ({
    id: ids[index],
    title: draft.title,
    objective: draft.objective,
    employeeId: draft.employeeId,
    provider,
    model,
    skillIds: [...draft.skillIds],
    dependsOn: (draft.dependsOn ?? []).map((item) => ids[item]).filter(Boolean),
    permissionTier: "default",
    status: "draft",
    attempts: 0,
  }));
}

export function useProjects() {
  const persist = async () => writeStored(key, JSON.stringify(projects.value));
  const persistRuns = async () =>
    writeStored(runKey, JSON.stringify(runs.value.slice(0, 200)));
  const load = async () => {
    if (loaded.value) return;
    try {
      projects.value = (
        JSON.parse((await readStored(key)) || "[]") as Project[]
      ).map((project) => ({
        ...project,
        accessScope:
          project.accessScope === "org-shared" || project.accessScope === "delegated"
            ? project.accessScope
            : "private",
        accessGrants: Array.isArray(project.accessGrants) ? project.accessGrants : [],
        workspacePath: project.workspacePath ?? "",
        mode: project.mode ?? "parallel",
        messages: project.messages ?? [],
        tasks: project.tasks.map((task) => ({
          ...task,
          dependsOn: task.dependsOn ?? [],
        })),
      }));
    } catch {
      projects.value = [];
    }
    try {
      runs.value = JSON.parse(
        (await readStored(runKey)) || "[]",
      ) as ProjectRun[];
    } catch {
      runs.value = [];
    }
    loaded.value = true;
  };
  const createDraft = async (input: {
    name: string;
    goal: string;
    provider: ProviderId;
    model: string;
    mode: ProjectMode;
    tasks: ProjectTaskInput[];
    workspacePath: string;
  }) => {
    const now = Date.now();
    const project: Project = {
      id: crypto.randomUUID(),
      name: input.name.trim() || input.goal.trim().slice(0, 32),
      goal: input.goal.trim(),
      status: "draft",
      accessScope: "private",
      accessGrants: [],
      coordinatorProvider: input.provider,
      coordinatorModel: input.model,
      mode: input.mode,
      workspacePath: input.workspacePath,
      tasks: makeTasks(input.tasks, input.provider, input.model),
      messages: [
        {
          id: crypto.randomUUID(),
          role: "system",
          content: "项目已创建。确认启动后，调度器会按模板编排首轮任务。",
          createdAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    projects.value = [project, ...projects.value];
    await persist();
    return project;
  };
  const update = async (project: Project) => {
    stamp(project);
    projects.value = [...projects.value];
    await persist();
  };
  const remove = async (id: string) => {
    projects.value = projects.value.filter((project) => project.id !== id);
    runs.value = runs.value.filter((run) => run.projectId !== id);
    await Promise.all([persist(), persistRuns()]);
  };
  const createRun = async (project: Project) => {
    const restartAll = project.status === "completed" || project.status === "failed" || project.status === "cancelled";
    const prior = runs.value.find((item) => item.projectId === project.id && item.status !== "running");
    if (prior && project.messages.length) {
      prior.messages = project.messages.map((message) => ({ ...message }));
      if (!prior.summary && project.summary) prior.summary = project.summary;
    }
    const run: ProjectRun = {
      id: crypto.randomUUID(),
      projectId: project.id,
      startedAt: Date.now(),
      status: "running",
      taskIds: project.tasks.map((task) => task.id),
      messages: [],
    };
    project.activeRunId = run.id;
    project.status = "running";
    project.summary = undefined;
    project.messages = [
      {
        id: crypto.randomUUID(),
        role: "system",
        content: prior
          ? "新一轮调度已开始。上一轮对话已归档到历史运行。"
          : "本轮调度已开始。",
        createdAt: Date.now(),
        runId: run.id,
      },
    ];
    project.tasks.forEach((task) => {
      if (task.status === "superseded") return;
      if (!restartAll && task.status === "completed") return;
      task.status = "queued";
      task.error = undefined;
      task.transcript = undefined;
      task.runId = undefined;
      task.startedAt = undefined;
      task.finishedAt = undefined;
      task.attempts = 0;
    });
    runs.value = [run, ...runs.value.filter((item) => item.id !== run.id)];
    await Promise.all([update(project), persistRuns()]);
    return run;
  };
  const finishRun = async (
    project: Project,
    run: ProjectRun,
    status: ProjectRun["status"],
    summary?: string,
    error?: string,
  ) => {
    run.status = status;
    run.finishedAt = Date.now();
    run.summary = summary;
    run.error = error;
    project.status =
      status === "completed"
        ? "completed"
        : status === "cancelled"
          ? "cancelled"
          : "failed";
    project.summary = summary;
    project.activeRunId = undefined;
    await Promise.all([update(project), persistRuns()]);
  };
  const activeProjects = computed(() =>
    projects.value.filter(
      (project) => project.status === "draft" || project.status === "running",
    ),
  );
  return {
    projects,
    runs,
    activeProjects,
    load,
    createDraft,
    update,
    remove,
    createRun,
    finishRun,
  };
}
