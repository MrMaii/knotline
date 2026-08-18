import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_LABEL_NAMES, JIRA_PROJECT_ID } from "../shared/domain.mjs";

const DEFAULT_PROJECT_LABELS_JSON = JSON.stringify(DEFAULT_LABEL_NAMES);

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function now() {
  return new Date().toISOString();
}

function commentConversationTitle(body) {
  const firstLine = String(body ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "评论";
  const compact = firstLine.replace(/\s+/g, " ");
  return compact.length > 80 ? `${compact.slice(0, 77)}…` : compact;
}

function threadBindingFromRow(row) {
  if (
    !row.thread_id
    || !row.thread_codex_project_id
    || !row.thread_codex_project_kind
    || !row.thread_codex_host_id
    || !row.thread_workspace_path
  ) return null;
  return {
    threadId: row.thread_id,
    codexProjectId: row.thread_codex_project_id,
    codexProjectKind: row.thread_codex_project_kind,
    codexHostId: row.thread_codex_host_id,
    workspacePath: row.thread_workspace_path,
  };
}

function legacyLocalThreadIdFromRow(row) {
  if (!row.thread_id) return null;
  return [
    row.thread_codex_project_id,
    row.thread_codex_project_kind,
    row.thread_codex_host_id,
    row.thread_workspace_path,
  ].every((value) => value == null)
    ? row.thread_id
    : null;
}

function storedThreadBinding(threadBinding, threadId) {
  if (threadBinding === undefined && (threadId === undefined || threadId === null)) return undefined;
  const binding = threadBinding === undefined ? { threadId } : threadBinding;
  return [
    binding?.threadId ?? null,
    binding?.codexProjectId ?? null,
    binding?.codexProjectKind ?? null,
    binding?.codexHostId ?? null,
    binding?.workspacePath ?? null,
  ];
}

function attachTaskActivity(task, comments, activities, previewImage = null) {
  const orderedComments = [...comments].sort((left, right) => (
    left.id.localeCompare(right.id)
  ));
  const orderedActivities = [...activities].sort((left, right) => (
    left.id.localeCompare(right.id)
  ));
  const participants = [];
  const participantIds = new Set();
  const addParticipant = (actor) => {
    const key = `${actor.type}:${actor.id}`;
    if (participantIds.has(key)) return;
    participantIds.add(key);
    participants.push(actor);
  };
  addParticipant({
    type: task.creatorType,
    id: task.creatorId,
    name: task.creatorName,
    avatarUrl: task.creatorAvatarUrl,
  });
  addParticipant(task.assignee);
  for (const comment of orderedComments) {
    addParticipant({
      type: comment.author_type,
      id: comment.author_id,
      name: comment.author_name,
      avatarUrl: comment.author_avatar_url,
    });
  }
  for (const activity of orderedActivities) {
    addParticipant({
      type: activity.actor_type,
      id: activity.actor_id,
      name: activity.actor_name,
      avatarUrl: activity.actor_avatar_url,
    });
  }
  const conversationRefs = [];
  if (task.threadBinding) {
    conversationRefs.push({
      ...task.threadBinding,
      source: "task",
      sourceId: task.id,
      title: task.title,
      updatedAt: task.updatedAt,
    });
  } else if (task.legacyLocalThreadId) {
    conversationRefs.push({
      threadId: task.legacyLocalThreadId,
      legacyLocal: true,
      source: "task",
      sourceId: task.id,
      title: task.title,
      updatedAt: task.updatedAt,
    });
  }
  for (const comment of orderedComments) {
    const threadBinding = threadBindingFromRow(comment);
    const legacyLocalThreadId = legacyLocalThreadIdFromRow(comment);
    if (threadBinding || legacyLocalThreadId) {
      conversationRefs.push({
        ...(threadBinding ?? { threadId: legacyLocalThreadId, legacyLocal: true }),
        source: "comment",
        sourceId: comment.id,
        title: commentConversationTitle(comment.body),
        updatedAt: comment.updated_at,
      });
    }
  }

  task.conversationRefs = conversationRefs;
  task.participants = participants;
  task.previewImage = previewImage;
  task.activityKey = JSON.stringify({
    version: 1,
    task: [task.id, task.version, task.updatedAt],
    comments: orderedComments.map((comment) => [comment.id, comment.version, comment.updated_at]),
    changes: orderedActivities.map((activity) => [activity.id, activity.created_at]),
  });
  task.activityUpdatedAt = [...orderedComments, ...orderedActivities].reduce(
    (latest, activity) => {
      const updatedAt = activity.updated_at ?? activity.created_at;
      return updatedAt > latest ? updatedAt : latest;
    },
    task.updatedAt,
  );
  return task;
}

function taskActivityFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorAvatarUrl: row.actor_avatar_url,
    changes: JSON.parse(row.changes),
    createdAt: row.created_at,
  };
}

function taskFieldChanges(task, changes) {
  return Object.entries(changes).flatMap(([field, after]) => {
    const before = task[field];
    return JSON.stringify(before) === JSON.stringify(after)
      ? []
      : [{ field, before, after }];
  });
}

function relationActivityValue(type, task) {
  return {
    type,
    identifier: task.identifier,
    externalKey: task.externalKey ?? null,
    title: task.title,
  };
}

function parseAiChatTodoProgress(row) {
  try {
    const data = row.data === null ? null : JSON.parse(row.data);
    const detail = typeof data?.detail === "string" ? JSON.parse(data.detail) : data?.detail;
    if (!Array.isArray(detail)) return null;
    const items = detail.filter((item) => (
      item && typeof item === "object" && typeof item.text === "string" && item.text.trim()
    ));
    if (items.length === 0) return null;
    return {
      completed: items.filter((item) => item.completed === true).length,
      total: items.length,
      eventId: row.id,
      updatedAt: row.created_at,
    };
  } catch {
    return null;
  }
}

function taskFromRow(row) {
  const developmentContext = row.worktree_path
    ? { type: "worktree", path: row.worktree_path, branch: row.worktree_branch }
    : row.git_branch
      ? { type: "branch", branch: row.git_branch }
      : null;
  return {
    id: row.id,
    identifier: row.identifier,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    labels: JSON.parse(row.labels),
    sortOrder: row.sort_order,
    threadId: row.thread_id,
    threadBinding: threadBindingFromRow(row),
    legacyLocalThreadId: legacyLocalThreadIdFromRow(row),
    creatorType: row.creator_type,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    creatorAvatarUrl: row.creator_avatar_url,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    workflowId: row.workflow_id,
    developmentContext,
    startDate: row.start_date,
    dueDate: row.due_date,
    recurrence: row.recurrence_interval && row.recurrence_unit
      ? { interval: row.recurrence_interval, unit: row.recurrence_unit }
      : null,
    source: row.external_source === "jira" ? "jira" : "local",
    externalOrigin: row.external_origin ?? null,
    externalKey: row.external_key ?? null,
    externalUrl: row.external_url ?? null,
    archivedAt: row.archived_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function graphNodeFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    collapsed: row.collapsed === 1,
    layer: row.layer,
    zIndex: row.z_index,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectCanvasFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function canvasNodeFromRow(row) {
  return {
    projectId: row.project_id,
    canvasId: row.canvas_id,
    nodeId: row.node_id,
    visible: row.visible === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function graphEdgeFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    relationType: row.relation_type,
    state: row.state,
    metadata: JSON.parse(row.metadata),
    createdBy: row.created_by,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function graphCommandFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    actionType: row.action_type,
    requestedBy: row.requested_by,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    input: JSON.parse(row.input),
    result: row.result === null ? null : JSON.parse(row.result),
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function mapItemFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    status: row.status,
    createdBy: row.created_by,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function skillNodeFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    skillId: row.skill_id,
    label: row.label,
    description: row.description,
    scope: row.scope,
    createdBy: row.created_by,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function scheduledTriggerFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    prompt: row.prompt,
    intervalMinutes: row.interval_minutes,
    enabled: row.enabled === 1,
    lastTriggeredAt: row.last_triggered_at,
    nextTriggerAt: row.next_trigger_at,
    createdBy: row.created_by,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function agentProfileFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    role: row.role,
    skillId: row.skill_id,
    provider: row.provider,
    model: row.model,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function agentTeamMembershipFromRow(row) {
  return {
    teamAgentId: row.team_agent_id,
    memberAgentId: row.member_agent_id,
    position: row.position,
    createdAt: row.created_at,
  };
}

function agentRuntimeBindingFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    agentProfileId: row.agent_profile_id,
    sessionId: row.session_id,
    currentNodeRunId: row.current_node_run_id,
    status: row.status,
    lastError: row.last_error,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nodeRunFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    workstreamId: row.workstream_id,
    taskId: row.task_id,
    agentProfileId: row.agent_profile_id,
    sessionId: row.session_id,
    parentRunId: row.parent_run_id,
    status: row.status,
    instruction: row.instruction,
    result: row.result === null ? null : JSON.parse(row.result),
    error: row.error,
    version: row.version,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function demandFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria),
    classification: row.classification ?? "unclassified",
    status: row.status,
    createdBy: row.created_by,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function backlogPoolFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    createdBy: row.created_by,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function approvalPoolFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    createdBy: row.created_by,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requestArtifactFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    demandId: row.demand_id,
    agentProfileId: row.agent_profile_id,
    nodeRunId: row.node_run_id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function workstreamFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    demandId: row.demand_id,
    leaderAgentId: row.leader_agent_id,
    reviewerAgentId: row.reviewer_agent_id,
    title: row.title,
    goal: row.goal,
    scope: JSON.parse(row.scope),
    exclusions: JSON.parse(row.exclusions),
    risks: JSON.parse(row.risks),
    dependencies: JSON.parse(row.dependencies),
    acceptanceCriteria: JSON.parse(row.acceptance_criteria),
    deliverables: JSON.parse(row.deliverables),
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function reviewGateFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    workstreamId: row.workstream_id,
    nodeRunId: row.node_run_id ?? null,
    purpose: row.purpose ?? "workstream",
    reviewerAgentId: row.reviewer_agent_id,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deliveryFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    workstreamId: row.workstream_id,
    nodeRunId: row.node_run_id,
    taskId: row.task_id,
    reviewerAgentId: row.reviewer_agent_id,
    summary: row.summary,
    evidence: row.evidence,
    createdAt: row.created_at,
  };
}

function knowledgeAssetFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    kind: row.kind ?? "project_knowledge",
    sourceDemandId: row.source_demand_id ?? null,
    currentVersion: row.current_version,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function knowledgeVersionFromRow(row) {
  return {
    id: row.id,
    assetId: row.asset_id,
    versionNumber: row.version_number,
    content: row.content,
    sourceDeliveryId: row.source_delivery_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function knowledgeBindingFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    assetId: row.asset_id,
    agentProfileId: row.agent_profile_id,
    boundVersion: row.bound_version,
    status: row.status,
    syncTaskId: row.sync_task_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function knowledgeProposalFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    assetId: row.asset_id,
    deliveryId: row.delivery_id,
    title: row.title,
    content: row.content,
    status: row.status,
    proposedBy: row.proposed_by,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function changeRequestFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    workstreamId: row.workstream_id,
    demandId: row.demand_id,
    title: row.title,
    description: row.description,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function domainEventFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actor: row.actor,
    payload: JSON.parse(row.payload),
    createdAt: row.created_at,
  };
}

function notificationFromRow(row, recipients) {
  return {
    id: row.id,
    projectId: row.project_id,
    eventId: row.event_id,
    eventType: row.event_type,
    actor: JSON.parse(row.actor),
    title: row.title,
    body: row.body,
    reason: row.reason,
    graphNodeId: row.graph_node_id,
    dueAt: row.due_at,
    impact: row.impact,
    actions: JSON.parse(row.actions),
    context: JSON.parse(row.context),
    recipients,
    read: recipients.some((recipient) => recipient.readAt !== null),
    handled: recipients.some((recipient) => recipient.handledAt !== null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskRelationSummaryFromRow(row) {
  return {
    id: row.id,
    identifier: row.identifier,
    externalKey: row.external_key ?? null,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    archivedAt: row.archived_at,
  };
}

function commentFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    body: row.body,
    threadId: row.thread_id,
    threadBinding: threadBindingFromRow(row),
    legacyLocalThreadId: legacyLocalThreadIdFromRow(row),
    authorType: row.author_type,
    authorId: row.author_id,
    authorName: row.author_name,
    authorAvatarUrl: row.author_avatar_url,
    attachments: [],
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function attachmentFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    commentId: row.comment_id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

function projectFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    workspacePath: row.workspace_path,
    source: row.id === JIRA_PROJECT_ID ? "jira" : "local",
    labels: JSON.parse(row.labels),
    issueCount: Number(row.issue_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectSummaryFromRow(row) {
  return {
    projectId: row.project_id,
    summary: row.summary,
    generatedAt: row.generated_at,
    attemptedAt: row.attempted_at,
    error: row.error,
  };
}

function workflowWorkspaceFromRow(row) {
  return {
    projectId: row.project_id,
    workspace: JSON.parse(row.workspace),
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function aiChatRunFromRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    status: row.status,
    exitCode: row.exit_code,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function aiChatThreadFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    origin: {
      projectId: row.origin_project_id,
      projectName: row.origin_project_name,
      workspacePath: row.origin_workspace_path,
      ...(row.origin_issue_id ? { issueId: row.origin_issue_id } : {}),
      ...(row.origin_issue_identifier ? { issueIdentifier: row.origin_issue_identifier } : {}),
    },
    codexThreadId: row.codex_thread_id,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    sandbox: row.sandbox,
    currentRun: null,
    latestTodo: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function aiChatEventFromRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    type: row.type,
    role: row.role,
    content: row.content,
    data: row.data === null ? null : JSON.parse(row.data),
    createdAt: row.created_at,
  };
}

function projectPrefix(projectId) {
  const prefix = projectId.toUpperCase().replace(/[^A-Z0-9]+/g, "");
  return (prefix || "TASK").slice(0, 12);
}

export class KnotlineDatabase {
  constructor(filename) {
    const directory = path.dirname(filename);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(directory, 0o700);
    this.database = new DatabaseSync(filename);
    if (process.platform !== "win32") chmodSync(filename, 0o600);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#migrate();
    this.interruptAbandonedAiChatRuns();
  }

  #migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT,
        labels TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_LABELS_JSON}',
        next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN (
          'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
        )),
        priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
        labels TEXT NOT NULL DEFAULT '[]',
        sort_order REAL NOT NULL,
        thread_id TEXT,
        thread_codex_project_id TEXT,
        thread_codex_project_kind TEXT,
        thread_codex_host_id TEXT,
        thread_workspace_path TEXT,
        creator_type TEXT NOT NULL DEFAULT 'user',
        creator_id TEXT NOT NULL DEFAULT 'local-user',
        creator_name TEXT NOT NULL DEFAULT '本地用户',
        creator_avatar_url TEXT,
        assignee_type TEXT NOT NULL DEFAULT 'user' CHECK (assignee_type IN ('user', 'agent')),
        assignee_id TEXT NOT NULL DEFAULT 'local-user',
        assignee_name TEXT NOT NULL DEFAULT '本地用户',
        assignee_avatar_url TEXT,
        workflow_id TEXT,
        git_branch TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        start_date TEXT,
        due_date TEXT,
        recurrence_interval INTEGER,
        recurrence_unit TEXT,
        external_source TEXT,
        external_origin TEXT,
        external_id TEXT,
        external_key TEXT,
        external_url TEXT,
        archived_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS tasks_project_status_sort
        ON tasks(project_id, archived_at, status, sort_order, created_at);

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        thread_id TEXT,
        thread_codex_project_id TEXT,
        thread_codex_project_kind TEXT,
        thread_codex_host_id TEXT,
        thread_workspace_path TEXT,
        author_type TEXT NOT NULL DEFAULT 'user',
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_avatar_url TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS comments_task_created
        ON comments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS task_activities (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent')),
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_avatar_url TEXT,
        changes TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS task_activities_task_created
        ON task_activities(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS attachments_task_created
        ON attachments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS workflow_workspaces (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        workspace TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_canvases (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS project_canvases_project_created
        ON project_canvases(project_id, created_at, id);

      CREATE TABLE IF NOT EXISTS canvas_nodes (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        canvas_id TEXT NOT NULL REFERENCES project_canvases(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (canvas_id, node_id)
      );

      CREATE INDEX IF NOT EXISTS canvas_nodes_project_node
        ON canvas_nodes(project_id, node_id, canvas_id);

      CREATE TABLE IF NOT EXISTS graph_nodes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        width REAL NOT NULL,
        height REAL NOT NULL,
        collapsed INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
        layer TEXT NOT NULL,
        z_index INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, entity_type, entity_id)
      );

      CREATE INDEX IF NOT EXISTS graph_nodes_project_layer
        ON graph_nodes(project_id, layer, z_index);

      CREATE TABLE IF NOT EXISTS graph_edges (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_node_id TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_by TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (source_node_id <> target_node_id)
      );

      CREATE INDEX IF NOT EXISTS graph_edges_project_source
        ON graph_edges(project_id, source_node_id, target_node_id);

      CREATE TABLE IF NOT EXISTS graph_commands (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_node_id TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
        input TEXT NOT NULL,
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (project_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS graph_commands_project_created
        ON graph_commands(project_id, created_at, id);

      CREATE TABLE IF NOT EXISTS map_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('prompt', 'question', 'constraint', 'background_material')),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'sent')),
        created_by TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS map_items_project_kind
        ON map_items(project_id, kind, created_at, id);

      CREATE TABLE IF NOT EXISTS skill_nodes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        skill_id TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT NOT NULL,
        scope TEXT NOT NULL,
        created_by TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, skill_id)
      );

      CREATE INDEX IF NOT EXISTS skill_nodes_project_created
        ON skill_nodes(project_id, created_at, id);

      CREATE TABLE IF NOT EXISTS scheduled_triggers (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL CHECK (interval_minutes > 0),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        last_triggered_at TEXT,
        next_trigger_at TEXT,
        created_by TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS scheduled_triggers_due
        ON scheduled_triggers(enabled, next_trigger_at, project_id);

      CREATE TABLE IF NOT EXISTS agent_profiles (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('leader', 'executor', 'reviewer', 'approver', 'observer')),
        skill_id TEXT,
        provider TEXT,
        model TEXT,
        status TEXT NOT NULL CHECK (status IN ('offline', 'idle', 'working', 'waiting', 'blocked', 'paused')),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS agent_profiles_project_role
        ON agent_profiles(project_id, role, created_at);

      CREATE TABLE IF NOT EXISTS agent_team_members (
        team_agent_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
        member_agent_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (team_agent_id, member_agent_id),
        CHECK (team_agent_id <> member_agent_id)
      );

      CREATE INDEX IF NOT EXISTS agent_team_members_member
        ON agent_team_members(member_agent_id, team_agent_id);

      CREATE TABLE IF NOT EXISTS demands (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL DEFAULT '[]',
        classification TEXT NOT NULL DEFAULT 'unclassified' CHECK (
          classification IN ('unclassified', 'context', 'question', 'complex', 'debug')
        ),
        status TEXT NOT NULL CHECK (status IN ('new', 'contextualized', 'intake', 'planned', 'change_requested')),
        created_by TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS demands_project_created
        ON demands(project_id, created_at, id);

      CREATE TABLE IF NOT EXISTS backlog_pools (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
        created_by TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS backlog_pools_project_created
        ON backlog_pools(project_id, created_at, id);

      CREATE TABLE IF NOT EXISTS approval_pools (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
        created_by TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS approval_pools_project_created
        ON approval_pools(project_id, created_at, id);

      CREATE TABLE IF NOT EXISTS workstreams (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        demand_id TEXT REFERENCES demands(id),
        leader_agent_id TEXT REFERENCES agent_profiles(id),
        reviewer_agent_id TEXT REFERENCES agent_profiles(id),
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        scope TEXT NOT NULL,
        exclusions TEXT NOT NULL,
        risks TEXT NOT NULL,
        dependencies TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL,
        deliverables TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'intake', 'draft', 'review', 'approved', 'staffed', 'executing', 'acceptance', 'delivered', 'archived'
        )),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS workstreams_project_status
        ON workstreams(project_id, status, created_at);

      CREATE TABLE IF NOT EXISTS review_gates (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        workstream_id TEXT REFERENCES workstreams(id) ON DELETE CASCADE,
        reviewer_agent_id TEXT REFERENCES agent_profiles(id),
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS review_gates_project_status
        ON review_gates(project_id, status, created_at);

      CREATE TABLE IF NOT EXISTS review_decisions (
        id TEXT PRIMARY KEY,
        review_gate_id TEXT NOT NULL REFERENCES review_gates(id) ON DELETE CASCADE,
        decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
        comment TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS change_requests (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
        node_run_id TEXT REFERENCES node_runs(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL DEFAULT 'workstream' CHECK (purpose IN ('workstream', 'execution')),
        demand_id TEXT NOT NULL REFERENCES demands(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'approved', 'rejected', 'applied')),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS change_requests_project_status
        ON change_requests(project_id, status, created_at);

      CREATE TABLE IF NOT EXISTS agent_runtime_bindings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
        session_id TEXT UNIQUE,
        current_node_run_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('offline', 'idle', 'working', 'waiting', 'blocked', 'paused')),
        last_error TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, agent_profile_id)
      );

      CREATE INDEX IF NOT EXISTS agent_runtime_bindings_project_status
        ON agent_runtime_bindings(project_id, status, updated_at);

      CREATE TABLE IF NOT EXISTS node_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
        session_id TEXT,
        parent_run_id TEXT REFERENCES node_runs(id),
        status TEXT NOT NULL CHECK (status IN (
          'queued', 'running', 'waiting_input', 'waiting_review', 'changes_requested',
          'approved', 'failed', 'canceled', 'completed'
        )),
        instruction TEXT NOT NULL,
        result TEXT,
        error TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS node_runs_project_status_created
        ON node_runs(project_id, status, created_at, id);

      CREATE INDEX IF NOT EXISTS node_runs_agent_created
        ON node_runs(agent_profile_id, created_at, id);

      CREATE TABLE IF NOT EXISTS request_artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        demand_id TEXT NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
        agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
        node_run_id TEXT NOT NULL REFERENCES node_runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('answer', 'review_feedback', 'plan')),
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'generating' CHECK (status IN ('generating', 'ready', 'failed')),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (node_run_id, kind)
      );

      CREATE INDEX IF NOT EXISTS request_artifacts_project_created
        ON request_artifacts(project_id, created_at, id);

      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
        node_run_id TEXT NOT NULL REFERENCES node_runs(id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        reviewer_agent_id TEXT NOT NULL REFERENCES agent_profiles(id),
        summary TEXT NOT NULL,
        evidence TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (node_run_id)
      );

      CREATE INDEX IF NOT EXISTS deliveries_project_created
        ON deliveries(project_id, created_at, id);

      CREATE TABLE IF NOT EXISTS knowledge_assets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'project_knowledge' CHECK (kind IN ('project_knowledge', 'context_document')),
        source_demand_id TEXT REFERENCES demands(id) ON DELETE SET NULL,
        current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version > 0),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS knowledge_assets_project_created
        ON knowledge_assets(project_id, created_at, id);

      CREATE TABLE IF NOT EXISTS knowledge_versions (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES knowledge_assets(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL CHECK (version_number > 0),
        content TEXT NOT NULL,
        source_delivery_id TEXT REFERENCES deliveries(id),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (asset_id, version_number)
      );

      CREATE TABLE IF NOT EXISTS knowledge_bindings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES knowledge_assets(id) ON DELETE CASCADE,
        agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
        bound_version INTEGER NOT NULL CHECK (bound_version > 0),
        status TEXT NOT NULL CHECK (status IN ('current', 'stale', 'syncing')),
        sync_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (asset_id, agent_profile_id)
      );

      CREATE INDEX IF NOT EXISTS knowledge_bindings_project_status
        ON knowledge_bindings(project_id, status, updated_at);

      CREATE TABLE IF NOT EXISTS knowledge_update_proposals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES knowledge_assets(id) ON DELETE CASCADE,
        delivery_id TEXT REFERENCES deliveries(id),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
        proposed_by TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS knowledge_proposals_project_status
        ON knowledge_update_proposals(project_id, status, created_at);

      CREATE TABLE IF NOT EXISTS domain_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS domain_events_project_created
        ON domain_events(project_id, created_at, id);

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL REFERENCES domain_events(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        reason TEXT NOT NULL,
        graph_node_id TEXT NOT NULL,
        due_at TEXT,
        impact TEXT NOT NULL,
        actions TEXT NOT NULL,
        context TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, dedupe_key)
      );

      CREATE INDEX IF NOT EXISTS notifications_project_created
        ON notifications(project_id, created_at DESC, id);

      CREATE TABLE IF NOT EXISTS notification_recipients (
        notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
        recipient_type TEXT NOT NULL CHECK (recipient_type IN ('user', 'agent')),
        recipient_id TEXT NOT NULL,
        read_at TEXT,
        handled_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        PRIMARY KEY (notification_id, recipient_type, recipient_id)
      );

      CREATE INDEX IF NOT EXISTS notification_recipients_recipient
        ON notification_recipients(recipient_type, recipient_id, read_at, handled_at);

      CREATE TABLE IF NOT EXISTS project_summaries (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        summary TEXT,
        generated_at TEXT,
        attempted_at TEXT NOT NULL,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS ai_chat_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'failed')),
        origin_project_id TEXT NOT NULL,
        origin_project_name TEXT NOT NULL,
        origin_workspace_path TEXT NOT NULL,
        origin_issue_id TEXT,
        origin_issue_identifier TEXT,
        codex_thread_id TEXT,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        sandbox TEXT NOT NULL CHECK (sandbox IN (
          'read-only', 'workspace-write', 'danger-full-access'
        )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_chat_threads_updated
        ON ai_chat_threads(updated_at DESC, id);

      CREATE TABLE IF NOT EXISTS ai_chat_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN (
          'running', 'completed', 'failed', 'interrupted'
        )),
        exit_code INTEGER,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS ai_chat_runs_thread_started
        ON ai_chat_runs(thread_id, started_at, id);

      CREATE UNIQUE INDEX IF NOT EXISTS ai_chat_runs_one_active
        ON ai_chat_runs(thread_id)
        WHERE status = 'running';

      CREATE TABLE IF NOT EXISTS ai_chat_events (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES ai_chat_runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'activity', 'error')),
        content TEXT NOT NULL,
        data TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_chat_events_thread_created
        ON ai_chat_events(thread_id, created_at, id);

    `);

    this.#migrateNodeRuns();

    const demandColumns = this.database.prepare("PRAGMA table_info(demands)").all();
    if (!demandColumns.some((column) => column.name === "classification")) {
      this.database.exec("ALTER TABLE demands ADD COLUMN classification TEXT NOT NULL DEFAULT 'unclassified'");
    }
    this.#migrateDemandContext();

    const knowledgeAssetColumns = this.database.prepare("PRAGMA table_info(knowledge_assets)").all();
    if (!knowledgeAssetColumns.some((column) => column.name === "kind")) {
      this.database.exec("ALTER TABLE knowledge_assets ADD COLUMN kind TEXT NOT NULL DEFAULT 'project_knowledge'");
    }
    if (!knowledgeAssetColumns.some((column) => column.name === "source_demand_id")) {
      this.database.exec("ALTER TABLE knowledge_assets ADD COLUMN source_demand_id TEXT REFERENCES demands(id) ON DELETE SET NULL");
    }
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS knowledge_assets_source_demand
      ON knowledge_assets(source_demand_id)
      WHERE source_demand_id IS NOT NULL
    `);

    const projectColumns = this.database.prepare("PRAGMA table_info(projects)").all();
    if (!projectColumns.some((column) => column.name === "workspace_path")) {
      this.database.exec("ALTER TABLE projects ADD COLUMN workspace_path TEXT");
    }

    const agentProfileColumns = this.database.prepare("PRAGMA table_info(agent_profiles)").all();
    if (!agentProfileColumns.some((column) => column.name === "provider")) {
      this.database.exec("ALTER TABLE agent_profiles ADD COLUMN provider TEXT");
    }
    if (!agentProfileColumns.some((column) => column.name === "model")) {
      this.database.exec("ALTER TABLE agent_profiles ADD COLUMN model TEXT");
    }

    const reviewGateColumns = this.database.prepare("PRAGMA table_info(review_gates)").all();
    if (!reviewGateColumns.some((column) => column.name === "node_run_id")) {
      this.database.exec("ALTER TABLE review_gates ADD COLUMN node_run_id TEXT REFERENCES node_runs(id) ON DELETE CASCADE");
    }
    if (!reviewGateColumns.some((column) => column.name === "purpose")) {
      this.database.exec("ALTER TABLE review_gates ADD COLUMN purpose TEXT NOT NULL DEFAULT 'workstream'");
    }

    const taskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    const hasThreadId = taskColumns.some((column) => column.name === "thread_id");
    const hasLinkedThreadId = taskColumns.some((column) => column.name === "linked_thread_id");
    if (!hasThreadId) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN thread_id TEXT");
    }
    for (const column of [
      "thread_codex_project_id",
      "thread_codex_project_kind",
      "thread_codex_host_id",
      "thread_workspace_path",
    ]) {
      if (!taskColumns.some((candidate) => candidate.name === column)) {
        this.database.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
      }
    }
    if (hasLinkedThreadId) {
      this.database.exec(`
        UPDATE tasks
        SET thread_id = COALESCE(thread_id, linked_thread_id)
      `);
      this.database.exec("ALTER TABLE tasks DROP COLUMN linked_thread_id");
    }
    if (!taskColumns.some((column) => column.name === "git_branch")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN git_branch TEXT");
    }
    if (!taskColumns.some((column) => column.name === "worktree_path")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN worktree_path TEXT");
    }
    if (!taskColumns.some((column) => column.name === "worktree_branch")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN worktree_branch TEXT");
    }
    if (!taskColumns.some((column) => column.name === "due_date")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN due_date TEXT");
    }
    if (!taskColumns.some((column) => column.name === "start_date")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN start_date TEXT");
    }
    if (!taskColumns.some((column) => column.name === "recurrence_interval")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN recurrence_interval INTEGER");
    }
    if (!taskColumns.some((column) => column.name === "recurrence_unit")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN recurrence_unit TEXT");
    }
    this.#migrateTaskStatuses();
    const migratedTaskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    if (!migratedTaskColumns.some((column) => column.name === "creator_type")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_type TEXT NOT NULL DEFAULT 'user'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_id TEXT NOT NULL DEFAULT 'local-user'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_name")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_name TEXT NOT NULL DEFAULT '本地用户'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_avatar_url")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_avatar_url TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "workflow_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN workflow_id TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_source")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_source TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_id TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_origin")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_origin TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_key")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_key TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_url")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_url TEXT");
    }
    this.database.exec(`
      DROP INDEX IF EXISTS tasks_external_source_id;
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_external_source_origin_id
      ON tasks(external_source, external_origin, external_id)
      WHERE external_source IS NOT NULL AND external_origin IS NOT NULL AND external_id IS NOT NULL
    `);
    this.database.exec(`
      UPDATE tasks
      SET creator_type = 'agent', creator_id = 'codex-agent', creator_name = 'Codex Agent'
      WHERE thread_id IS NOT NULL AND version = 1 AND creator_id = 'local-user'
    `);
    const identityTaskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    const assigneeMigrations = [
      ["assignee_type", "TEXT CHECK (assignee_type IN ('user', 'agent'))", "creator_type"],
      ["assignee_id", "TEXT", "creator_id"],
      ["assignee_name", "TEXT", "creator_name"],
      ["assignee_avatar_url", "TEXT", "creator_avatar_url"],
    ].filter(([column]) => !identityTaskColumns.some((current) => current.name === column));
    if (assigneeMigrations.length > 0) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        for (const [column, definition, source] of assigneeMigrations) {
          this.database.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
          this.database.exec(`UPDATE tasks SET ${column} = ${source}`);
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    if (!projectColumns.some((column) => column.name === "labels")) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(`
          ALTER TABLE projects
          ADD COLUMN labels TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_LABELS_JSON}'
        `);
        const labelsByProject = new Map(
          this.database.prepare("SELECT id FROM projects").all().map((project) => (
            [project.id, [...DEFAULT_LABEL_NAMES]]
          )),
        );
        for (const task of this.database.prepare(`
          SELECT project_id, labels
          FROM tasks
          ORDER BY created_at, id
        `).all()) {
          const projectLabels = labelsByProject.get(task.project_id);
          if (!projectLabels) continue;
          for (const label of JSON.parse(task.labels)) {
            if (!projectLabels.includes(label)) projectLabels.push(label);
          }
        }
        const updateProjectLabels = this.database.prepare(`
          UPDATE projects SET labels = ? WHERE id = ?
        `);
        for (const [projectId, labels] of labelsByProject) {
          updateProjectLabels.run(JSON.stringify(labels), projectId);
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS tasks_project_status_sort
        ON tasks(project_id, archived_at, status, sort_order, created_at)
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS task_relations (
        relation_type TEXT NOT NULL CHECK (relation_type IN ('parent', 'blocks', 'related')),
        source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        CHECK (source_task_id <> target_task_id),
        CHECK (relation_type <> 'related' OR source_task_id < target_task_id),
        PRIMARY KEY (relation_type, source_task_id, target_task_id)
      );

      CREATE INDEX IF NOT EXISTS task_relations_target
        ON task_relations(relation_type, target_task_id);

      CREATE UNIQUE INDEX IF NOT EXISTS task_relations_one_parent
        ON task_relations(target_task_id)
        WHERE relation_type = 'parent';
    `);

    const commentColumns = this.database.prepare("PRAGMA table_info(comments)").all();
    if (!commentColumns.some((column) => column.name === "thread_id")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN thread_id TEXT");
    }
    for (const column of [
      "thread_codex_project_id",
      "thread_codex_project_kind",
      "thread_codex_host_id",
      "thread_workspace_path",
    ]) {
      if (!commentColumns.some((candidate) => candidate.name === column)) {
        this.database.exec(`ALTER TABLE comments ADD COLUMN ${column} TEXT`);
      }
    }
    if (!commentColumns.some((column) => column.name === "author_type")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN author_type TEXT NOT NULL DEFAULT 'user'");
    }
    if (!commentColumns.some((column) => column.name === "author_avatar_url")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN author_avatar_url TEXT");
    }
    this.database.exec(`
      UPDATE comments
      SET author_type = 'agent', author_id = 'codex-agent', author_name = 'Codex Agent'
      WHERE thread_id IS NOT NULL AND author_id = 'local'
    `);
    this.database.exec(`
      UPDATE comments
      SET author_id = 'local-user'
      WHERE author_id = 'local'
    `);

    const hasTaskThreads = this.database.prepare(`
      SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'task_threads'
    `).get();
    if (hasTaskThreads) {
      this.database.exec(`
        UPDATE tasks AS migrated_task
        SET thread_id = COALESCE(thread_id, (
          SELECT task_threads.thread_id
          FROM task_threads
          LEFT JOIN comments
            ON comments.task_id = task_threads.task_id
            AND comments.thread_id = task_threads.thread_id
          WHERE task_threads.task_id = migrated_task.id
          ORDER BY
            CASE WHEN comments.id IS NOT NULL THEN 1 ELSE 0 END,
            task_threads.created_at DESC,
            task_threads.thread_id DESC
          LIMIT 1
        ))
        WHERE thread_id IS NULL
      `);
      this.database.exec("DROP TABLE task_threads");
    }

    const attachmentColumns = this.database.prepare("PRAGMA table_info(attachments)").all();
    if (!attachmentColumns.some((column) => column.name === "comment_id")) {
      this.database.exec("ALTER TABLE attachments ADD COLUMN comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE");
    }
    this.database.exec("CREATE INDEX IF NOT EXISTS attachments_comment_created ON attachments(comment_id, created_at, id)");

    const timestamp = now();
    this.database.prepare(`
      INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
      VALUES ('local', '全局', NULL, 1, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(timestamp, timestamp);
    this.database.prepare(`
      UPDATE projects
      SET name = '全局', workspace_path = NULL, updated_at = ?
      WHERE id = 'local' AND (name != '全局' OR workspace_path IS NOT NULL)
    `).run(timestamp);
  }

  close() {
    this.database.close();
  }

  #migrateDemandContext() {
    const tableSql = this.database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'demands'
    `).get()?.sql ?? "";
    if (tableSql.includes("'context'") && tableSql.includes("'contextualized'")) return;

    this.database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        DROP TABLE IF EXISTS demands_context_migration;
        CREATE TABLE demands_context_migration (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          acceptance_criteria TEXT NOT NULL DEFAULT '[]',
          classification TEXT NOT NULL DEFAULT 'unclassified' CHECK (
            classification IN ('unclassified', 'context', 'question', 'complex', 'debug')
          ),
          status TEXT NOT NULL CHECK (
            status IN ('new', 'contextualized', 'intake', 'planned', 'change_requested')
          ),
          created_by TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO demands_context_migration (
          id, project_id, title, description, acceptance_criteria, classification,
          status, created_by, version, created_at, updated_at
        )
        SELECT
          id, project_id, title, description, acceptance_criteria, classification,
          status, created_by, version, created_at, updated_at
        FROM demands;
        DROP TABLE demands;
        ALTER TABLE demands_context_migration RENAME TO demands;
        CREATE INDEX demands_project_created ON demands(project_id, created_at, id);
      `);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON");
    }

    const violation = this.database.prepare("PRAGMA foreign_key_check").get();
    if (violation) {
      throw new Error(`Demand context migration produced a foreign key violation in '${violation.table}'`);
    }
  }

  #migrateNodeRuns() {
    const table = this.database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'node_runs'
    `).get();
    const workstream = this.database.prepare("PRAGMA table_info(node_runs)").all()
      .find((column) => column.name === "workstream_id");
    if (table?.sql?.includes("waiting_input") && Number(workstream?.notnull) === 0) return;

    this.database.exec("PRAGMA foreign_keys = OFF");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        CREATE TABLE node_runs_new (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          workstream_id TEXT REFERENCES workstreams(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
          session_id TEXT,
          parent_run_id TEXT REFERENCES node_runs_new(id),
          status TEXT NOT NULL CHECK (status IN (
            'queued', 'running', 'waiting_input', 'waiting_review', 'changes_requested',
            'approved', 'failed', 'canceled', 'completed'
          )),
          instruction TEXT NOT NULL,
          result TEXT,
          error TEXT,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          updated_at TEXT NOT NULL
        );
        INSERT INTO node_runs_new (
          id, project_id, workstream_id, task_id, agent_profile_id, session_id,
          parent_run_id, status, instruction, result, error, version,
          created_at, started_at, completed_at, updated_at
        )
        SELECT
          id, project_id, workstream_id, task_id, agent_profile_id, session_id,
          parent_run_id,
          CASE status
            WHEN 'waiting' THEN 'waiting_input'
            WHEN 'review' THEN 'waiting_review'
            WHEN 'blocked' THEN 'waiting_input'
            ELSE status
          END,
          instruction, result, error, version, created_at, started_at, completed_at, updated_at
        FROM node_runs;
        DROP TABLE node_runs;
        ALTER TABLE node_runs_new RENAME TO node_runs;
        CREATE INDEX node_runs_project_status_created
          ON node_runs(project_id, status, created_at, id);
        CREATE INDEX node_runs_agent_created
          ON node_runs(agent_profile_id, created_at, id);
      `);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON");
    }
  }

  #migrateTaskStatuses() {
    const tasksSql = this.database.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'
    `).get()?.sql ?? "";
    if (
      tasksSql.includes("'in_review'")
      && tasksSql.includes("'blocked'")
      && tasksSql.includes("'canceled'")
    ) {
      return;
    }

    this.database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        CREATE TABLE tasks_status_migration (
          id TEXT PRIMARY KEY,
          identifier TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN (
            'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
          )),
          priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
          labels TEXT NOT NULL DEFAULT '[]',
          sort_order REAL NOT NULL,
          thread_id TEXT,
          thread_codex_project_id TEXT,
          thread_codex_project_kind TEXT,
          thread_codex_host_id TEXT,
          thread_workspace_path TEXT,
          git_branch TEXT,
          worktree_path TEXT,
          worktree_branch TEXT,
          start_date TEXT,
          due_date TEXT,
          recurrence_interval INTEGER,
          recurrence_unit TEXT,
          archived_at TEXT,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO tasks_status_migration (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path, git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        )
        SELECT
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path, git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        FROM tasks;

        DROP TABLE tasks;
        ALTER TABLE tasks_status_migration RENAME TO tasks;
      `);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON");
    }

    const violation = this.database.prepare("PRAGMA foreign_key_check").get();
    if (violation) {
      throw new Error(`Task status migration produced a foreign key violation in '${violation.table}'`);
    }
  }

  listProjects() {
    return this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks
        ON tasks.project_id = projects.id
        AND tasks.archived_at IS NULL
      GROUP BY
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at
      ORDER BY projects.created_at, projects.id
    `).all().map(projectFromRow);
  }

  createProject(input) {
    const timestamp = now();
    try {
      this.database.prepare(`
        INSERT INTO projects (
          id, name, workspace_path, labels, next_task_number, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(
        input.id,
        input.name,
        input.workspacePath,
        DEFAULT_PROJECT_LABELS_JSON,
        timestamp,
        timestamp,
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) {
        throw new ApiError(409, "PROJECT_EXISTS", `Project '${input.id}' already exists`);
      }
      throw error;
    }
    return this.getProject(input.id);
  }

  ensureJiraProject(name) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
      VALUES (?, ?, NULL, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
    `).run(JIRA_PROJECT_ID, name, timestamp, timestamp);
    return this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks ON tasks.project_id = projects.id AND tasks.archived_at IS NULL
      WHERE projects.id = ?
      GROUP BY projects.id
    `).get(JIRA_PROJECT_ID);
  }

  syncJiraTasks(issues, { archiveMissing = true, projectName, legacyIdentity = null } = {}) {
    const timestamp = now();
    const seenTaskIds = new Set();
    const projectLabels = JSON.stringify([
      ...new Set(issues.flatMap((issue) => issue.labels)),
    ]);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO projects (id, name, workspace_path, labels, next_task_number, created_at, updated_at)
        VALUES (?, ?, NULL, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          labels = excluded.labels,
          updated_at = excluded.updated_at
      `).run(JIRA_PROJECT_ID, projectName, projectLabels, timestamp, timestamp);
      const findExisting = this.database.prepare(`
        SELECT * FROM tasks
        WHERE external_source = 'jira' AND external_origin = ? AND external_id = ?
      `);
      const migrateLegacyIdentity = this.database.prepare(`
        UPDATE tasks SET
          identifier = ?, external_origin = ?, external_id = ?, external_key = ?
        WHERE id = ?
      `);
      if (legacyIdentity) {
        const legacyTasks = this.database.prepare(`
          SELECT id, identifier, external_id
          FROM tasks
          WHERE project_id = ?
            AND external_source = 'jira'
            AND external_origin IS NULL
            AND substr(external_id, 1, 17) = ?
            AND id = 'jira:' || external_id
        `).all(JIRA_PROJECT_ID, `${legacyIdentity.urlHash}:`);
        for (const legacyTask of legacyTasks) {
          const externalId = legacyTask.external_id.slice(17);
          migrateLegacyIdentity.run(
            `JIRA:${legacyIdentity.originId.toUpperCase()}:${externalId}`,
            legacyIdentity.originId,
            externalId,
            legacyTask.identifier,
            legacyTask.id,
          );
        }
      }
      const insertTask = this.database.prepare(`
        INSERT INTO tasks (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          creator_type, creator_id, creator_name, creator_avatar_url,
          assignee_type, assignee_id, assignee_name, assignee_avatar_url,
          workflow_id, git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          external_source, external_origin, external_id, external_key, external_url,
          archived_at, version, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?,
          ?, NULL, NULL, NULL, NULL, NULL,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          NULL, NULL, NULL, NULL,
          NULL, ?, NULL, NULL,
          'jira', ?, ?, ?, ?,
          NULL, 1, ?, ?
        )
      `);
      const updateTask = this.database.prepare(`
        UPDATE tasks SET
          identifier = ?, title = ?, description = ?, status = ?, priority = ?, labels = ?,
          sort_order = ?, creator_type = ?, creator_id = ?, creator_name = ?, creator_avatar_url = ?,
          assignee_type = ?, assignee_id = ?, assignee_name = ?, assignee_avatar_url = ?,
          due_date = ?, external_origin = ?, external_id = ?, external_key = ?, external_url = ?,
          archived_at = NULL,
          version = version + 1, updated_at = ?
        WHERE id = ?
      `);

      for (const issue of issues) {
        const existing = findExisting.get(issue.externalOrigin, issue.externalId);
        seenTaskIds.add(existing?.id ?? issue.id);
        const labels = JSON.stringify(issue.labels);
        if (!existing) {
          insertTask.run(
            issue.id,
            issue.identifier,
            JIRA_PROJECT_ID,
            issue.title,
            issue.description,
            issue.status,
            issue.priority,
            labels,
            issue.sortOrder,
            issue.creator.type,
            issue.creator.id,
            issue.creator.name,
            issue.creator.avatarUrl,
            issue.assignee.type,
            issue.assignee.id,
            issue.assignee.name,
            issue.assignee.avatarUrl,
            issue.dueDate,
            issue.externalOrigin,
            issue.externalId,
            issue.externalKey,
            issue.externalUrl,
            issue.createdAt,
            issue.updatedAt,
          );
          continue;
        }

        const changed = existing.identifier !== issue.identifier
          || existing.title !== issue.title
          || existing.description !== issue.description
          || existing.status !== issue.status
          || existing.priority !== issue.priority
          || existing.labels !== labels
          || existing.sort_order !== issue.sortOrder
          || existing.creator_type !== issue.creator.type
          || existing.creator_id !== issue.creator.id
          || existing.creator_name !== issue.creator.name
          || existing.creator_avatar_url !== issue.creator.avatarUrl
          || existing.assignee_type !== issue.assignee.type
          || existing.assignee_id !== issue.assignee.id
          || existing.assignee_name !== issue.assignee.name
          || existing.assignee_avatar_url !== issue.assignee.avatarUrl
          || existing.due_date !== issue.dueDate
          || existing.external_origin !== issue.externalOrigin
          || existing.external_id !== issue.externalId
          || existing.external_key !== issue.externalKey
          || existing.external_url !== issue.externalUrl
          || existing.archived_at !== null;
        if (!changed) continue;
        updateTask.run(
          issue.identifier,
          issue.title,
          issue.description,
          issue.status,
          issue.priority,
          labels,
          issue.sortOrder,
          issue.creator.type,
          issue.creator.id,
          issue.creator.name,
          issue.creator.avatarUrl,
          issue.assignee.type,
          issue.assignee.id,
          issue.assignee.name,
          issue.assignee.avatarUrl,
          issue.dueDate,
          issue.externalOrigin,
          issue.externalId,
          issue.externalKey,
          issue.externalUrl,
          issue.updatedAt,
          existing.id,
        );
      }

      if (archiveMissing) {
        const existingTasks = this.database.prepare(`
          SELECT id FROM tasks
          WHERE project_id = ? AND external_source = 'jira' AND archived_at IS NULL
        `).all(JIRA_PROJECT_ID);
        const archiveTask = this.database.prepare(`
          UPDATE tasks
          SET archived_at = ?, version = version + 1, updated_at = ?
          WHERE id = ?
        `);
        for (const task of existingTasks) {
          if (!seenTaskIds.has(task.id)) {
            archiveTask.run(timestamp, timestamp, task.id);
          }
        }
      }
      this.database.prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
        .run(timestamp, JIRA_PROJECT_ID);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  deleteProject(id) {
    const project = this.getProject(id);
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${id}' does not exist`);
    }
    if (!id.startsWith("temp-")) {
      throw new ApiError(403, "PROJECT_DELETE_FORBIDDEN", "Only manually created projects can be deleted");
    }
    const result = this.database.prepare(`
      DELETE FROM projects
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM tasks WHERE project_id = ?)
    `).run(id, id);
    if (result.changes !== 1) {
      const issueCount = Number(this.database.prepare(`
        SELECT COUNT(*) AS issue_count FROM tasks WHERE project_id = ?
      `).get(id).issue_count);
      throw new ApiError(409, "PROJECT_NOT_EMPTY", "Project still contains issues", { issueCount });
    }
    return project;
  }

  getProject(id) {
    const row = this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks
        ON tasks.project_id = projects.id
        AND tasks.archived_at IS NULL
      WHERE projects.id = ?
      GROUP BY
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at
    `).get(id);
    return row ? projectFromRow(row) : null;
  }

  addProjectLabel(projectId, label) {
    const project = this.database.prepare("SELECT labels FROM projects WHERE id = ?").get(projectId);
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const labels = JSON.parse(project.labels);
    if (!labels.includes(label)) {
      this.database.prepare(`
        UPDATE projects SET labels = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify([...labels, label]), now(), projectId);
    }
    return this.getProject(projectId);
  }

  deleteProjectLabel(projectId, label) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const project = this.database.prepare("SELECT labels FROM projects WHERE id = ?").get(projectId);
      if (!project) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      const timestamp = now();
      const labels = JSON.parse(project.labels);
      if (labels.includes(label)) {
        this.database.prepare(`
          UPDATE projects SET labels = ?, updated_at = ? WHERE id = ?
        `).run(JSON.stringify(labels.filter((current) => current !== label)), timestamp, projectId);
      }
      const updateTask = this.database.prepare(`
        UPDATE tasks
        SET labels = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `);
      for (const task of this.database.prepare(`
        SELECT id, labels FROM tasks WHERE project_id = ?
      `).all(projectId)) {
        const taskLabels = JSON.parse(task.labels);
        if (taskLabels.includes(label)) {
          updateTask.run(
            JSON.stringify(taskLabels.filter((current) => current !== label)),
            timestamp,
            task.id,
          );
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getProject(projectId);
  }

  getProjectSummary(projectId) {
    const row = this.database.prepare(`
      SELECT project_id, summary, generated_at, attempted_at, error
      FROM project_summaries
      WHERE project_id = ?
    `).get(projectId);
    return row ? projectSummaryFromRow(row) : {
      projectId,
      summary: null,
      generatedAt: null,
      attemptedAt: null,
      error: null,
    };
  }

  listProjectSummaries() {
    return this.database.prepare(`
      SELECT project_id, summary, generated_at, attempted_at, error
      FROM project_summaries
      ORDER BY project_id
    `).all().map(projectSummaryFromRow);
  }

  saveProjectSummary(projectId, summary) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO project_summaries (
        project_id, summary, generated_at, attempted_at, error
      ) VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(project_id) DO UPDATE SET
        summary = excluded.summary,
        generated_at = excluded.generated_at,
        attempted_at = excluded.attempted_at,
        error = NULL
    `).run(projectId, summary, timestamp, timestamp);
    return this.getProjectSummary(projectId);
  }

  saveProjectSummaryError(projectId, error) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO project_summaries (
        project_id, summary, generated_at, attempted_at, error
      ) VALUES (?, NULL, NULL, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        attempted_at = excluded.attempted_at,
        error = excluded.error
    `).run(projectId, timestamp, error);
    return this.getProjectSummary(projectId);
  }

  getWorkflowWorkspace(projectId) {
    if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const row = this.database.prepare(`
      SELECT project_id, workspace, version, updated_at
      FROM workflow_workspaces
      WHERE project_id = ?
    `).get(projectId);
    return row
      ? workflowWorkspaceFromRow(row)
      : { projectId, workspace: null, version: 0, updatedAt: null };
  }

  saveWorkflowWorkspace(projectId, expectedVersion, workspace) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      const current = this.database.prepare(`
        SELECT version FROM workflow_workspaces WHERE project_id = ?
      `).get(projectId);
      const actualVersion = current?.version ?? 0;
      if (actualVersion !== expectedVersion) {
        throw new ApiError(409, "VERSION_CONFLICT", "Workflow was changed by another client", {
          expectedVersion,
          actualVersion,
        });
      }
      if (current) {
        this.database.prepare(`
          UPDATE workflow_workspaces
          SET workspace = ?, version = version + 1, updated_at = ?
          WHERE project_id = ? AND version = ?
        `).run(JSON.stringify(workspace), timestamp, projectId, expectedVersion);
      } else {
        this.database.prepare(`
          INSERT INTO workflow_workspaces (project_id, workspace, version, updated_at)
          VALUES (?, ?, 1, ?)
        `).run(projectId, JSON.stringify(workspace), timestamp);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getWorkflowWorkspace(projectId);
  }

  listGraphNodes(projectId) {
    if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    return this.database.prepare(`
      SELECT * FROM graph_nodes
      WHERE project_id = ?
      ORDER BY layer, z_index, created_at, id
    `).all(projectId).map(graphNodeFromRow);
  }

  listProjectCanvases(projectId) {
    if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    let rows = this.database.prepare(`
      SELECT * FROM project_canvases
      WHERE project_id = ?
      ORDER BY created_at, id
    `).all(projectId);
    if (rows.length === 0) {
      const timestamp = now();
      this.database.prepare(`
        INSERT INTO project_canvases (id, project_id, name, created_at, updated_at)
        VALUES (?, ?, '画布 1', ?, ?)
      `).run(randomUUID(), projectId, timestamp, timestamp);
      rows = this.database.prepare(`
        SELECT * FROM project_canvases
        WHERE project_id = ?
        ORDER BY created_at, id
      `).all(projectId);
    }
    return rows.map(projectCanvasFromRow);
  }

  createProjectCanvas(projectId) {
    const canvases = this.listProjectCanvases(projectId);
    const timestamp = now();
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO project_canvases (id, project_id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, projectId, `画布 ${canvases.length + 1}`, timestamp, timestamp);
    return projectCanvasFromRow(this.database.prepare(
      "SELECT * FROM project_canvases WHERE id = ?",
    ).get(id));
  }

  listCanvasNodes(projectId) {
    return this.database.prepare(`
      SELECT * FROM canvas_nodes
      WHERE project_id = ?
      ORDER BY created_at, canvas_id, node_id
    `).all(projectId).map(canvasNodeFromRow);
  }

  assignCanvasNode(projectId, canvasId, nodeId) {
    const canvas = this.database.prepare(`
      SELECT 1 FROM project_canvases WHERE id = ? AND project_id = ?
    `).get(canvasId, projectId);
    if (!canvas) {
      throw new ApiError(404, "CANVAS_NOT_FOUND", `Canvas '${canvasId}' does not exist in project '${projectId}'`);
    }
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO canvas_nodes (project_id, canvas_id, node_id, visible, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(canvas_id, node_id) DO UPDATE SET
        visible = 1,
        updated_at = excluded.updated_at
    `).run(projectId, canvasId, nodeId, timestamp, timestamp);
    return canvasNodeFromRow(this.database.prepare(`
      SELECT * FROM canvas_nodes WHERE canvas_id = ? AND node_id = ?
    `).get(canvasId, nodeId));
  }

  moveCanvasNode(projectId, canvasId, nodeId) {
    const timestamp = now();
    this.database.prepare(`
      UPDATE canvas_nodes SET visible = 0, updated_at = ?
      WHERE project_id = ? AND node_id = ? AND canvas_id <> ? AND visible = 1
    `).run(timestamp, projectId, nodeId, canvasId);
    return this.assignCanvasNode(projectId, canvasId, nodeId);
  }

  clearProjectCanvas(projectId, canvasId) {
    const canvas = this.database.prepare(`
      SELECT * FROM project_canvases WHERE id = ? AND project_id = ?
    `).get(canvasId, projectId);
    if (!canvas) {
      throw new ApiError(404, "CANVAS_NOT_FOUND", `Canvas '${canvasId}' does not exist in project '${projectId}'`);
    }
    const timestamp = now();
    const result = this.database.prepare(`
      UPDATE canvas_nodes SET visible = 0, updated_at = ?
      WHERE project_id = ? AND canvas_id = ? AND visible = 1
    `).run(timestamp, projectId, canvasId);
    return { canvas: projectCanvasFromRow(canvas), clearedNodeCount: Number(result.changes) };
  }

  saveGraphNodeLayout(input) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(input.projectId)) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${input.projectId}' does not exist`);
      }
      const current = this.database.prepare(`
        SELECT * FROM graph_nodes
        WHERE project_id = ? AND entity_type = ? AND entity_id = ?
      `).get(input.projectId, input.entityType, input.entityId);
      const actualVersion = current?.version ?? 0;
      if (actualVersion !== input.version) {
        throw new ApiError(409, "VERSION_CONFLICT", "Graph node changed since it was last read", {
          expectedVersion: input.version,
          actualVersion,
        });
      }
      if (current) {
        this.database.prepare(`
          UPDATE graph_nodes
          SET x = ?, y = ?, width = ?, height = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?
        `).run(input.x, input.y, input.width, input.height, timestamp, current.id, input.version);
      } else {
        this.database.prepare(`
          INSERT INTO graph_nodes (
            id, project_id, entity_type, entity_id, x, y, width, height,
            collapsed, layer, z_index, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?)
        `).run(
          input.id,
          input.projectId,
          input.entityType,
          input.entityId,
          input.x,
          input.y,
          input.width,
          input.height,
          input.layer,
          input.zIndex,
          timestamp,
          timestamp,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const row = this.database.prepare(`
      SELECT * FROM graph_nodes
      WHERE project_id = ? AND entity_type = ? AND entity_id = ?
    `).get(input.projectId, input.entityType, input.entityId);
    return graphNodeFromRow(row);
  }

  listGraphEdges(projectId) {
    return this.database.prepare(`
      SELECT * FROM graph_edges
      WHERE project_id = ?
      ORDER BY created_at, id
    `).all(projectId).map(graphEdgeFromRow);
  }

  listMapItems(projectId) {
    return this.database.prepare(`
      SELECT * FROM map_items WHERE project_id = ? ORDER BY created_at, id
    `).all(projectId).map(mapItemFromRow);
  }

  getMapItem(id) {
    const row = this.database.prepare("SELECT * FROM map_items WHERE id = ?").get(id);
    return row ? mapItemFromRow(row) : null;
  }

  createMapItem(input) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO map_items (
        id, project_id, kind, title, content, status, created_by,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'ready', ?, 1, ?, ?)
    `).run(
      input.id,
      input.projectId,
      input.kind,
      input.title,
      input.content,
      input.createdBy,
      timestamp,
      timestamp,
    );
    return mapItemFromRow(this.database.prepare("SELECT * FROM map_items WHERE id = ?").get(input.id));
  }

  markMapItemSent(id) {
    this.database.prepare(`
      UPDATE map_items SET status = 'sent', version = version + 1, updated_at = ? WHERE id = ?
    `).run(now(), id);
    const row = this.database.prepare("SELECT * FROM map_items WHERE id = ?").get(id);
    return row ? mapItemFromRow(row) : null;
  }

  listSkillNodes(projectId) {
    return this.database.prepare(`
      SELECT * FROM skill_nodes WHERE project_id = ? ORDER BY created_at, id
    `).all(projectId).map(skillNodeFromRow);
  }

  getSkillNode(id) {
    const row = this.database.prepare("SELECT * FROM skill_nodes WHERE id = ?").get(id);
    return row ? skillNodeFromRow(row) : null;
  }

  createSkillNode(input) {
    const existing = this.database.prepare(`
      SELECT * FROM skill_nodes WHERE project_id = ? AND skill_id = ?
    `).get(input.projectId, input.skillId);
    if (existing) return skillNodeFromRow(existing);
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO skill_nodes (
        id, project_id, skill_id, label, description, scope, created_by,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      input.id,
      input.projectId,
      input.skillId,
      input.label,
      input.description,
      input.scope,
      input.createdBy,
      timestamp,
      timestamp,
    );
    return this.getSkillNode(input.id);
  }

  listScheduledTriggers(projectId) {
    return this.database.prepare(`
      SELECT * FROM scheduled_triggers WHERE project_id = ? ORDER BY created_at, id
    `).all(projectId).map(scheduledTriggerFromRow);
  }

  getScheduledTrigger(id) {
    const row = this.database.prepare("SELECT * FROM scheduled_triggers WHERE id = ?").get(id);
    return row ? scheduledTriggerFromRow(row) : null;
  }

  createScheduledTrigger(input) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO scheduled_triggers (
        id, project_id, prompt, interval_minutes, enabled, last_triggered_at,
        next_trigger_at, created_by, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 1, ?, ?)
    `).run(
      input.id,
      input.projectId,
      input.prompt,
      input.intervalMinutes,
      input.enabled ? 1 : 0,
      input.createdBy,
      timestamp,
      timestamp,
    );
    return this.getScheduledTrigger(input.id);
  }

  updateScheduledTriggerEnabled(id, enabled) {
    const trigger = this.getScheduledTrigger(id);
    if (!trigger) return null;
    const hasTarget = Boolean(this.database.prepare(`
      SELECT 1 FROM graph_edges
      WHERE source_node_id = ? AND relation_type = 'scheduled_for' AND state = 'active'
      LIMIT 1
    `).get(`scheduled_trigger:${id}`));
    const timestamp = now();
    const nextTriggerAt = enabled && hasTarget
      ? new Date(Date.now() + trigger.intervalMinutes * 60_000).toISOString()
      : null;
    this.database.prepare(`
      UPDATE scheduled_triggers
      SET enabled = ?, next_trigger_at = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(enabled ? 1 : 0, nextTriggerAt, timestamp, id);
    return this.getScheduledTrigger(id);
  }

  armScheduledTrigger(id) {
    const trigger = this.getScheduledTrigger(id);
    if (!trigger || !trigger.enabled) return trigger;
    const timestamp = now();
    const nextTriggerAt = new Date(Date.now() + trigger.intervalMinutes * 60_000).toISOString();
    this.database.prepare(`
      UPDATE scheduled_triggers
      SET next_trigger_at = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(nextTriggerAt, timestamp, id);
    return this.getScheduledTrigger(id);
  }

  listDueScheduledTriggers(timestamp = now()) {
    return this.database.prepare(`
      SELECT * FROM scheduled_triggers
      WHERE enabled = 1 AND next_trigger_at IS NOT NULL AND next_trigger_at <= ?
      ORDER BY next_trigger_at, id
    `).all(timestamp).map(scheduledTriggerFromRow);
  }

  recordScheduledTriggerFired(id) {
    const trigger = this.getScheduledTrigger(id);
    if (!trigger || !trigger.enabled) return trigger;
    const timestamp = now();
    const nextTriggerAt = new Date(Date.now() + trigger.intervalMinutes * 60_000).toISOString();
    this.database.prepare(`
      UPDATE scheduled_triggers
      SET last_triggered_at = ?, next_trigger_at = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND enabled = 1
    `).run(timestamp, nextTriggerAt, timestamp, id);
    return this.getScheduledTrigger(id);
  }

  createGraphEdge(input) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO graph_edges (
        id, project_id, source_node_id, target_node_id, relation_type,
        state, metadata, created_by, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 1, ?, ?)
    `).run(
      input.id,
      input.projectId,
      input.sourceNodeId,
      input.targetNodeId,
      input.relationType,
      JSON.stringify(input.metadata ?? {}),
      input.createdBy,
      timestamp,
      timestamp,
    );
    return graphEdgeFromRow(this.database.prepare("SELECT * FROM graph_edges WHERE id = ?").get(input.id));
  }

  updateGraphEdge(id, changes) {
    const current = this.database.prepare("SELECT * FROM graph_edges WHERE id = ?").get(id);
    if (!current) return null;
    const timestamp = now();
    this.database.prepare(`
      UPDATE graph_edges
      SET state = ?, metadata = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(
      changes.state ?? current.state,
      JSON.stringify(changes.metadata ?? JSON.parse(current.metadata)),
      timestamp,
      id,
    );
    return graphEdgeFromRow(this.database.prepare("SELECT * FROM graph_edges WHERE id = ?").get(id));
  }

  createGraphCommand(input) {
    const existing = this.database.prepare(`
      SELECT * FROM graph_commands WHERE project_id = ? AND idempotency_key = ?
    `).get(input.projectId, input.idempotencyKey);
    if (existing) return graphCommandFromRow(existing);
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO graph_commands (
        id, project_id, source_node_id, target_node_id, action_type,
        requested_by, idempotency_key, status, input, result, error, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, NULL)
    `).run(
      input.id,
      input.projectId,
      input.sourceNodeId,
      input.targetNodeId,
      input.actionType,
      input.requestedBy,
      input.idempotencyKey,
      JSON.stringify(input.input),
      timestamp,
    );
    return this.getGraphCommand(input.id);
  }

  getGraphCommand(id) {
    const row = this.database.prepare("SELECT * FROM graph_commands WHERE id = ?").get(id);
    return row ? graphCommandFromRow(row) : null;
  }

  listGraphCommands(projectId) {
    return this.database.prepare(`
      SELECT * FROM graph_commands
      WHERE project_id = ? AND status = 'completed'
      ORDER BY created_at, id
    `).all(projectId).map(graphCommandFromRow);
  }

  completeGraphCommand(id, result) {
    this.database.prepare(`
      UPDATE graph_commands
      SET status = 'completed', result = ?, error = NULL, completed_at = ?
      WHERE id = ?
    `).run(JSON.stringify(result), now(), id);
    return this.getGraphCommand(id);
  }

  failGraphCommand(id, error) {
    this.database.prepare(`
      UPDATE graph_commands
      SET status = 'failed', error = ?, completed_at = ?
      WHERE id = ?
    `).run(error, now(), id);
    return this.getGraphCommand(id);
  }

  listAgentProfiles(projectId) {
    return this.database.prepare(`
      SELECT * FROM agent_profiles WHERE project_id = ? ORDER BY created_at, id
    `).all(projectId).map(agentProfileFromRow);
  }

  getAgentProfile(id) {
    const row = this.database.prepare("SELECT * FROM agent_profiles WHERE id = ?").get(id);
    return row ? agentProfileFromRow(row) : null;
  }

  createAgentProfile(input) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO agent_profiles (
        id, project_id, name, role, skill_id, provider, model, status, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', 1, ?, ?)
    `).run(
      input.id,
      input.projectId,
      input.name,
      input.role,
      input.skillId,
      input.provider ?? null,
      input.model ?? null,
      timestamp,
      timestamp,
    );
    return this.getAgentProfile(input.id);
  }

  renameAgentProfile(id, name) {
    this.database.prepare(`
      UPDATE agent_profiles
      SET name = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(name, now(), id);
    return this.getAgentProfile(id);
  }

  setAgentProfileSkill(id, skillId) {
    this.database.prepare(`
      UPDATE agent_profiles
      SET skill_id = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(skillId, now(), id);
    return this.getAgentProfile(id);
  }

  listAgentTeamMemberships(projectId) {
    return this.database.prepare(`
      SELECT membership.*
      FROM agent_team_members membership
      JOIN agent_profiles team ON team.id = membership.team_agent_id
      WHERE team.project_id = ?
      ORDER BY membership.team_agent_id, membership.position
    `).all(projectId).map(agentTeamMembershipFromRow);
  }

  getAgentTeamMembers(teamAgentId) {
    return this.database.prepare(`
      SELECT member.*
      FROM agent_team_members membership
      JOIN agent_profiles member ON member.id = membership.member_agent_id
      WHERE membership.team_agent_id = ?
      ORDER BY membership.position
    `).all(teamAgentId).map(agentProfileFromRow);
  }

  createAgentTeam(input) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO agent_profiles (
          id, project_id, name, role, skill_id, provider, model, status, version, created_at, updated_at
        ) VALUES (?, ?, ?, 'executor', NULL, NULL, NULL, 'idle', 1, ?, ?)
      `).run(input.teamAgentId, input.projectId, input.name, timestamp, timestamp);
      const insertMember = this.database.prepare(`
        INSERT INTO agent_team_members (team_agent_id, member_agent_id, position, created_at)
        VALUES (?, ?, ?, ?)
      `);
      input.memberAgentIds.forEach((memberAgentId, position) => {
        insertMember.run(input.teamAgentId, memberAgentId, position, timestamp);
      });
      const insertDocument = this.database.prepare(`
        INSERT INTO map_items (
          id, project_id, kind, title, content, status, created_by, version, created_at, updated_at
        ) VALUES (?, ?, 'background_material', ?, ?, 'ready', ?, 1, ?, ?)
      `);
      insertDocument.run(
        input.planItemId,
        input.projectId,
        `${input.name} · Team Plan`,
        input.plan,
        `team:${input.teamAgentId}`,
        timestamp,
        timestamp,
      );
      insertDocument.run(
        input.protocolItemId,
        input.projectId,
        `${input.name} · Working Protocol`,
        input.protocol,
        `team:${input.teamAgentId}`,
        timestamp,
        timestamp,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      team: this.getAgentProfile(input.teamAgentId),
      members: this.getAgentTeamMembers(input.teamAgentId),
      plan: this.getMapItem(input.planItemId),
      protocol: this.getMapItem(input.protocolItemId),
    };
  }

  setAgentProfileStatus(id, status) {
    const timestamp = now();
    this.database.prepare(`
      UPDATE agent_profiles
      SET status = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND status <> ?
    `).run(status, timestamp, id, status);
    return this.getAgentProfile(id);
  }

  listAgentRuntimeBindings(projectId) {
    return this.database.prepare(`
      SELECT * FROM agent_runtime_bindings WHERE project_id = ? ORDER BY created_at, id
    `).all(projectId).map(agentRuntimeBindingFromRow);
  }

  listRecoverableAgentRuntimeBindings() {
    return this.database.prepare(`
      SELECT * FROM agent_runtime_bindings
      WHERE current_node_run_id IS NOT NULL AND status IN ('working', 'waiting', 'blocked', 'paused')
      ORDER BY updated_at, id
    `).all().map(agentRuntimeBindingFromRow);
  }

  getAgentRuntimeBindingByProfile(agentProfileId) {
    const row = this.database.prepare(`
      SELECT * FROM agent_runtime_bindings WHERE agent_profile_id = ?
    `).get(agentProfileId);
    return row ? agentRuntimeBindingFromRow(row) : null;
  }

  getAgentRuntimeBindingBySession(sessionId) {
    const row = this.database.prepare(`
      SELECT * FROM agent_runtime_bindings WHERE session_id = ?
    `).get(sessionId);
    return row ? agentRuntimeBindingFromRow(row) : null;
  }

  createAgentRuntimeBinding(input) {
    const existing = this.getAgentRuntimeBindingByProfile(input.agentProfileId);
    if (existing) return existing;
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO agent_runtime_bindings (
        id, project_id, agent_profile_id, session_id, current_node_run_id,
        status, last_error, version, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, 'idle', NULL, 1, ?, ?)
    `).run(input.id, input.projectId, input.agentProfileId, input.currentNodeRunId ?? null, timestamp, timestamp);
    return this.getAgentRuntimeBindingByProfile(input.agentProfileId);
  }

  updateAgentRuntimeBinding(agentProfileId, changes) {
    const current = this.getAgentRuntimeBindingByProfile(agentProfileId);
    if (!current) return null;
    const sessionId = Object.hasOwn(changes, "sessionId") ? changes.sessionId : current.sessionId;
    const currentNodeRunId = Object.hasOwn(changes, "currentNodeRunId")
      ? changes.currentNodeRunId
      : current.currentNodeRunId;
    const status = changes.status ?? current.status;
    const lastError = Object.hasOwn(changes, "lastError") ? changes.lastError : current.lastError;
    this.database.prepare(`
      UPDATE agent_runtime_bindings
      SET session_id = ?, current_node_run_id = ?, status = ?, last_error = ?,
          version = version + 1, updated_at = ?
      WHERE agent_profile_id = ?
    `).run(sessionId, currentNodeRunId, status, lastError, now(), agentProfileId);
    this.setAgentProfileStatus(agentProfileId, status);
    return this.getAgentRuntimeBindingByProfile(agentProfileId);
  }

  listNodeRuns(projectId, statuses = []) {
    const where = ["project_id = ?"];
    const values = [projectId];
    if (statuses.length > 0) {
      where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      values.push(...statuses);
    }
    return this.database.prepare(`
      SELECT * FROM node_runs
      WHERE ${where.join(" AND ")}
      ORDER BY created_at, id
    `).all(...values).map(nodeRunFromRow);
  }

  listRecoverableNodeRuns() {
    return this.database.prepare(`
      SELECT * FROM node_runs
      WHERE status IN ('queued', 'running')
      ORDER BY created_at, id
    `).all().map(nodeRunFromRow);
  }

  getNodeRun(id) {
    const row = this.database.prepare("SELECT * FROM node_runs WHERE id = ?").get(id);
    return row ? nodeRunFromRow(row) : null;
  }

  getLatestNodeRunByTask(taskId) {
    const row = this.database.prepare(`
      SELECT * FROM node_runs WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(taskId);
    return row ? nodeRunFromRow(row) : null;
  }

  getLatestNodeRunForAgent(agentProfileId) {
    const row = this.database.prepare(`
      SELECT * FROM node_runs WHERE agent_profile_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(agentProfileId);
    return row ? nodeRunFromRow(row) : null;
  }

  createNodeRun(input) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO node_runs (
        id, project_id, workstream_id, task_id, agent_profile_id, session_id,
        parent_run_id, status, instruction, result, error, version,
        created_at, started_at, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'queued', ?, NULL, NULL, 1, ?, NULL, NULL, ?)
    `).run(
      input.id,
      input.projectId,
      input.workstreamId,
      input.taskId,
      input.agentProfileId,
      input.parentRunId ?? null,
      input.instruction,
      timestamp,
      timestamp,
    );
    return this.getNodeRun(input.id);
  }

  updateNodeRun(id, changes) {
    const current = this.getNodeRun(id);
    if (!current) return null;
    const status = changes.status ?? current.status;
    const sessionId = Object.hasOwn(changes, "sessionId") ? changes.sessionId : current.sessionId;
    const result = Object.hasOwn(changes, "result") ? changes.result : current.result;
    const error = Object.hasOwn(changes, "error") ? changes.error : current.error;
    const timestamp = now();
    const startedAt = current.startedAt ?? (status === "running" ? timestamp : null);
    const completedAt = ["completed", "failed", "canceled"].includes(status)
      ? (current.completedAt ?? timestamp)
      : null;
    this.database.prepare(`
      UPDATE node_runs
      SET status = ?, session_id = ?, result = ?, error = ?,
          started_at = ?, completed_at = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(
      status,
      sessionId,
      result === null ? null : JSON.stringify(result),
      error,
      startedAt,
      completedAt,
      timestamp,
      id,
    );
    return this.getNodeRun(id);
  }

  setWorkstreamStatus(id, status) {
    this.database.prepare(`
      UPDATE workstreams SET status = ?, version = version + 1, updated_at = ? WHERE id = ?
    `).run(status, now(), id);
    return this.getWorkstream(id);
  }

  listDemands(projectId) {
    return this.database.prepare(`
      SELECT * FROM demands WHERE project_id = ? ORDER BY created_at, id
    `).all(projectId).map(demandFromRow);
  }

  getDemand(id) {
    const row = this.database.prepare("SELECT * FROM demands WHERE id = ?").get(id);
    return row ? demandFromRow(row) : null;
  }

  createDemand(input) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO demands (
        id, project_id, title, description, acceptance_criteria, classification, status,
        created_by, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'unclassified', 'new', ?, 1, ?, ?)
    `).run(
      input.id,
      input.projectId,
      input.title,
      input.description,
      JSON.stringify(input.acceptanceCriteria),
      input.createdBy,
      timestamp,
      timestamp,
    );
    return this.getDemand(input.id);
  }

  setDemandClassification(id, classification) {
    if (!["context", "question", "complex", "debug"].includes(classification)) {
      throw new ApiError(400, "INVALID_DEMAND_CLASSIFICATION", "Unknown Demand classification");
    }
    this.database.prepare(`
      UPDATE demands
      SET classification = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(classification, now(), id);
    return this.getDemand(id);
  }

  contextualizeDemand(id) {
    this.database.prepare(`
      UPDATE demands
      SET classification = 'context', status = 'contextualized', version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(now(), id);
    return this.getDemand(id);
  }

  listBacklogPools(projectId) {
    return this.database.prepare(`
      SELECT * FROM backlog_pools WHERE project_id = ? ORDER BY created_at, id
    `).all(projectId).map(backlogPoolFromRow);
  }

  getBacklogPool(id) {
    const row = this.database.prepare("SELECT * FROM backlog_pools WHERE id = ?").get(id);
    return row ? backlogPoolFromRow(row) : null;
  }

  createBacklogPool(input) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO backlog_pools (
        id, project_id, title, status, created_by, version, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', ?, 1, ?, ?)
    `).run(input.id, input.projectId, input.title, input.createdBy, timestamp, timestamp);
    return this.getBacklogPool(input.id);
  }

  listApprovalPools(projectId) {
    return this.database.prepare(`
      SELECT * FROM approval_pools WHERE project_id = ? ORDER BY created_at, id
    `).all(projectId).map(approvalPoolFromRow);
  }

  getApprovalPool(id) {
    const row = this.database.prepare("SELECT * FROM approval_pools WHERE id = ?").get(id);
    return row ? approvalPoolFromRow(row) : null;
  }

  createApprovalPool(input) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO approval_pools (
        id, project_id, title, status, created_by, version, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', ?, 1, ?, ?)
    `).run(input.id, input.projectId, input.title, input.createdBy, timestamp, timestamp);
    return this.getApprovalPool(input.id);
  }

  listRequestArtifacts(projectId) {
    return this.database.prepare(`
      SELECT * FROM request_artifacts
      WHERE project_id = ?
      ORDER BY created_at,
        CASE kind WHEN 'review_feedback' THEN 0 WHEN 'answer' THEN 0 ELSE 1 END,
        id
    `).all(projectId).map(requestArtifactFromRow);
  }

  getRequestArtifact(id) {
    const row = this.database.prepare("SELECT * FROM request_artifacts WHERE id = ?").get(id);
    return row ? requestArtifactFromRow(row) : null;
  }

  createRequestArtifacts(input) {
    const kinds = input.classification === "question"
      ? [["answer", `Answer: ${input.demandTitle}`]]
      : input.classification === "complex"
        ? [
            ["review_feedback", `Review: ${input.demandTitle}`],
            ["plan", `Plan: ${input.demandTitle}`],
          ]
        : [];
    if (kinds.length === 0) return [];
    const timestamp = now();
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO request_artifacts (
        id, project_id, demand_id, agent_profile_id, node_run_id,
        kind, title, content, status, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '', 'generating', 1, ?, ?)
    `);
    for (const [kind, title] of kinds) {
      insert.run(
        randomUUID(),
        input.projectId,
        input.demandId,
        input.agentProfileId,
        input.nodeRunId,
        kind,
        title,
        timestamp,
        timestamp,
      );
    }
    return this.database.prepare(`
      SELECT * FROM request_artifacts
      WHERE node_run_id = ?
      ORDER BY CASE kind WHEN 'review_feedback' THEN 0 WHEN 'answer' THEN 0 ELSE 1 END, id
    `).all(input.nodeRunId).map(requestArtifactFromRow);
  }

  completeRequestArtifacts(nodeRunId, result) {
    let artifacts = this.database.prepare(`
      SELECT * FROM request_artifacts
      WHERE node_run_id = ?
      ORDER BY CASE kind WHEN 'review_feedback' THEN 0 WHEN 'answer' THEN 0 ELSE 1 END, id
    `).all(nodeRunId).map(requestArtifactFromRow);
    if (artifacts.length === 0) {
      const nodeRun = this.getNodeRun(nodeRunId);
      if (nodeRun?.parentRunId) {
        artifacts = this.database.prepare(`
          SELECT * FROM request_artifacts
          WHERE node_run_id = ?
          ORDER BY CASE kind WHEN 'review_feedback' THEN 0 WHEN 'answer' THEN 0 ELSE 1 END, id
        `).all(nodeRun.parentRunId).map(requestArtifactFromRow);
      }
    }
    const update = this.database.prepare(`
      UPDATE request_artifacts
      SET content = ?, status = 'ready', version = version + 1, updated_at = ?
      WHERE id = ?
    `);
    const timestamp = now();
    for (const artifact of artifacts) {
      const content = artifact.kind === "plan"
        ? String(result.evidence ?? result.summary ?? "")
        : artifact.kind === "review_feedback"
          ? String(result.summary ?? "")
          : [result.summary, result.evidence].filter(Boolean).join("\n\n");
      update.run(content, timestamp, artifact.id);
    }
    return this.database.prepare(`
      SELECT * FROM request_artifacts
      WHERE node_run_id = ?
      ORDER BY CASE kind WHEN 'review_feedback' THEN 0 WHEN 'answer' THEN 0 ELSE 1 END, id
    `).all(nodeRunId).map(requestArtifactFromRow);
  }

  listWorkstreams(projectId) {
    return this.database.prepare(`
      SELECT * FROM workstreams WHERE project_id = ? ORDER BY created_at, id
    `).all(projectId).map(workstreamFromRow);
  }

  getWorkstream(id) {
    const row = this.database.prepare("SELECT * FROM workstreams WHERE id = ?").get(id);
    return row ? workstreamFromRow(row) : null;
  }

  createWorkstreamWithReviewGate(input) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO workstreams (
          id, project_id, demand_id, leader_agent_id, reviewer_agent_id,
          title, goal, scope, exclusions, risks, dependencies,
          acceptance_criteria, deliverables, status, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'review', 1, ?, ?)
      `).run(
        input.workstreamId,
        input.projectId,
        input.demandId,
        input.leaderAgentId,
        input.title,
        input.goal,
        JSON.stringify(input.scope),
        JSON.stringify(input.exclusions),
        JSON.stringify(input.risks),
        JSON.stringify(input.dependencies),
        JSON.stringify(input.acceptanceCriteria),
        JSON.stringify(input.deliverables),
        timestamp,
        timestamp,
      );
      this.database.prepare(`
        INSERT INTO review_gates (
          id, project_id, workstream_id, reviewer_agent_id, status, version, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, 'pending', 1, ?, ?)
      `).run(input.reviewGateId, input.projectId, input.workstreamId, timestamp, timestamp);
      this.database.prepare(`
        UPDATE demands SET status = 'planned', version = version + 1, updated_at = ? WHERE id = ?
      `).run(timestamp, input.demandId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      demand: this.getDemand(input.demandId),
      workstream: this.getWorkstream(input.workstreamId),
      reviewGate: this.getReviewGate(input.reviewGateId),
    };
  }

  createApprovedWorkstream(input) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO workstreams (
          id, project_id, demand_id, leader_agent_id, reviewer_agent_id,
          title, goal, scope, exclusions, risks, dependencies,
          acceptance_criteria, deliverables, status, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 1, ?, ?)
      `).run(
        input.workstreamId,
        input.projectId,
        input.demandId,
        input.agentProfileId,
        input.title,
        input.goal,
        JSON.stringify(input.scope),
        JSON.stringify(input.exclusions),
        JSON.stringify(input.risks),
        JSON.stringify(input.dependencies),
        JSON.stringify(input.acceptanceCriteria),
        JSON.stringify(input.deliverables),
        timestamp,
        timestamp,
      );
      this.database.prepare(`
        UPDATE demands SET status = 'planned', version = version + 1, updated_at = ? WHERE id = ?
      `).run(timestamp, input.demandId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      demand: this.getDemand(input.demandId),
      workstream: this.getWorkstream(input.workstreamId),
    };
  }

  listReviewGates(projectId) {
    return this.database.prepare(`
      SELECT * FROM review_gates WHERE project_id = ? ORDER BY created_at, id
    `).all(projectId).map(reviewGateFromRow);
  }

  getReviewGate(id) {
    const row = this.database.prepare("SELECT * FROM review_gates WHERE id = ?").get(id);
    return row ? reviewGateFromRow(row) : null;
  }

  getExecutionReviewByNodeRun(nodeRunId) {
    const row = this.database.prepare(`
      SELECT * FROM review_gates
      WHERE node_run_id = ? AND purpose = 'execution'
      ORDER BY created_at DESC LIMIT 1
    `).get(nodeRunId);
    return row ? reviewGateFromRow(row) : null;
  }

  assignWorkstreamReviewer(workstreamId, reviewerAgentId) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE workstreams
        SET reviewer_agent_id = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(reviewerAgentId, timestamp, workstreamId);
      this.database.prepare(`
        UPDATE review_gates
        SET reviewer_agent_id = ?, version = version + 1, updated_at = ?
        WHERE workstream_id = ? AND status = 'pending'
      `).run(reviewerAgentId, timestamp, workstreamId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      workstream: this.getWorkstream(workstreamId),
      reviewGate: reviewGateFromRow(this.database.prepare(`
        SELECT * FROM review_gates WHERE workstream_id = ? ORDER BY created_at DESC LIMIT 1
      `).get(workstreamId)),
    };
  }

  createExecutionReviewGate(input) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO review_gates (
        id, project_id, workstream_id, node_run_id, purpose,
        reviewer_agent_id, status, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'execution', ?, 'pending', 1, ?, ?)
    `).run(
      input.id,
      input.projectId,
      input.workstreamId,
      input.nodeRunId,
      input.reviewerAgentId,
      timestamp,
      timestamp,
    );
    return this.getReviewGate(input.id);
  }

  recordExecutionReviewDecision(input) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO review_decisions (
          id, review_gate_id, decision, comment, decided_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.id, input.reviewGateId, input.decision, input.comment, input.decidedBy, timestamp);
      this.database.prepare(`
        UPDATE review_gates
        SET status = ?, version = version + 1, updated_at = ? WHERE id = ?
      `).run(input.decision, timestamp, input.reviewGateId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getReviewGate(input.reviewGateId);
  }

  recordReviewDecision(input) {
    const timestamp = now();
    const workstreamStatus = input.decision === "approved" ? "approved" : "draft";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO review_decisions (
          id, review_gate_id, decision, comment, decided_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.id, input.reviewGateId, input.decision, input.comment, input.decidedBy, timestamp);
      this.database.prepare(`
        UPDATE review_gates
        SET status = ?, version = version + 1, updated_at = ? WHERE id = ?
      `).run(input.decision, timestamp, input.reviewGateId);
      this.database.prepare(`
        UPDATE workstreams
        SET status = ?, version = version + 1, updated_at = ? WHERE id = ?
      `).run(workstreamStatus, timestamp, input.workstreamId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      reviewGate: this.getReviewGate(input.reviewGateId),
      workstream: this.getWorkstream(input.workstreamId),
      decision: {
        id: input.id,
        reviewGateId: input.reviewGateId,
        decision: input.decision,
        comment: input.comment,
        decidedBy: input.decidedBy,
        createdAt: timestamp,
      },
    };
  }

  listChangeRequests(projectId) {
    return this.database.prepare(`
      SELECT * FROM change_requests WHERE project_id = ? ORDER BY created_at, id
    `).all(projectId).map(changeRequestFromRow);
  }

  createChangeRequest(input) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO change_requests (
          id, project_id, workstream_id, demand_id, title, description,
          status, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'open', 1, ?, ?)
      `).run(
        input.id,
        input.projectId,
        input.workstreamId,
        input.demandId,
        input.title,
        input.description,
        timestamp,
        timestamp,
      );
      this.database.prepare(`
        UPDATE demands
        SET status = 'change_requested', version = version + 1, updated_at = ? WHERE id = ?
      `).run(timestamp, input.demandId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      demand: this.getDemand(input.demandId),
      workstream: this.getWorkstream(input.workstreamId),
      changeRequest: changeRequestFromRow(this.database.prepare(
        "SELECT * FROM change_requests WHERE id = ?",
      ).get(input.id)),
    };
  }

  listDeliveries(projectId) {
    return this.database.prepare(`
      SELECT * FROM deliveries WHERE project_id = ? ORDER BY created_at, id
    `).all(projectId).map(deliveryFromRow);
  }

  getDelivery(id) {
    const row = this.database.prepare("SELECT * FROM deliveries WHERE id = ?").get(id);
    return row ? deliveryFromRow(row) : null;
  }

  getDeliveryByNodeRun(nodeRunId) {
    const row = this.database.prepare("SELECT * FROM deliveries WHERE node_run_id = ?").get(nodeRunId);
    return row ? deliveryFromRow(row) : null;
  }

  createDelivery(input) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO deliveries (
        id, project_id, workstream_id, node_run_id, task_id,
        reviewer_agent_id, summary, evidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.projectId,
      input.workstreamId,
      input.nodeRunId,
      input.taskId,
      input.reviewerAgentId,
      input.summary,
      input.evidence,
      timestamp,
    );
    return this.getDelivery(input.id);
  }

  listKnowledgeAssets(projectId) {
    return this.database.prepare(`
      SELECT * FROM knowledge_assets WHERE project_id = ? ORDER BY created_at, id
    `).all(projectId).map(knowledgeAssetFromRow);
  }

  getKnowledgeAsset(id) {
    const row = this.database.prepare("SELECT * FROM knowledge_assets WHERE id = ?").get(id);
    return row ? knowledgeAssetFromRow(row) : null;
  }

  getKnowledgeAssetBySourceDemand(demandId) {
    const row = this.database.prepare("SELECT * FROM knowledge_assets WHERE source_demand_id = ?").get(demandId);
    return row ? knowledgeAssetFromRow(row) : null;
  }

  getKnowledgeVersion(assetId, versionNumber) {
    const row = this.database.prepare(`
      SELECT * FROM knowledge_versions WHERE asset_id = ? AND version_number = ?
    `).get(assetId, versionNumber);
    return row ? knowledgeVersionFromRow(row) : null;
  }

  listKnowledgeVersions(assetId) {
    return this.database.prepare(`
      SELECT * FROM knowledge_versions WHERE asset_id = ? ORDER BY version_number
    `).all(assetId).map(knowledgeVersionFromRow);
  }

  createKnowledgeAssetV1(input) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO knowledge_assets (
          id, project_id, title, kind, source_demand_id,
          current_version, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
      `).run(
        input.assetId,
        input.projectId,
        input.title,
        input.kind ?? "project_knowledge",
        input.sourceDemandId ?? null,
        timestamp,
        timestamp,
      );
      this.database.prepare(`
        INSERT INTO knowledge_versions (
          id, asset_id, version_number, content, source_delivery_id, created_by, created_at
        ) VALUES (?, ?, 1, ?, NULL, ?, ?)
      `).run(input.versionId, input.assetId, input.content, input.createdBy, timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      asset: this.getKnowledgeAsset(input.assetId),
      knowledgeVersion: this.getKnowledgeVersion(input.assetId, 1),
    };
  }

  listKnowledgeBindings(projectId) {
    return this.database.prepare(`
      SELECT * FROM knowledge_bindings WHERE project_id = ? ORDER BY created_at, id
    `).all(projectId).map(knowledgeBindingFromRow);
  }

  getKnowledgeBinding(assetId, agentProfileId) {
    const row = this.database.prepare(`
      SELECT * FROM knowledge_bindings WHERE asset_id = ? AND agent_profile_id = ?
    `).get(assetId, agentProfileId);
    return row ? knowledgeBindingFromRow(row) : null;
  }

  getKnowledgeBindingBySyncTask(taskId) {
    const row = this.database.prepare(`
      SELECT * FROM knowledge_bindings WHERE sync_task_id = ?
    `).get(taskId);
    return row ? knowledgeBindingFromRow(row) : null;
  }

  saveKnowledgeBinding(input) {
    const timestamp = now();
    const existing = this.getKnowledgeBinding(input.assetId, input.agentProfileId);
    if (existing) {
      this.database.prepare(`
        UPDATE knowledge_bindings
        SET status = 'syncing', sync_task_id = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(input.syncTaskId, timestamp, existing.id);
      return this.getKnowledgeBinding(input.assetId, input.agentProfileId);
    }
    this.database.prepare(`
      INSERT INTO knowledge_bindings (
        id, project_id, asset_id, agent_profile_id, bound_version,
        status, sync_task_id, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'syncing', ?, 1, ?, ?)
    `).run(
      input.id,
      input.projectId,
      input.assetId,
      input.agentProfileId,
      input.boundVersion,
      input.syncTaskId,
      timestamp,
      timestamp,
    );
    return this.getKnowledgeBinding(input.assetId, input.agentProfileId);
  }

  saveKnowledgeBindingDirect(input) {
    const timestamp = now();
    const existing = this.getKnowledgeBinding(input.assetId, input.agentProfileId);
    if (existing) {
      this.database.prepare(`
        UPDATE knowledge_bindings
        SET bound_version = ?, status = 'current', sync_task_id = NULL,
            version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(input.boundVersion, timestamp, existing.id);
      return this.getKnowledgeBinding(input.assetId, input.agentProfileId);
    }
    this.database.prepare(`
      INSERT INTO knowledge_bindings (
        id, project_id, asset_id, agent_profile_id, bound_version,
        status, sync_task_id, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'current', NULL, 1, ?, ?)
    `).run(
      input.id,
      input.projectId,
      input.assetId,
      input.agentProfileId,
      input.boundVersion,
      timestamp,
      timestamp,
    );
    return this.getKnowledgeBinding(input.assetId, input.agentProfileId);
  }

  completeKnowledgeBindingSync(id, boundVersion) {
    this.database.prepare(`
      UPDATE knowledge_bindings
      SET bound_version = ?, status = 'current', version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(boundVersion, now(), id);
    const row = this.database.prepare("SELECT * FROM knowledge_bindings WHERE id = ?").get(id);
    return row ? knowledgeBindingFromRow(row) : null;
  }

  listKnowledgeProposals(projectId) {
    return this.database.prepare(`
      SELECT * FROM knowledge_update_proposals WHERE project_id = ? ORDER BY created_at, id
    `).all(projectId).map(knowledgeProposalFromRow);
  }

  getKnowledgeProposal(id) {
    const row = this.database.prepare("SELECT * FROM knowledge_update_proposals WHERE id = ?").get(id);
    return row ? knowledgeProposalFromRow(row) : null;
  }

  createKnowledgeProposal(input) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO knowledge_update_proposals (
        id, project_id, asset_id, delivery_id, title, content,
        status, proposed_by, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?)
    `).run(
      input.id,
      input.projectId,
      input.assetId,
      input.deliveryId ?? null,
      input.title,
      input.content,
      input.proposedBy,
      timestamp,
      timestamp,
    );
    return this.getKnowledgeProposal(input.id);
  }

  decideKnowledgeProposal(input) {
    const proposal = this.getKnowledgeProposal(input.proposalId);
    if (!proposal) return null;
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE knowledge_update_proposals
        SET status = ?, version = version + 1, updated_at = ? WHERE id = ?
      `).run(input.decision, timestamp, proposal.id);
      if (input.decision === "approved") {
        const asset = this.getKnowledgeAsset(proposal.assetId);
        const nextVersion = asset.currentVersion + 1;
        this.database.prepare(`
          INSERT INTO knowledge_versions (
            id, asset_id, version_number, content, source_delivery_id, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.versionId,
          asset.id,
          nextVersion,
          proposal.content,
          proposal.deliveryId,
          input.decidedBy,
          timestamp,
        );
        this.database.prepare(`
          UPDATE knowledge_assets
          SET current_version = ?, version = version + 1, updated_at = ? WHERE id = ?
        `).run(nextVersion, timestamp, asset.id);
        this.database.prepare(`
          UPDATE knowledge_bindings
          SET status = 'stale', version = version + 1, updated_at = ?
          WHERE asset_id = ? AND bound_version < ?
        `).run(timestamp, asset.id, nextVersion);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const asset = this.getKnowledgeAsset(proposal.assetId);
    return {
      proposal: this.getKnowledgeProposal(proposal.id),
      asset,
      knowledgeVersion: input.decision === "approved"
        ? this.getKnowledgeVersion(asset.id, asset.currentVersion)
        : null,
      bindings: this.listKnowledgeBindings(proposal.projectId),
    };
  }

  createDomainEvent(input) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO domain_events (
        id, project_id, event_type, entity_type, entity_id, actor, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.projectId,
      input.eventType,
      input.entityType,
      input.entityId,
      input.actor,
      JSON.stringify(input.payload),
      timestamp,
    );
    return domainEventFromRow(this.database.prepare("SELECT * FROM domain_events WHERE id = ?").get(input.id));
  }

  createNotification(input) {
    const existing = this.database.prepare(`
      SELECT * FROM notifications WHERE project_id = ? AND dedupe_key = ?
    `).get(input.projectId, input.dedupeKey);
    if (existing) return this.getNotification(existing.id);
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO notifications (
          id, project_id, event_id, event_type, actor, title, body, reason,
          graph_node_id, due_at, impact, actions, context, dedupe_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.projectId,
        input.eventId,
        input.eventType,
        JSON.stringify(input.actor),
        input.title,
        input.body,
        input.reason,
        input.graphNodeId,
        input.dueAt,
        input.impact,
        JSON.stringify(input.actions),
        JSON.stringify(input.context),
        input.dedupeKey,
        timestamp,
        timestamp,
      );
      const insertRecipient = this.database.prepare(`
        INSERT INTO notification_recipients (
          notification_id, recipient_type, recipient_id, read_at, handled_at, version
        ) VALUES (?, ?, ?, NULL, NULL, 1)
      `);
      for (const recipient of input.recipients) {
        insertRecipient.run(input.id, recipient.type, recipient.id);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getNotification(input.id);
  }

  listNotifications(projectId) {
    const rows = this.database.prepare(`
      SELECT * FROM notifications
      WHERE (? IS NULL OR project_id = ?)
      ORDER BY created_at DESC, id DESC
    `).all(projectId ?? null, projectId ?? null);
    return rows.map((row) => this.#notificationWithRecipients(row));
  }

  getNotification(id) {
    const row = this.database.prepare("SELECT * FROM notifications WHERE id = ?").get(id);
    return row ? this.#notificationWithRecipients(row) : null;
  }

  updateNotificationRecipient(notificationId, recipient, changes) {
    if (!this.getNotification(notificationId)) return null;
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO notification_recipients (
        notification_id, recipient_type, recipient_id, read_at, handled_at, version
      ) VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(notification_id, recipient_type, recipient_id) DO UPDATE SET
        read_at = CASE WHEN ? THEN excluded.read_at ELSE notification_recipients.read_at END,
        handled_at = CASE WHEN ? THEN excluded.handled_at ELSE notification_recipients.handled_at END,
        version = notification_recipients.version + 1
    `).run(
      notificationId,
      recipient.type,
      recipient.id,
      changes.read ? timestamp : null,
      changes.handled ? timestamp : null,
      changes.read ? 1 : 0,
      changes.handled ? 1 : 0,
    );
    this.database.prepare("UPDATE notifications SET updated_at = ? WHERE id = ?").run(timestamp, notificationId);
    return this.getNotification(notificationId);
  }

  listAiChatThreads() {
    const rows = this.database.prepare(`
      SELECT * FROM ai_chat_threads
      ORDER BY updated_at DESC, id
    `).all();
    if (rows.length === 0) return [];

    const currentRuns = new Map();
    for (const row of this.database.prepare(`
      SELECT * FROM ai_chat_runs
      WHERE status = 'running'
      ORDER BY thread_id, started_at DESC, id DESC
    `).all()) {
      if (!currentRuns.has(row.thread_id)) currentRuns.set(row.thread_id, aiChatRunFromRow(row));
    }

    const latestTodos = new Map();
    for (const row of this.database.prepare(`
      SELECT id, thread_id, run_id, data, created_at
      FROM ai_chat_events
      WHERE type = 'todo_list'
      ORDER BY thread_id, created_at DESC, rowid DESC
    `).all()) {
      if (latestTodos.has(row.thread_id)) continue;
      const currentRun = currentRuns.get(row.thread_id);
      if (currentRun && row.run_id !== currentRun.id) continue;
      const progress = parseAiChatTodoProgress(row);
      if (progress) latestTodos.set(row.thread_id, progress);
    }

    return rows.map((row) => {
      const thread = aiChatThreadFromRow(row);
      thread.currentRun = currentRuns.get(thread.id) ?? null;
      thread.latestTodo = latestTodos.get(thread.id) ?? null;
      return thread;
    });
  }

  getAiChatThread(id) {
    const row = this.database.prepare("SELECT * FROM ai_chat_threads WHERE id = ?").get(id);
    return row ? this.#aiChatThreadWithCurrentRun(row) : null;
  }

  hasAiChatThreadProjectConflict(issueRef, projectId) {
    return Boolean(this.database.prepare(`
      SELECT 1
      FROM ai_chat_threads
      WHERE (origin_issue_id = ? OR origin_issue_identifier = ?)
        AND origin_project_id != ?
      LIMIT 1
    `).get(issueRef, issueRef, projectId));
  }

  createAiChatThread(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    this.database.prepare(`
      INSERT INTO ai_chat_threads (
        id, title, status,
        origin_project_id, origin_project_name, origin_workspace_path,
        origin_issue_id, origin_issue_identifier,
        codex_thread_id, model, reasoning_effort, sandbox,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.title,
      input.status ?? "idle",
      input.origin.projectId,
      input.origin.projectName,
      input.origin.workspacePath,
      input.origin.issueId ?? null,
      input.origin.issueIdentifier ?? null,
      input.codexThreadId ?? null,
      input.model,
      input.reasoningEffort,
      input.sandbox,
      timestamp,
      input.updatedAt ?? timestamp,
    );
    return this.getAiChatThread(id);
  }

  updateAiChatThread(id, changes) {
    const current = this.getAiChatThread(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${id}' does not exist`);
    }
    const columns = {
      title: "title",
      status: "status",
      codexThreadId: "codex_thread_id",
      model: "model",
      reasoningEffort: "reasoning_effort",
      sandbox: "sandbox",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(changes[key]);
    }
    if (assignments.length === 0) return current;
    assignments.push("updated_at = ?");
    values.push(changes.updatedAt ?? now(), id);
    this.database.prepare(`
      UPDATE ai_chat_threads SET ${assignments.join(", ")} WHERE id = ?
    `).run(...values);
    return this.getAiChatThread(id);
  }

  deleteAiChatThread(id) {
    const current = this.getAiChatThread(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${id}' does not exist`);
    }
    this.database.prepare("DELETE FROM ai_chat_threads WHERE id = ?").run(id);
    return current;
  }

  listAiChatRuns(threadId) {
    return this.database.prepare(`
      SELECT * FROM ai_chat_runs
      WHERE thread_id = ?
      ORDER BY started_at, id
    `).all(threadId).map(aiChatRunFromRow);
  }

  getAiChatRun(id) {
    const row = this.database.prepare("SELECT * FROM ai_chat_runs WHERE id = ?").get(id);
    return row ? aiChatRunFromRow(row) : null;
  }

  createAiChatRun(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.startedAt ?? now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO ai_chat_runs (
          id, thread_id, status, exit_code, error, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.threadId,
        input.status ?? "running",
        input.exitCode ?? null,
        input.error ?? null,
        timestamp,
        input.finishedAt ?? null,
      );
      if ((input.status ?? "running") === "running") {
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = 'running', updated_at = ?
          WHERE id = ?
        `).run(timestamp, input.threadId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAiChatRun(id);
  }

  updateAiChatRun(id, changes) {
    const current = this.getAiChatRun(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_RUN_NOT_FOUND", `AI chat run '${id}' does not exist`);
    }
    const columns = {
      status: "status",
      exitCode: "exit_code",
      error: "error",
      finishedAt: "finished_at",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(changes[key]);
    }
    if (assignments.length === 0) return current;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      values.push(id);
      this.database.prepare(`
        UPDATE ai_chat_runs SET ${assignments.join(", ")} WHERE id = ?
      `).run(...values);
      const status = changes.status ?? current.status;
      if (status !== "running") {
        const threadStatus = status === "failed" ? "failed" : "idle";
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = ?, updated_at = ?
          WHERE id = ?
            AND NOT EXISTS (
              SELECT 1 FROM ai_chat_runs
              WHERE thread_id = ? AND status = 'running'
            )
        `).run(threadStatus, changes.finishedAt ?? now(), current.threadId, current.threadId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAiChatRun(id);
  }

  insertAiChatEvent(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    this.database.prepare(`
      INSERT INTO ai_chat_events (
        id, thread_id, run_id, type, role, content, data, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.threadId,
      input.runId ?? null,
      input.type,
      input.role,
      input.content,
      input.data === undefined || input.data === null ? null : JSON.stringify(input.data),
      timestamp,
    );
    const row = this.database.prepare("SELECT * FROM ai_chat_events WHERE id = ?").get(id);
    return aiChatEventFromRow(row);
  }

  listAiChatEvents(threadId) {
    return this.database.prepare(`
      SELECT * FROM ai_chat_events
      WHERE thread_id = ?
      ORDER BY created_at, rowid
    `).all(threadId).map(aiChatEventFromRow);
  }

  interruptAbandonedAiChatRuns() {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE ai_chat_runs
        SET
          status = 'interrupted',
          error = COALESCE(error, 'Knotline service restarted'),
          finished_at = COALESCE(finished_at, ?)
        WHERE status = 'running'
      `).run(timestamp);
      if (result.changes > 0) {
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = 'idle', updated_at = ?
          WHERE status = 'running'
            AND NOT EXISTS (
              SELECT 1 FROM ai_chat_runs
              WHERE ai_chat_runs.thread_id = ai_chat_threads.id
                AND ai_chat_runs.status = 'running'
            )
        `).run(timestamp);
      }
      this.database.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listTasks(filters) {
    const where = [];
    const values = [];
    if (filters.projectId) {
      where.push("project_id = ?");
      values.push(filters.projectId);
    }
    if (filters.status) {
      where.push("status = ?");
      values.push(filters.status);
    }
    if (filters.archived === "false") {
      where.push("archived_at IS NULL");
    } else if (filters.archived === "true") {
      where.push("archived_at IS NOT NULL");
    }

    const sql = `
      SELECT * FROM tasks
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY
        CASE status
          WHEN 'backlog' THEN 1
          WHEN 'todo' THEN 2
          WHEN 'in_progress' THEN 3
          WHEN 'in_review' THEN 4
          WHEN 'blocked' THEN 5
          WHEN 'done' THEN 6
          WHEN 'canceled' THEN 7
        END,
        sort_order,
        created_at,
        id
    `;
    const rows = this.database.prepare(sql).all(...values);
    const commentsByTask = this.#commentsForTaskActivity(rows.map((row) => row.id));
    const activitiesByTask = this.#activitiesForTasks(rows.map((row) => row.id));
    const previewImagesByTask = this.#taskPreviewImages(rows.map((row) => row.id));
    return rows.map((row) => attachTaskActivity(
      this.#taskWithRelations(row),
      commentsByTask.get(row.id) ?? [],
      activitiesByTask.get(row.id) ?? [],
      previewImagesByTask.get(row.id) ?? null,
    ));
  }

  getTask(id) {
    const row = this.database.prepare("SELECT * FROM tasks WHERE id = ? OR identifier = ?").get(id, id);
    if (!row) return null;
    const task = this.#taskWithRelations(row);
    const comments = this.#commentsForTaskActivity([task.id]).get(task.id) ?? [];
    const activities = this.#activitiesForTasks([task.id]).get(task.id) ?? [];
    const previewImage = this.#taskPreviewImages([task.id]).get(task.id) ?? null;
    return attachTaskActivity(task, comments, activities, previewImage);
  }

  createTask(input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const project = this.database.prepare(`
        SELECT
          projects.id,
          projects.labels,
          projects.next_task_number,
          (
            SELECT tasks.identifier
            FROM tasks
            WHERE tasks.project_id = projects.id
            ORDER BY tasks.created_at, tasks.id
            LIMIT 1
          ) AS first_identifier
        FROM projects
        WHERE projects.id = ?
      `).get(input.projectId);
      if (!project) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${input.projectId}' does not exist`);
      }

      const prefix = project.first_identifier
        ? project.first_identifier.replace(/-\d+$/, "")
        : projectPrefix(project.id);
      const maximum = this.database.prepare(`
        SELECT MAX(CAST(substr(identifier, ?) AS INTEGER)) AS number
        FROM tasks
        WHERE identifier GLOB ?
      `).get(prefix.length + 2, `${prefix}-[0-9]*`).number;
      const number = Math.max(project.next_task_number, maximum === null ? 1 : maximum + 1);
      const identifier = `${prefix}-${number}`;
      const id = randomUUID();
      const timestamp = now();
      let sortOrder = input.sortOrder;
      if (sortOrder === undefined) {
        const row = this.database.prepare(`
          SELECT MIN(sort_order) AS minimum
          FROM tasks
          WHERE project_id = ? AND status = ? AND archived_at IS NULL
        `).get(input.projectId, input.status);
        sortOrder = row.minimum === null ? 1000 : row.minimum - 1000;
      }

      this.database.prepare(`
        UPDATE projects SET next_task_number = ?, labels = ?, updated_at = ? WHERE id = ?
      `).run(
        number + 1,
        JSON.stringify([...new Set([...JSON.parse(project.labels), ...input.labels])]),
        timestamp,
        input.projectId,
      );
      this.database.prepare(`
        INSERT INTO tasks (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          creator_type, creator_id, creator_name, creator_avatar_url,
          assignee_type, assignee_id, assignee_name, assignee_avatar_url,
          workflow_id, git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)
      `).run(
        id,
        identifier,
        input.projectId,
        input.title,
        input.description,
        input.status,
        input.priority,
        JSON.stringify(input.labels),
        sortOrder,
        ...(storedThreadBinding(input.threadBinding, input.threadId) ?? [null, null, null, null, null]),
        input.actor.type,
        input.actor.id,
        input.actor.name,
        input.actor.avatarUrl,
        input.assignee.type,
        input.assignee.id,
        input.assignee.name,
        input.assignee.avatarUrl,
        input.workflowId,
        input.developmentContext?.type === "branch" ? input.developmentContext.branch : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.path : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.branch : null,
        input.startDate,
        input.dueDate,
        input.recurrence?.interval ?? null,
        input.recurrence?.unit ?? null,
        timestamp,
        timestamp,
      );
      this.database.exec("COMMIT");
      return this.getTask(id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  updateTask(id, version, changes, threadId, threadBinding, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    const activityChanges = taskFieldChanges(current, changes);
    const targetProject = Object.hasOwn(changes, "projectId")
      ? this.database.prepare("SELECT id, name, workspace_path, labels FROM projects WHERE id = ?").get(changes.projectId)
      : null;
    if (Object.hasOwn(changes, "projectId") && !targetProject) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${changes.projectId}' does not exist`);
    }
    const projectChanged = Boolean(targetProject && targetProject.id !== current.projectId);
    if (projectChanged) {
      const relation = this.database.prepare(`
        SELECT 1
        FROM task_relations
        WHERE source_task_id = ? OR target_task_id = ?
        LIMIT 1
      `).get(current.id, current.id);
      if (relation) {
        throw new ApiError(
          409,
          "CROSS_PROJECT_RELATION",
          "Remove issue relations before moving the issue to another project",
        );
      }
      if (this.hasAiChatThreadProjectConflict(current.id, targetProject.id)) {
        throw new ApiError(
          409,
          "AI_CHAT_PROJECT_MOVE_BLOCKED",
          "Delete issue-linked AI conversations before moving the issue to another project",
        );
      }
    }
    const dueDate = Object.hasOwn(changes, "dueDate") ? changes.dueDate : current.dueDate;
    const recurrence = Object.hasOwn(changes, "recurrence") ? changes.recurrence : current.recurrence;
    if (recurrence && !dueDate) {
      throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires a due date");
    }

    const columns = {
      projectId: "project_id",
      title: "title",
      description: "description",
      status: "status",
      priority: "priority",
      labels: "labels",
      workflowId: "workflow_id",
      startDate: "start_date",
      dueDate: "due_date",
    };
    const assignments = [];
    const values = [];
    for (const [key, value] of Object.entries(changes)) {
      if (key === "developmentContext") {
        assignments.push("git_branch = ?", "worktree_path = ?", "worktree_branch = ?");
        values.push(
          value?.type === "branch" ? value.branch : null,
          value?.type === "worktree" ? value.path : null,
          value?.type === "worktree" ? value.branch : null,
        );
        continue;
      }
      if (key === "recurrence") {
        assignments.push("recurrence_interval = ?", "recurrence_unit = ?");
        values.push(value?.interval ?? null, value?.unit ?? null);
        continue;
      }
      if (key === "assignee") {
        assignments.push(
          "assignee_type = ?",
          "assignee_id = ?",
          "assignee_name = ?",
          "assignee_avatar_url = ?",
        );
        values.push(value.type, value.id, value.name, value.avatarUrl);
        continue;
      }
      assignments.push(`${columns[key]} = ?`);
      values.push(key === "labels" ? JSON.stringify(value) : value);
    }
    if (Object.hasOwn(changes, "status") && changes.status !== current.status) {
      const placementProjectId = projectChanged ? targetProject.id : current.projectId;
      const row = this.database.prepare(`
        SELECT MIN(sort_order) AS minimum
        FROM tasks
        WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
      `).get(placementProjectId, changes.status, current.id);
      assignments.push("sort_order = ?");
      values.push(row.minimum === null ? 1000 : row.minimum - 1000);
    }
    const storedBinding = storedThreadBinding(threadBinding, threadId);
    if (storedBinding && !Object.hasOwn(changes, "projectId")) {
      assignments.push(
        "thread_id = ?",
        "thread_codex_project_id = ?",
        "thread_codex_project_kind = ?",
        "thread_codex_host_id = ?",
        "thread_workspace_path = ?",
      );
      values.push(...storedBinding);
    }
    assignments.push("version = version + 1", "updated_at = ?");
    const timestamp = now();
    values.push(timestamp, current.id, version);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks SET ${assignments.join(", ")} WHERE id = ? AND version = ?
      `).run(...values);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      if (projectChanged) {
        this.database.prepare(`
          UPDATE projects SET updated_at = ? WHERE id IN (?, ?)
        `).run(timestamp, current.projectId, targetProject.id);
      }
      const destinationProjectId = projectChanged ? targetProject.id : current.projectId;
      const destinationProject = this.database.prepare(`
        SELECT labels FROM projects WHERE id = ?
      `).get(destinationProjectId);
      const taskLabels = Object.hasOwn(changes, "labels") ? changes.labels : current.labels;
      const projectLabels = JSON.parse(destinationProject.labels);
      const mergedLabels = [...new Set([...projectLabels, ...taskLabels])];
      if (mergedLabels.length !== projectLabels.length) {
        this.database.prepare(`
          UPDATE projects SET labels = ?, updated_at = ? WHERE id = ?
        `).run(JSON.stringify(mergedLabels), timestamp, destinationProjectId);
      }
      this.#recordTaskActivity(current.id, actor, activityChanges, timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  moveTask(id, version, status, sortOrder, threadId, threadBinding, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    if (current.archivedAt !== null) {
      throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be moved");
    }
    if (status !== current.status && sortOrder === undefined) {
      const row = this.database.prepare(`
        SELECT MIN(sort_order) AS minimum
        FROM tasks
        WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
      `).get(current.projectId, status, current.id);
      sortOrder = row.minimum === null ? 1000 : row.minimum - 1000;
    } else if (sortOrder === undefined) {
      const row = this.database.prepare(`
        SELECT COALESCE(MAX(sort_order), 0) AS maximum
        FROM tasks
        WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
      `).get(current.projectId, status, current.id);
      sortOrder = row.maximum + 1000;
    }

    const timestamp = now();
    const storedBinding = storedThreadBinding(threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET status = ?, sort_order = ?, ${threadAssignment} version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(status, sortOrder, ...(storedBinding ?? []), timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#recordTaskActivity(
        current.id,
        actor,
        taskFieldChanges(current, { status }),
        timestamp,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  archiveTask(id, version, threadId, threadBinding, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    const timestamp = now();
    const storedBinding = storedThreadBinding(threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET archived_at = ?, ${threadAssignment} version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(timestamp, ...(storedBinding ?? []), timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#recordTaskActivity(
        current.id,
        actor,
        [{ field: "archivedAt", before: current.archivedAt, after: timestamp }],
        timestamp,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  restoreTask(id, version, threadId, threadBinding, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    if (current.archivedAt === null) {
      throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be restored");
    }
    const timestamp = now();
    const storedBinding = storedThreadBinding(threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET archived_at = NULL, ${threadAssignment} version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(...(storedBinding ?? []), timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#recordTaskActivity(
        current.id,
        actor,
        [{ field: "archivedAt", before: current.archivedAt, after: null }],
        timestamp,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  deleteArchivedTask(id, version) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requireTask(id);
      this.#requireVersion(current, version);
      if (current.archivedAt === null) {
        throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be deleted");
      }
      const attachmentIds = this.database.prepare(
        "SELECT id FROM attachments WHERE task_id = ? ORDER BY created_at, id",
      ).all(current.id).map((attachment) => attachment.id);
      const result = this.database.prepare(
        "DELETE FROM tasks WHERE id = ? AND version = ? AND archived_at IS NOT NULL",
      ).run(current.id, version);
      if (result.changes !== 1) this.#throwMissingOrConflict(id, version);
      this.database.exec("COMMIT");
      return { task: current, attachmentIds };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  addTaskRelation(id, version, type, relatedId, threadId, threadBinding, actor) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const relatedTask = this.#requireTask(relatedId);
      this.#requireVersion(task, version);
      this.#validateRelationTasks(task, relatedTask);

      const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(
        type,
        task.id,
        relatedTask.id,
      );
      if (relationType === "parent") {
        this.#assertNoParentCycle(task.id, relatedTask.id);
        const existing = this.database.prepare(`
          SELECT source_task_id
          FROM task_relations
          WHERE relation_type = 'parent' AND target_task_id = ?
        `).get(task.id);
        if (existing?.source_task_id === relatedTask.id) {
          throw new ApiError(409, "RELATION_EXISTS", "This parent relation already exists");
        }
        if (existing) {
          this.database.prepare(`
            DELETE FROM task_relations
            WHERE relation_type = 'parent' AND target_task_id = ?
          `).run(task.id);
        }
      } else {
        const existing = this.database.prepare(`
          SELECT 1
          FROM task_relations
          WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
        `).get(relationType, sourceTaskId, targetTaskId);
        if (existing) {
          throw new ApiError(409, "RELATION_EXISTS", "This issue relation already exists");
        }
      }

      const timestamp = now();
      const previousRelation = type === "parent" && task.relations.parent
        ? relationActivityValue(type, task.relations.parent)
        : null;
      this.database.prepare(`
        INSERT INTO task_relations (
          relation_type, source_task_id, target_task_id, created_at
        ) VALUES (?, ?, ?, ?)
      `).run(relationType, sourceTaskId, targetTaskId, timestamp);
      this.#touchTask(task.id, version, threadId, threadBinding, timestamp);
      this.#recordTaskActivity(task.id, actor, [{
        field: "relation",
        before: previousRelation,
        after: relationActivityValue(type, relatedTask),
      }], timestamp);
      this.database.exec("COMMIT");
      return {
        task: this.getTask(task.id),
        relatedTask: this.getTask(relatedTask.id),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  removeTaskRelation(id, version, type, relatedId, threadId, threadBinding, actor) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const relatedTask = this.#requireTask(relatedId);
      this.#requireVersion(task, version);
      this.#validateRelationTasks(task, relatedTask);
      const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(
        type,
        task.id,
        relatedTask.id,
      );
      const removed = this.database.prepare(`
        DELETE FROM task_relations
        WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
      `).run(relationType, sourceTaskId, targetTaskId);
      if (removed.changes !== 1) {
        throw new ApiError(404, "RELATION_NOT_FOUND", "This issue relation does not exist");
      }
      const timestamp = now();
      this.#touchTask(task.id, version, threadId, threadBinding, timestamp);
      this.#recordTaskActivity(task.id, actor, [{
        field: "relation",
        before: relationActivityValue(type, relatedTask),
        after: null,
      }], timestamp);
      this.database.exec("COMMIT");
      return {
        task: this.getTask(task.id),
        relatedTask: this.getTask(relatedTask.id),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listTaskActivities(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM task_activities
      WHERE task_id = ?
      ORDER BY created_at, id
    `).all(task.id).map(taskActivityFromRow);
  }

  listComments(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM comments
      WHERE task_id = ?
      ORDER BY created_at, id
    `).all(task.id).map((row) => this.#commentWithAttachments(row));
  }

  createComment(taskId, input) {
    const task = this.#requireTask(taskId);
    const id = randomUUID();
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO comments (
        id, task_id, body, thread_id, thread_codex_project_id, thread_codex_project_kind,
        thread_codex_host_id, thread_workspace_path,
        author_type, author_id, author_name, author_avatar_url,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      task.id,
      input.body,
      ...(storedThreadBinding(input.threadBinding, input.threadId) ?? [null, null, null, null, null]),
      input.actor.type,
      input.actor.id,
      input.actor.name,
      input.actor.avatarUrl,
      timestamp,
      timestamp,
    );
    return this.getComment(id);
  }

  getComment(id) {
    const row = this.database.prepare("SELECT * FROM comments WHERE id = ?").get(id);
    return row ? this.#commentWithAttachments(row) : null;
  }

  updateComment(id, version, body, threadId, threadBinding) {
    const current = this.#requireComment(id);
    this.#requireCommentVersion(current, version);
    const storedBinding = storedThreadBinding(threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    const result = this.database.prepare(`
      UPDATE comments
      SET body = ?, ${threadAssignment} version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(body, ...(storedBinding ?? []), now(), id, version);
    if (result.changes !== 1) {
      this.#throwMissingCommentOrConflict(id, version);
    }
    return this.getComment(id);
  }

  deleteComment(id, version) {
    const current = this.#requireComment(id);
    this.#requireCommentVersion(current, version);
    const result = this.database.prepare(`
      DELETE FROM comments WHERE id = ? AND version = ?
    `).run(id, version);
    if (result.changes !== 1) {
      this.#throwMissingCommentOrConflict(id, version);
    }
    return current;
  }

  listAttachments(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE task_id = ? AND comment_id IS NULL
      ORDER BY created_at, id
    `).all(task.id).map(attachmentFromRow);
  }

  createAttachment(taskId, input) {
    const task = this.#requireTask(taskId);
    this.database.prepare(`
      INSERT INTO attachments (id, task_id, comment_id, filename, content_type, size, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?)
    `).run(input.id, task.id, input.filename, input.contentType, input.size, now());
    return this.getAttachment(input.id);
  }

  listCommentAttachments(commentId) {
    const comment = this.database.prepare("SELECT id FROM comments WHERE id = ?").get(commentId);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
    }
    return this.#attachmentsForComment(commentId);
  }

  createCommentAttachment(commentId, input) {
    const comment = this.#requireComment(commentId);
    this.database.prepare(`
      INSERT INTO attachments (id, task_id, comment_id, filename, content_type, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, comment.taskId, comment.id, input.filename, input.contentType, input.size, now());
    return this.getAttachment(input.id);
  }

  getAttachment(id) {
    const row = this.database.prepare("SELECT * FROM attachments WHERE id = ?").get(id);
    return row ? attachmentFromRow(row) : null;
  }

  deleteAttachment(id) {
    const attachment = this.getAttachment(id);
    if (!attachment) {
      throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
    }
    this.database.prepare("DELETE FROM attachments WHERE id = ?").run(id);
    return attachment;
  }

  #commentWithAttachments(row) {
    const comment = commentFromRow(row);
    comment.attachments = this.#attachmentsForComment(comment.id);
    return comment;
  }

  #aiChatThreadWithCurrentRun(row) {
    const thread = aiChatThreadFromRow(row);
    const currentRun = this.database.prepare(`
      SELECT * FROM ai_chat_runs
      WHERE thread_id = ? AND status = 'running'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `).get(thread.id);
    thread.currentRun = currentRun ? aiChatRunFromRow(currentRun) : null;
    const todoRows = this.database.prepare(`
      SELECT id, thread_id, run_id, data, created_at
      FROM ai_chat_events
      WHERE thread_id = ? AND type = 'todo_list'
      ORDER BY created_at DESC, rowid DESC
    `).all(thread.id);
    thread.latestTodo = todoRows
      .filter((row) => !thread.currentRun || row.run_id === thread.currentRun.id)
      .map(parseAiChatTodoProgress)
      .find(Boolean) ?? null;
    return thread;
  }

  #commentsForTaskActivity(taskIds) {
    const commentsByTask = new Map(taskIds.map((taskId) => [taskId, []]));
    for (let offset = 0; offset < taskIds.length; offset += 400) {
      const chunk = taskIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.database.prepare(`
        SELECT
          id, task_id,
          CASE WHEN thread_id IS NULL THEN NULL ELSE substr(body, 1, 512) END AS body,
          thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          author_type, author_id, author_name,
          author_avatar_url, version, updated_at
        FROM comments
        WHERE task_id IN (${placeholders})
        ORDER BY task_id, id
      `).all(...chunk);
      for (const row of rows) commentsByTask.get(row.task_id)?.push(row);
    }
    return commentsByTask;
  }

  #activitiesForTasks(taskIds) {
    const activitiesByTask = new Map(taskIds.map((taskId) => [taskId, []]));
    for (let offset = 0; offset < taskIds.length; offset += 400) {
      const chunk = taskIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.database.prepare(`
        SELECT
          id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, created_at
        FROM task_activities
        WHERE task_id IN (${placeholders})
        ORDER BY task_id, created_at, id
      `).all(...chunk);
      for (const row of rows) activitiesByTask.get(row.task_id)?.push(row);
    }
    return activitiesByTask;
  }

  #taskPreviewImages(taskIds) {
    const imagesByTask = new Map();
    for (let offset = 0; offset < taskIds.length; offset += 400) {
      const chunk = taskIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.database.prepare(`
        SELECT * FROM attachments
        WHERE task_id IN (${placeholders})
          AND comment_id IS NULL
          AND content_type LIKE 'image/%'
        ORDER BY task_id, created_at, id
      `).all(...chunk);
      for (const row of rows) {
        if (!imagesByTask.has(row.task_id)) imagesByTask.set(row.task_id, attachmentFromRow(row));
      }
    }
    return imagesByTask;
  }

  #attachmentsForComment(commentId) {
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE comment_id = ?
      ORDER BY created_at, id
    `).all(commentId).map(attachmentFromRow);
  }

  #notificationWithRecipients(row) {
    const recipients = this.database.prepare(`
      SELECT recipient_type, recipient_id, read_at, handled_at, version
      FROM notification_recipients
      WHERE notification_id = ?
      ORDER BY recipient_type, recipient_id
    `).all(row.id).map((recipient) => ({
      type: recipient.recipient_type,
      id: recipient.recipient_id,
      readAt: recipient.read_at,
      handledAt: recipient.handled_at,
      version: recipient.version,
    }));
    return notificationFromRow(row, recipients);
  }

  #taskWithRelations(row) {
    const task = taskFromRow(row);
    const parent = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.target_task_id = ?
    `).get(task.id);
    const subIssues = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const blockedBy = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.target_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const blocks = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const related = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = CASE
        WHEN task_relations.source_task_id = ? THEN task_relations.target_task_id
        ELSE task_relations.source_task_id
      END
      WHERE task_relations.relation_type = 'related'
        AND (
          task_relations.source_task_id = ?
          OR task_relations.target_task_id = ?
        )
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id, task.id, task.id);
    task.relations = {
      parent: parent ? taskRelationSummaryFromRow(parent) : null,
      subIssues: subIssues.map(taskRelationSummaryFromRow),
      blockedBy: blockedBy.map(taskRelationSummaryFromRow),
      blocks: blocks.map(taskRelationSummaryFromRow),
      related: related.map(taskRelationSummaryFromRow),
    };
    return task;
  }

  #validateRelationTasks(task, relatedTask) {
    if (task.id === relatedTask.id) {
      throw new ApiError(400, "SELF_RELATION", "An issue cannot be related to itself");
    }
    if (task.projectId !== relatedTask.projectId) {
      throw new ApiError(400, "CROSS_PROJECT_RELATION", "Issue relations must stay within one project");
    }
  }

  #relationEndpoints(type, taskId, relatedTaskId) {
    if (type === "parent") {
      return {
        relationType: "parent",
        sourceTaskId: relatedTaskId,
        targetTaskId: taskId,
      };
    }
    if (type === "blocks") {
      return {
        relationType: "blocks",
        sourceTaskId: taskId,
        targetTaskId: relatedTaskId,
      };
    }
    if (type === "blocked_by") {
      return {
        relationType: "blocks",
        sourceTaskId: relatedTaskId,
        targetTaskId: taskId,
      };
    }
    const [sourceTaskId, targetTaskId] = [taskId, relatedTaskId].sort();
    return { relationType: "related", sourceTaskId, targetTaskId };
  }

  #assertNoParentCycle(childId, parentId) {
    const cycle = this.database.prepare(`
      WITH RECURSIVE ancestors(id) AS (
        SELECT source_task_id
        FROM task_relations
        WHERE relation_type = 'parent' AND target_task_id = ?
        UNION
        SELECT task_relations.source_task_id
        FROM task_relations
        JOIN ancestors ON task_relations.target_task_id = ancestors.id
        WHERE task_relations.relation_type = 'parent'
      )
      SELECT 1 FROM ancestors WHERE id = ?
    `).get(parentId, childId);
    if (cycle) {
      throw new ApiError(409, "RELATION_CYCLE", "This parent would create a cycle");
    }
  }

  #recordTaskActivity(taskId, actor, changes, timestamp) {
    if (changes.length === 0) return;
    this.database.prepare(`
      INSERT INTO task_activities (
        id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      taskId,
      actor.type,
      actor.id,
      actor.name,
      actor.avatarUrl,
      JSON.stringify(changes),
      timestamp,
    );
  }

  #touchTask(id, version, threadId, threadBinding, timestamp) {
    const storedBinding = storedThreadBinding(threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    const result = this.database.prepare(`
      UPDATE tasks
      SET ${threadAssignment} version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(...(storedBinding ?? []), timestamp, id, version);
    if (result.changes !== 1) {
      this.#throwMissingOrConflict(id, version);
    }
  }

  #requireTask(id) {
    const task = this.getTask(id);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
    }
    return task;
  }

  #requireComment(id) {
    const comment = this.getComment(id);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
    }
    return comment;
  }

  #requireVersion(task, expectedVersion) {
    if (task.version !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
        expectedVersion,
        actualVersion: task.version,
      });
    }
  }

  #requireCommentVersion(comment, expectedVersion) {
    if (comment.version !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Comment was changed by another client", {
        expectedVersion,
        actualVersion: comment.version,
      });
    }
  }

  #throwMissingOrConflict(id, expectedVersion) {
    const task = this.getTask(id);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
    }
    throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
      expectedVersion,
      actualVersion: task.version,
    });
  }

  #throwMissingCommentOrConflict(id, expectedVersion) {
    const comment = this.getComment(id);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
    }
    throw new ApiError(409, "VERSION_CONFLICT", "Comment was changed by another client", {
      expectedVersion,
      actualVersion: comment.version,
    });
  }
}
