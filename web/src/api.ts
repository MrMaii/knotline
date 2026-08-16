import type {
  ActorIdentity,
  AgentProfile,
  ApprovalPool,
  BacklogPool,
  Demand,
  GraphActionResolution,
  GraphCommand,
  GlobalModelDirectory,
  InstalledSkill,
  MapItem,
  MapItemKind,
  Project,
  ProjectCanvas,
  ProjectMapNode,
  ProjectMapSnapshot,
  ProjectNotification,
  ScheduledTrigger,
  ModelSelection,
  SkillNode,
} from "./types";

const DEFAULT_USER_ACTOR: ActorIdentity = {
  type: "user",
  id: "local-user",
  name: "本地用户",
  avatarUrl: null,
};

let currentUserActor = DEFAULT_USER_ACTOR;
let apiText = (_chinese: string, english: string) => english;

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error?.message ?? apiText(`请求失败（${status}）`, `Request failed (${status})`));
    this.name = "ApiError";
    this.status = status;
    this.code = body.error?.code ?? "REQUEST_FAILED";
    this.details = body.error?.details;
  }
}

export function setCurrentUserActor(actor?: ActorIdentity) {
  currentUserActor = actor?.type === "user" ? actor : DEFAULT_USER_ACTOR;
}

export function setApiText(text: typeof apiText) {
  apiText = text;
}

export function resolveKnotlineUrl(path: string): string {
  return new URL(`/knotline/map/${path.replace(/^\/?api\/?/, "api/")}`, window.location.origin).href;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("Content-Type", "application/json");
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    headers.set("X-Knotline-User-Id", currentUserActor.id);
    headers.set("X-Knotline-User-Name", encodeURIComponent(currentUserActor.name));
    if (currentUserActor.avatarUrl) headers.set("X-Knotline-User-Avatar", currentUserActor.avatarUrl);
  }

  let response: Response;
  try {
    response = await fetch(resolveKnotlineUrl(path), { ...init, headers });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiError(0, {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: apiText("无法连接项目地图服务。", "Could not connect to the project map service."),
      },
    });
  }

  let body = {} as T & ApiErrorBody;
  try {
    body = await response.json() as T & ApiErrorBody;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
  }
  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

export async function listProjects(signal?: AbortSignal): Promise<Project[]> {
  const data = await request<{ projects: Project[] }>("/api/projects", signal ? { signal } : undefined);
  return data.projects;
}

export async function createProject(input: {
  id: string;
  name: string;
  workspacePath: string | null;
}): Promise<Project> {
  const data = await request<{ project: Project }>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.project;
}

export async function getProjectMap(
  projectId: string,
  canvasId: string,
  signal?: AbortSignal,
): Promise<ProjectMapSnapshot> {
  const data = await request<{ map: ProjectMapSnapshot }>(
    `/api/projects/${encodeURIComponent(projectId)}/map?canvasId=${encodeURIComponent(canvasId)}`,
    signal ? { signal } : undefined,
  );
  return data.map;
}

export async function listProjectCanvases(projectId: string): Promise<ProjectCanvas[]> {
  const data = await request<{ canvases: ProjectCanvas[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/canvases`,
  );
  return data.canvases;
}

export async function createProjectCanvas(projectId: string): Promise<ProjectCanvas> {
  const data = await request<{ canvas: ProjectCanvas }>(
    `/api/projects/${encodeURIComponent(projectId)}/canvases`,
    { method: "POST" },
  );
  return data.canvas;
}

export async function assignNodeToCanvas(projectId: string, canvasId: string, nodeId: string): Promise<void> {
  await request(
    `/api/projects/${encodeURIComponent(projectId)}/canvases/${encodeURIComponent(canvasId)}/nodes`,
    { method: "POST", body: JSON.stringify({ nodeId }) },
  );
}

export async function clearProjectCanvas(projectId: string, canvasId: string): Promise<number> {
  const data = await request<{ clearedNodeCount: number }>(
    `/api/projects/${encodeURIComponent(projectId)}/canvases/${encodeURIComponent(canvasId)}/clear`,
    { method: "POST" },
  );
  return data.clearedNodeCount;
}

export async function createProjectAgent(
  projectId: string,
  input: {
    name: string;
    role: "leader" | "executor" | "reviewer";
    skillId: string | null;
  },
): Promise<AgentProfile> {
  const data = await request<{ agent: AgentProfile }>(
    `/api/projects/${encodeURIComponent(projectId)}/agents`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return data.agent;
}

export async function renameProjectAgent(agentProfileId: string, name: string): Promise<AgentProfile> {
  const data = await request<{ agent: AgentProfile }>(
    `/api/agents/${encodeURIComponent(agentProfileId)}`,
    { method: "PATCH", body: JSON.stringify({ name }) },
  );
  return data.agent;
}

export async function initializeProjectKnowledge(projectId: string, leaderAgentId: string): Promise<void> {
  await request(`/api/projects/${encodeURIComponent(projectId)}/knowledge/initialize`, {
    method: "POST",
    body: JSON.stringify({ leaderAgentId }),
  });
}

export async function createDemand(
  projectId: string,
  input: { title: string; description: string; acceptanceCriteria: string[] },
): Promise<Demand> {
  const data = await request<{ demand: Demand }>(
    `/api/projects/${encodeURIComponent(projectId)}/demands`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return data.demand;
}

export async function createBacklogPool(projectId: string, title: string): Promise<BacklogPool> {
  const data = await request<{ backlog: BacklogPool }>(
    `/api/projects/${encodeURIComponent(projectId)}/backlogs`,
    { method: "POST", body: JSON.stringify({ title }) },
  );
  return data.backlog;
}

export async function createApprovalPool(projectId: string, title: string): Promise<ApprovalPool> {
  const data = await request<{ approvalPool: ApprovalPool }>(
    `/api/projects/${encodeURIComponent(projectId)}/approval-pools`,
    { method: "POST", body: JSON.stringify({ title }) },
  );
  return data.approvalPool;
}

export async function listInstalledSkills(workspacePath: string): Promise<InstalledSkill[]> {
  const data = await request<{ skills: InstalledSkill[] }>(
    `/api/workflow-capabilities?workspacePath=${encodeURIComponent(workspacePath)}`,
  );
  return data.skills;
}

export async function getGlobalModelDirectory(signal?: AbortSignal): Promise<GlobalModelDirectory> {
  return request<GlobalModelDirectory>("/api/model-selection", signal ? { signal } : undefined);
}

export async function selectGlobalModel(selection: ModelSelection): Promise<ModelSelection> {
  const data = await request<{ selected: ModelSelection }>("/api/model-selection", {
    method: "PUT",
    body: JSON.stringify(selection),
  });
  return data.selected;
}

export async function createProjectSkill(projectId: string, skillId: string): Promise<SkillNode> {
  const data = await request<{ skillNode: SkillNode }>(
    `/api/projects/${encodeURIComponent(projectId)}/skills`,
    { method: "POST", body: JSON.stringify({ skillId }) },
  );
  return data.skillNode;
}

export async function duplicateContextDocument(assetId: string): Promise<{ id: string; projectId: string; title: string }> {
  const data = await request<{ asset: { id: string; projectId: string; title: string } }>(
    `/api/knowledge-assets/${encodeURIComponent(assetId)}/duplicate`,
    { method: "POST" },
  );
  return data.asset;
}

export async function createScheduledTrigger(
  projectId: string,
  input: { prompt: string; intervalMinutes: number; enabled: boolean },
): Promise<ScheduledTrigger> {
  const data = await request<{ trigger: ScheduledTrigger }>(
    `/api/projects/${encodeURIComponent(projectId)}/scheduled-triggers`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return data.trigger;
}

export async function setScheduledTriggerEnabled(id: string, enabled: boolean): Promise<ScheduledTrigger> {
  const data = await request<{ trigger: ScheduledTrigger }>(
    `/api/scheduled-triggers/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify({ enabled }) },
  );
  return data.trigger;
}

export async function createMapItem(
  projectId: string,
  input: { kind: MapItemKind; title: string; content: string },
): Promise<MapItem> {
  const data = await request<{ mapItem: MapItem }>(
    `/api/projects/${encodeURIComponent(projectId)}/map-items`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return data.mapItem;
}

export async function saveGraphNodeLayout(
  node: ProjectMapNode,
  position: { x: number; y: number; width?: number; height?: number },
): Promise<ProjectMapNode> {
  const data = await request<{ node: ProjectMapNode }>(
    `/api/graph/nodes/${encodeURIComponent(node.id)}/layout`,
    {
      method: "PATCH",
      body: JSON.stringify({ projectId: node.projectId, version: node.version, ...position }),
    },
  );
  return data.node;
}

export async function resolveGraphAction(
  projectId: string,
  sourceNodeId: string,
  targetNodeId: string,
): Promise<GraphActionResolution> {
  const data = await request<{ resolution: GraphActionResolution }>(
    `/api/projects/${encodeURIComponent(projectId)}/graph/actions/resolve`,
    {
      method: "POST",
      body: JSON.stringify({ sourceNodeId, targetNodeId }),
    },
  );
  return data.resolution;
}

export async function createGraphCommand(
  projectId: string,
  input: {
    sourceNodeId: string;
    targetNodeId: string;
    actionType: string;
    idempotencyKey: string;
    input: Record<string, unknown>;
  },
): Promise<GraphCommand> {
  const data = await request<{ command: GraphCommand }>(
    `/api/projects/${encodeURIComponent(projectId)}/graph/commands`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return data.command;
}

export async function sendAgentRuntimeMessage(
  agentProfileId: string,
  mode: "followup" | "steer" | "inject",
  message: string,
): Promise<void> {
  await request(`/api/agents/${encodeURIComponent(agentProfileId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ mode, message }),
  });
}

export async function controlNodeRun(
  nodeRunId: string,
  action: "pause" | "resume",
): Promise<void> {
  await request(`/api/node-runs/${encodeURIComponent(nodeRunId)}/control`, {
    method: "POST",
    body: JSON.stringify({ action }),
  });
}

export async function listNotifications(signal?: AbortSignal): Promise<ProjectNotification[]> {
  const data = await request<{ notifications: ProjectNotification[] }>(
    "/api/notifications",
    signal ? { signal } : undefined,
  );
  return data.notifications;
}

export async function updateNotification(
  notificationId: string,
  changes: { read?: boolean; handled?: boolean },
): Promise<ProjectNotification> {
  const data = await request<{ notification: ProjectNotification }>(
    `/api/notifications/${encodeURIComponent(notificationId)}`,
    { method: "PATCH", body: JSON.stringify(changes) },
  );
  return data.notification;
}

export async function actOnNotification(
  notificationId: string,
  action: string,
  input: { comment?: string; reviewerAgentId?: string; dueAt?: string } = {},
): Promise<{ command: GraphCommand; notification: ProjectNotification }> {
  return request(
    `/api/notifications/${encodeURIComponent(notificationId)}/actions/${encodeURIComponent(action)}`,
    { method: "POST", body: JSON.stringify(input) },
  );
}
