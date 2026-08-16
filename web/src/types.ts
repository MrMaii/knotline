export interface ActorIdentity {
  type: "user" | "agent";
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface Project {
  id: string;
  name: string;
  workspacePath: string | null;
  source: string;
  labels: string[];
  issueCount: number;
  createdAt: string;
  updatedAt: string;
}

export type ProjectMapEntityType =
  | "project"
  | "task"
  | "agent_session"
  | "agent_profile"
  | "skill"
  | "scheduled_trigger"
  | "demand"
  | "backlog_pool"
  | "approval_pool"
  | "request_artifact"
  | "workstream"
  | "review_gate"
  | "change_request"
  | "node_run"
  | "knowledge_asset"
  | "knowledge_proposal"
  | "decision"
  | "rule"
  | "risk"
  | "open_question"
  | "candidate_workstream"
  | "prompt"
  | "question"
  | "constraint"
  | "background_material"
  | "notification"
  | "delivery";

export type MapItemKind = "prompt" | "question" | "constraint" | "background_material";

export interface MapItem {
  id: string;
  projectId: string;
  kind: MapItemKind;
  title: string;
  content: string;
  status: "ready" | "sent";
  createdBy: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface InstalledSkill {
  id: string;
  label: string;
  description: string;
  path: string;
  scope: "user" | "repo" | "system" | "admin";
}

export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface ModelReasoningEffort {
  id: string;
  name: string;
  description?: string;
}

export interface ModelCatalogModel {
  id: string;
  name: string;
  description?: string;
  reasoning?: {
    efforts: ModelReasoningEffort[];
    defaultEffort?: string;
  };
}

export interface ModelProviderGroup {
  id: string;
  name: string;
  models: ModelCatalogModel[];
}

export interface GlobalModelDirectory {
  current: ModelSelection;
  groups: ModelProviderGroup[];
  failures: Array<{ id: string; name: string; message: string }>;
}

export interface SkillNode {
  id: string;
  projectId: string;
  skillId: string;
  label: string;
  description: string;
  scope: string;
  createdBy: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTrigger {
  id: string;
  projectId: string;
  prompt: string;
  intervalMinutes: number;
  enabled: boolean;
  lastTriggeredAt: string | null;
  nextTriggerAt: string | null;
  createdBy: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMapNodeData {
  title: string;
  subtitle: string;
  status: string;
  kind: string;
  entityVersion: number | null;
  sessionState?: string;
  live?: boolean;
  role?: string;
  skillId?: string | null;
  details?: Record<string, unknown>;
}

export interface ProjectMapNode {
  id: string;
  projectId: string;
  entityType: ProjectMapEntityType;
  entityId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  collapsed: boolean;
  layer: string;
  zIndex: number;
  version: number;
  data: ProjectMapNodeData;
}

export interface ProjectMapEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: ProjectMapHandle | null;
  targetHandle?: ProjectMapHandle | null;
  relationType: string;
  label: string;
  projected: boolean;
}

export type ProjectMapHandle = "left" | "right";

export interface ProjectMapConnectionHandles {
  sourceHandle: ProjectMapHandle | null;
  targetHandle: ProjectMapHandle | null;
}

export interface ProjectCanvas {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMapSnapshot {
  project: Project;
  canvas: ProjectCanvas;
  nodes: ProjectMapNode[];
  edges: ProjectMapEdge[];
  generatedAt: string;
}

export type IssueRelationType = "parent" | "blocks" | "blocked_by" | "related";

export interface GraphRelationCandidate {
  id: string;
  label: string;
  labelEn: string;
  relationType: string;
  actionType: string;
  taskRelationType?: IssueRelationType;
  input?: Record<string, unknown>;
}

export interface GraphComposeResolution {
  mode: "compose";
  source: { id: string; entityType: ProjectMapEntityType; title: string };
  target: { id: string; entityType: ProjectMapEntityType; title: string };
  candidates: GraphRelationCandidate[];
}

export interface GraphDirectResolution {
  mode: "direct";
  source: { id: string; entityType: ProjectMapEntityType; title: string };
  target: { id: string; entityType: ProjectMapEntityType; title: string };
  action: {
    actionType: string;
    label: string;
    labelEn: string;
    input: Record<string, unknown>;
  };
}

export interface GraphUnsupportedResolution {
  mode: "unsupported";
  source: { id: string; entityType: ProjectMapEntityType; title: string };
  target: { id: string; entityType: ProjectMapEntityType; title: string };
  message: string;
}

export type GraphActionResolution = GraphComposeResolution | GraphDirectResolution | GraphUnsupportedResolution;

export interface AgentProfile {
  id: string;
  projectId: string;
  name: string;
  role: "leader" | "executor" | "reviewer" | "approver" | "observer";
  skillId: string | null;
  provider: string | null;
  model: string | null;
  status: "offline" | "idle" | "working" | "waiting" | "blocked" | "paused";
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Demand {
  id: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  classification: "unclassified" | "context" | "question" | "complex" | "debug";
  status: "new" | "contextualized" | "intake" | "planned" | "change_requested";
  createdBy: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface BacklogPool {
  id: string;
  projectId: string;
  title: string;
  status: "active" | "paused";
  createdBy: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalPool {
  id: string;
  projectId: string;
  title: string;
  status: "active" | "paused";
  createdBy: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface GraphCommand {
  id: string;
  projectId: string;
  sourceNodeId: string;
  targetNodeId: string;
  actionType: string;
  requestedBy: string;
  idempotencyKey: string;
  status: "pending" | "completed" | "failed";
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface NotificationRecipient {
  type: "user" | "agent";
  id: string;
  readAt: string | null;
  handledAt: string | null;
  version: number;
}

export interface ProjectNotification {
  id: string;
  projectId: string;
  eventId: string;
  eventType: string;
  actor: ActorIdentity;
  title: string;
  body: string;
  reason: string;
  graphNodeId: string;
  dueAt: string | null;
  impact: string;
  actions: string[];
  context: Record<string, unknown>;
  recipients: NotificationRecipient[];
  read: boolean;
  handled: boolean;
  createdAt: string;
  updatedAt: string;
}
