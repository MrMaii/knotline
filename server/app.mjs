import { createHmac, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  DEFAULT_PROJECT_ID,
  JIRA_PROJECT_ID,
  TASK_STATUSES,
  isTaskPriority,
  isTaskStatus,
} from "../shared/domain.mjs";
import { resolveCodexExecutable } from "../shared/codex-executable.mjs";
import { withoutKnotlineLauncherEnvironment } from "../shared/codex-environment.mjs";
import { executableCommand } from "../shared/executable-command.mjs";
import { normalizeWorkflowSnapshot } from "../shared/workflow-control-flow.mjs";
import { AiChatService } from "./ai-chat.mjs";
import { resolveAiWorkspace, resolveMappedAiWorkspace } from "./ai-chat-catalog.mjs";
import { createCloudConfigStore } from "./cloud-config.mjs";
import {
  CloudProxyError,
  createCloudProxy,
  isLocalCompanionRoute,
} from "./cloud-proxy.mjs";
import { ApiError, KnotlineDatabase } from "./database.mjs";
import { createGraphService } from "./graph-service.mjs";
import { createGovernanceService } from "./governance-service.mjs";
import { createNotificationService } from "./notification-service.mjs";
import { createOrchestrationStore } from "./orchestration-store.mjs";
import { createJiraConfigStore } from "./jira-config.mjs";
import { createJiraIntegration } from "./jira-integration.mjs";
import { createKnowledgeService } from "./knowledge-service.mjs";
import { ProjectSummaryService } from "./project-summary.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const JSON_BODY_LIMIT = 1024 * 1024;
const ATTACHMENT_BODY_LIMIT = 25 * 1024 * 1024;
const AI_CHAT_TURN_BODY_LIMIT = 25 * 1024 * 1024;
const AI_CHAT_ATTACHMENT_LIMIT = 10;
const AI_CHAT_SKILL_MARKER = "\uFFFC";
const HOST_RUNTIME_TTL_MS = 3_000;
const CODEX_PLAN_TAIL_BYTES = 16 * 1024 * 1024;
const INLINE_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
]);
const PROJECT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const TRUSTED_EMBED_ORIGINS = new Set(["app://-"]);
const CODEX_AGENT_ACTOR = {
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(body);
}

function sendEmpty(response, status, headers = {}) {
  response.writeHead(status, { "cache-control": "no-store", ...headers });
  response.end();
}

function toFetchRequest(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const init = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = Readable.toWeb(request);
    init.duplex = "half";
  }
  return new Request(`http://127.0.0.1${request.url}`, init);
}

async function sendFetchResponse(response, upstream) {
  response.statusCode = upstream.status;
  response.statusMessage = upstream.statusText;
  for (const [name, value] of upstream.headers) {
    if (
      name === "connection"
      || name === "content-encoding"
      || name === "content-length"
      || name === "set-cookie"
      || name === "transfer-encoding"
    ) {
      continue;
    }
    response.setHeader(name, value);
  }
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) response.setHeader("set-cookie", cookies);
  if (!upstream.body) {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const body = Readable.fromWeb(upstream.body);
    body.once("error", reject);
    response.once("finish", resolve);
    body.pipe(response);
  });
}

function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isTrustedNetworkHost(hostname) {
  const host = normalizeHostname(hostname);
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  if (isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    return octets[0] === 127
      || octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254);
  }
  if (isIP(host) === 6) {
    return host.startsWith("fc")
      || host.startsWith("fd")
      || /^fe[89ab]/.test(host);
  }
  return false;
}

function assertTrustedNetworkRequest(request, allowOpaqueOrigin = false) {
  let host;
  try {
    host = new URL(`http://${request.headers.host ?? ""}`).hostname;
  } catch {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be local or private");
  }
  if (!isTrustedNetworkHost(host)) {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be local or private");
  }

  const origin = request.headers.origin;
  if (!origin) return;
  if (TRUSTED_EMBED_ORIGINS.has(origin)) return;
  if (allowOpaqueOrigin && origin === "null") return;
  let originHost;
  try {
    originHost = new URL(origin).hostname;
  } catch {
    throw new ApiError(403, "INVALID_ORIGIN", "Request Origin must be local or private");
  }
  if (!isTrustedNetworkHost(originHost)) {
    throw new ApiError(403, "INVALID_ORIGIN", "Request Origin must be local or private");
  }
}

function assertLoopbackRequest(request) {
  const address = request.socket.remoteAddress;
  if (
    address !== "127.0.0.1"
    && address !== "::1"
    && address !== "::ffff:127.0.0.1"
  ) {
    throw new ApiError(403, "LOCAL_ONLY", "This endpoint is only available on this device");
  }
}

function assertPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "Request body must be a JSON object");
  }
}

function assertAllowedKeys(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ApiError(400, "UNKNOWN_FIELD", `Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
}

function assertAllowedQuery(searchParams, allowed, routeLabel) {
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `${routeLabel} does not accept query parameter '${key}'`);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_QUERY_PARAMETER", `Query parameter '${key}' cannot be repeated`);
    }
  }
}

function assertNoQuery(searchParams, routeLabel) {
  assertAllowedQuery(searchParams, new Set(), routeLabel);
}

function decodeRouteSegment(value, name) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ApiError(400, "INVALID_PATH", `${name} contains invalid encoding`);
  }
  if (!decoded || decoded.length > 256 || decoded.includes("\0")) {
    throw new ApiError(400, "INVALID_PATH", `${name} is invalid`);
  }
  return decoded;
}

function isLoopbackAddress(value) {
  if (typeof value !== "string") return false;
  const address = value.toLowerCase().split("%", 1)[0];
  return address === "::1"
    || address === "127.0.0.1"
    || address.startsWith("127.")
    || address === "::ffff:127.0.0.1"
    || address.startsWith("::ffff:127.");
}

function assertAiLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw new ApiError(403, "LOCAL_AI_LOOPBACK_REQUIRED", "Local AI routes are only available from this device");
  }
}

function stringField(value, name, { required = false, nullable = false, maxLength }) {
  if (value === undefined) {
    if (required) {
      throw new ApiError(400, "INVALID_FIELD", `'${name}' is required`);
    }
    return undefined;
  }
  if (nullable && value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must be a string${nullable ? " or null" : ""}`);
  }
  const normalized = value.trim();
  if (required && normalized.length === 0) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  if (normalized.length > maxLength) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot exceed ${maxLength} characters`);
  }
  return normalized;
}

function pathField(value, name) {
  const normalized = stringField(value, name, { nullable: true, maxLength: 4096 });
  if (normalized === "") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  if (normalized?.includes("\0")) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot contain null bytes`);
  }
  return normalized;
}

function parseDueDate(value, name = "dueDate") {
  const date = stringField(value, name, { nullable: true, maxLength: 10 });
  if (date !== null && date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must use YYYY-MM-DD`);
  }
  return date;
}

function parseDevelopmentContext(value) {
  if (value === null) return null;
  assertPlainObject(value);
  if (value.type === "branch") {
    assertAllowedKeys(value, new Set(["type", "branch"]));
    return {
      type: "branch",
      branch: stringField(value.branch, "developmentContext.branch", { required: true, maxLength: 512 }),
    };
  }
  if (value.type === "worktree") {
    assertAllowedKeys(value, new Set(["type", "path", "branch"]));
    const worktreePath = stringField(value.path, "developmentContext.path", { required: true, maxLength: 4096 });
    if (worktreePath.includes("\0")) {
      throw new ApiError(400, "INVALID_FIELD", "'developmentContext.path' cannot contain null bytes");
    }
    return {
      type: "worktree",
      path: worktreePath,
      branch: stringField(value.branch ?? null, "developmentContext.branch", { nullable: true, maxLength: 512 }),
    };
  }
  throw new ApiError(400, "INVALID_FIELD", "'developmentContext.type' must be branch or worktree");
}

function parseRecurrence(value) {
  if (value === null) return null;
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["interval", "unit"]));
  if (!Number.isSafeInteger(value.interval) || value.interval < 1 || value.interval > 365) {
    throw new ApiError(400, "INVALID_FIELD", "'recurrence.interval' must be an integer from 1 to 365");
  }
  if (!["day", "week", "month", "year"].includes(value.unit)) {
    throw new ApiError(400, "INVALID_FIELD", "'recurrence.unit' must be day, week, month, or year");
  }
  return { interval: value.interval, unit: value.unit };
}

function parseVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApiError(400, "INVALID_FIELD", "'version' must be a positive integer");
  }
  return value;
}

function parseWorkflowVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(400, "INVALID_FIELD", "'version' must be a non-negative integer");
  }
  return value;
}

function parseWorkflowWorkspace(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["version", "tabs", "activeWorkflowId", "snapshots"]));
  if (value.version !== 1) {
    throw new ApiError(400, "INVALID_FIELD", "'workspace.version' must be 1");
  }
  if (!Array.isArray(value.tabs) || value.tabs.length === 0 || value.tabs.length > 100) {
    throw new ApiError(400, "INVALID_FIELD", "'workspace.tabs' must contain 1 to 100 workflows");
  }
  const tabs = value.tabs.map((tab, index) => {
    assertPlainObject(tab);
    assertAllowedKeys(tab, new Set(["id", "name"]));
    return {
      id: stringField(tab.id, `workspace.tabs[${index}].id`, { required: true, maxLength: 128 }),
      name: stringField(tab.name, `workspace.tabs[${index}].name`, { required: true, maxLength: 120 }),
    };
  });
  if (new Set(tabs.map((tab) => tab.id)).size !== tabs.length) {
    throw new ApiError(400, "INVALID_FIELD", "'workspace.tabs' ids must be unique");
  }
  const activeWorkflowId = stringField(value.activeWorkflowId, "workspace.activeWorkflowId", {
    required: true,
    maxLength: 128,
  });
  if (!tabs.some((tab) => tab.id === activeWorkflowId)) {
    throw new ApiError(400, "INVALID_FIELD", "'workspace.activeWorkflowId' must reference a workflow tab");
  }
  assertPlainObject(value.snapshots);
  const snapshots = {};
  for (const tab of tabs) {
    const snapshot = value.snapshots[tab.id];
    assertPlainObject(snapshot);
    assertAllowedKeys(snapshot, new Set(["nodes", "edges", "flow", "selectedNodeId"]));
    if (!Array.isArray(snapshot.nodes) || snapshot.nodes.length > 10_000) {
      throw new ApiError(400, "INVALID_FIELD", `'workspace.snapshots.${tab.id}.nodes' must be an array`);
    }
    if (snapshot.flow === undefined && (!Array.isArray(snapshot.edges) || snapshot.edges.length > 20_000)) {
      throw new ApiError(400, "INVALID_FIELD", `'workspace.snapshots.${tab.id}.edges' must be an array`);
    }
    if (snapshot.flow !== undefined && snapshot.edges !== undefined) {
      throw new ApiError(400, "INVALID_FIELD", `'workspace.snapshots.${tab.id}' cannot contain both 'flow' and 'edges'`);
    }
    const selectedNodeId = stringField(
      snapshot.selectedNodeId ?? null,
      `workspace.snapshots.${tab.id}.selectedNodeId`,
      { nullable: true, maxLength: 256 },
    );
    try {
      snapshots[tab.id] = normalizeWorkflowSnapshot({
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        flow: snapshot.flow,
        selectedNodeId,
      });
    } catch (error) {
      throw new ApiError(
        400,
        "INVALID_FIELD",
        `'workspace.snapshots.${tab.id}' is not a valid workflow: ${error.message}`,
      );
    }
  }
  return { version: 1, tabs, activeWorkflowId, snapshots };
}

function parseWorkflowWorkspaceSave(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "workspace"]));
  return {
    version: parseWorkflowVersion(body.version),
    workspace: parseWorkflowWorkspace(body.workspace),
  };
}

function parseGraphLayout(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["projectId", "version", "x", "y", "width", "height"]));
  const finiteNumber = (value, name, { required = true } = {}) => {
    if (value === undefined && !required) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000_000) {
      throw new ApiError(400, "INVALID_FIELD", `'${name}' must be a finite number`);
    }
    return value;
  };
  const width = finiteNumber(body.width, "width", { required: false });
  const height = finiteNumber(body.height, "height", { required: false });
  if (width !== undefined && width <= 0) {
    throw new ApiError(400, "INVALID_FIELD", "'width' must be greater than zero");
  }
  if (height !== undefined && height <= 0) {
    throw new ApiError(400, "INVALID_FIELD", "'height' must be greater than zero");
  }
  return {
    projectId: stringField(body.projectId, "projectId", { required: true, maxLength: 128 }),
    version: parseWorkflowVersion(body.version),
    x: finiteNumber(body.x, "x"),
    y: finiteNumber(body.y, "y"),
    width,
    height,
  };
}

function parseCanvasNodeAssignment(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["nodeId"]));
  return {
    nodeId: stringField(body.nodeId, "nodeId", { required: true, maxLength: 512 }),
  };
}

function parseGraphResolve(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["sourceNodeId", "targetNodeId"]));
  return {
    sourceNodeId: stringField(body.sourceNodeId, "sourceNodeId", { required: true, maxLength: 256 }),
    targetNodeId: stringField(body.targetNodeId, "targetNodeId", { required: true, maxLength: 256 }),
  };
}

function parseGraphCommand(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "sourceNodeId", "targetNodeId", "actionType", "idempotencyKey", "input",
  ]));
  if (![
    "create_relation",
    "create_task_relation",
    "intake_demand",
    "assign_reviewer",
    "decide_review",
    "create_change_request",
    "decide_task_review",
    "comment_on_task",
    "reassign_task_review",
    "postpone_task_review",
    "create_team",
    "execute_demand",
    "remember_context",
    "queue_demand",
    "join_backlog",
    "join_approval_pool",
    "assign_artifact_review",
    "assign_agent",
    "bind_skill",
    "connect_scheduled_trigger",
    "bind_knowledge",
    "attach_context",
    "propose_knowledge_update",
    "decide_execution_review",
    "decide_knowledge_proposal",
    "message_agent",
  ].includes(body.actionType)) {
    throw new ApiError(400, "INVALID_FIELD", "Unknown graph command action type");
  }
  assertPlainObject(body.input);
  return {
    sourceNodeId: stringField(body.sourceNodeId, "sourceNodeId", { required: true, maxLength: 256 }),
    targetNodeId: stringField(body.targetNodeId, "targetNodeId", { required: true, maxLength: 256 }),
    actionType: body.actionType,
    idempotencyKey: stringField(body.idempotencyKey, "idempotencyKey", { required: true, maxLength: 256 }),
    input: body.input,
  };
}

function parseNotificationUpdate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["read", "handled"]));
  if (body.read !== undefined && typeof body.read !== "boolean") {
    throw new ApiError(400, "INVALID_FIELD", "'read' must be a boolean");
  }
  if (body.handled !== undefined && typeof body.handled !== "boolean") {
    throw new ApiError(400, "INVALID_FIELD", "'handled' must be a boolean");
  }
  if (body.read !== true && body.handled !== true) {
    throw new ApiError(400, "INVALID_BODY", "Notification update must mark read or handled");
  }
  return { read: body.read === true, handled: body.handled === true };
}

function parseNotificationAction(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["comment", "reviewerAgentId", "dueAt", "idempotencyKey"]));
  return {
    comment: stringField(body.comment ?? "", "comment", { maxLength: 10_000 }),
    reviewerAgentId: stringField(body.reviewerAgentId ?? null, "reviewerAgentId", { nullable: true, maxLength: 128 }),
    dueAt: stringField(body.dueAt ?? null, "dueAt", { nullable: true, maxLength: 64 }),
    idempotencyKey: stringField(body.idempotencyKey ?? null, "idempotencyKey", { nullable: true, maxLength: 256 }),
  };
}

function parseAgentProfileCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["name", "role", "skillId", "provider", "model"]));
  if (!["leader", "executor", "reviewer", "approver", "observer"].includes(body.role)) {
    throw new ApiError(400, "INVALID_FIELD", "Unknown Agent role");
  }
  const skillId = stringField(body.skillId ?? null, "skillId", { nullable: true, maxLength: 256 });
  return {
    name: stringField(body.name, "name", { required: true, maxLength: 120 }),
    role: body.role,
    skillId: skillId || null,
    provider: stringField(body.provider ?? null, "provider", { nullable: true, maxLength: 128 }) || null,
    model: stringField(body.model ?? null, "model", { nullable: true, maxLength: 256 }) || null,
  };
}

function parseAgentProfileRename(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["name"]));
  return {
    name: stringField(body.name, "name", { required: true, maxLength: 120 }),
  };
}

function parseDemandCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["title", "description", "acceptanceCriteria"]));
  if (!Array.isArray(body.acceptanceCriteria) || body.acceptanceCriteria.length > 20) {
    throw new ApiError(400, "INVALID_FIELD", "'acceptanceCriteria' must be an array with at most 20 entries");
  }
  return {
    title: stringField(body.title, "title", { required: true, maxLength: 240 }),
    description: stringField(body.description ?? "", "description", { maxLength: 20_000 }),
    acceptanceCriteria: body.acceptanceCriteria.map((value, index) => stringField(
      value,
      `acceptanceCriteria[${index}]`,
      { required: true, maxLength: 500 },
    )),
  };
}

function parseBacklogCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["title"]));
  return {
    title: stringField(body.title, "title", { required: true, maxLength: 120 }),
  };
}

function parseSkillNodeCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["skillId"]));
  return {
    skillId: stringField(body.skillId, "skillId", { required: true, maxLength: 256 }),
  };
}

function parseScheduledTriggerCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["prompt", "intervalMinutes", "enabled"]));
  if (!Number.isInteger(body.intervalMinutes) || body.intervalMinutes < 1 || body.intervalMinutes > 525_600) {
    throw new ApiError(400, "INVALID_FIELD", "'intervalMinutes' must be an integer from 1 to 525600");
  }
  if (typeof body.enabled !== "boolean") {
    throw new ApiError(400, "INVALID_FIELD", "'enabled' must be a boolean");
  }
  return {
    prompt: stringField(body.prompt, "prompt", { required: true, maxLength: 50_000 }),
    intervalMinutes: body.intervalMinutes,
    enabled: body.enabled,
  };
}

function parseScheduledTriggerUpdate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["enabled"]));
  if (typeof body.enabled !== "boolean") {
    throw new ApiError(400, "INVALID_FIELD", "'enabled' must be a boolean");
  }
  return { enabled: body.enabled };
}

function parseModelSelection(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["provider", "model", "reasoningEffort"]));
  const reasoningEffort = stringField(body.reasoningEffort, "reasoningEffort", { maxLength: 128 });
  return {
    provider: stringField(body.provider, "provider", { required: true, maxLength: 128 }),
    model: stringField(body.model, "model", { required: true, maxLength: 256 }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

function parseMapItemCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["kind", "title", "content"]));
  if (!["prompt", "question", "constraint", "background_material"].includes(body.kind)) {
    throw new ApiError(400, "INVALID_FIELD", "Unknown Map item kind");
  }
  return {
    kind: body.kind,
    title: stringField(body.title, "title", { required: true, maxLength: 240 }),
    content: stringField(body.content ?? "", "content", { maxLength: 50_000 }),
  };
}

function parseNodeRunRuntime(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["sessionId", "status", "error", "finalMessage"]));
  if (!["idle", "working", "waiting", "blocked", "paused", "offline"].includes(body.status)) {
    throw new ApiError(400, "INVALID_FIELD", "Unknown Agent runtime status");
  }
  return {
    sessionId: stringField(body.sessionId, "sessionId", { required: true, maxLength: 256 }),
    status: body.status,
    error: stringField(body.error ?? null, "error", { nullable: true, maxLength: 10_000 }),
    finalMessage: stringField(body.finalMessage ?? null, "finalMessage", { nullable: true, maxLength: 200_000 }),
  };
}

function parseNodeRunProgress(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["status", "comment"]));
  if (!["running", "waiting", "blocked"].includes(body.status)) {
    throw new ApiError(400, "INVALID_FIELD", "Node progress status must be running, waiting, or blocked");
  }
  return {
    status: body.status,
    comment: stringField(body.comment ?? "", "comment", { maxLength: 10_000 }),
  };
}

function parseNodeRunControl(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["action"]));
  if (!["pause", "resume"].includes(body.action)) {
    throw new ApiError(400, "INVALID_FIELD", "Task Bench action must be pause or resume");
  }
  return { action: body.action };
}

function parseDelivery(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["summary", "evidence"]));
  return {
    summary: stringField(body.summary, "summary", { required: true, maxLength: 20_000 }),
    evidence: stringField(body.evidence ?? "", "evidence", { maxLength: 50_000 }),
  };
}

function parseAgentRuntimeMessage(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["mode", "message"]));
  if (!["followup", "steer", "inject"].includes(body.mode)) {
    throw new ApiError(400, "INVALID_FIELD", "Agent message mode must be followup, steer, or inject");
  }
  return {
    mode: body.mode,
    message: stringField(body.message, "message", { required: true, maxLength: 50_000 }),
  };
}

function parseKnowledgeInitialize(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["leaderAgentId"]));
  return {
    leaderAgentId: stringField(body.leaderAgentId, "leaderAgentId", { required: true, maxLength: 128 }),
  };
}

function parseKnowledgeProposal(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["title", "content"]));
  return {
    title: stringField(body.title, "title", { required: true, maxLength: 240 }),
    content: stringField(body.content, "content", { required: true, maxLength: 100_000 }),
  };
}

function parseSortOrder(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000) {
    throw new ApiError(400, "INVALID_FIELD", "'sortOrder' must be a finite number between -1000000000000 and 1000000000000");
  }
  return value;
}

function parseLabels(value) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new ApiError(400, "INVALID_FIELD", "'labels' must be an array with at most 20 entries");
  }
  const labels = value.map((label) => {
    if (typeof label !== "string") {
      throw new ApiError(400, "INVALID_FIELD", "Every label must be a string");
    }
    const normalized = label.trim();
    if (normalized.length === 0 || normalized.length > 64) {
      throw new ApiError(400, "INVALID_FIELD", "Labels must contain 1 to 64 characters");
    }
    return normalized;
  });
  if (new Set(labels).size !== labels.length) {
    throw new ApiError(400, "INVALID_FIELD", "Labels must be unique");
  }
  return labels;
}

function parseStatus(value, fallback) {
  const result = value ?? fallback;
  if (!isTaskStatus(result)) {
    throw new ApiError(400, "INVALID_FIELD", `'status' must be one of: ${TASK_STATUSES.join(", ")}`);
  }
  return result;
}

function parsePriority(value, fallback) {
  const result = value ?? fallback;
  if (!isTaskPriority(result)) {
    throw new ApiError(400, "INVALID_FIELD", "'priority' must be none, urgent, high, medium, or low");
  }
  return result;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function validateProjectId(value, { required = true } = {}) {
  const id = stringField(value, "id", { required, maxLength: 64 });
  if (id !== undefined && !PROJECT_ID_PATTERN.test(id)) {
    throw new ApiError(400, "INVALID_FIELD", "'id' must be a lowercase slug containing letters, numbers, or hyphens");
  }
  return id;
}

function parseProjectCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["id", "name", "workspacePath"]));
  const name = stringField(body.name, "name", { required: true, maxLength: 120 });
  const id = validateProjectId(body.id ?? slugify(name));
  if (!id) {
    throw new ApiError(400, "INVALID_FIELD", "Project name must contain at least one letter or number when 'id' is omitted");
  }
  const workspacePath = stringField(body.workspacePath ?? null, "workspacePath", { nullable: true, maxLength: 4096 });
  if (workspacePath === "") {
    throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot be empty");
  }
  if (workspacePath?.includes("\0")) {
    throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
  }
  return { id, name, workspacePath };
}

function parseProjectLabel(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["label"]));
  return stringField(body.label, "label", { required: true, maxLength: 64 });
}

function parseThreadId(value) {
  if (value === undefined) return undefined;
  return stringField(value, "threadId", { required: true, maxLength: 256 });
}

function parseThreadBinding(value) {
  if (value === undefined || value === null) return value;
  assertPlainObject(value);
  assertAllowedKeys(value, new Set([
    "threadId",
    "codexProjectId",
    "codexProjectKind",
    "codexHostId",
    "workspacePath",
  ]));
  const threadId = stringField(value.threadId, "threadBinding.threadId", {
    required: true,
    maxLength: 256,
  });
  const identityFields = [
    value.codexProjectId,
    value.codexProjectKind,
    value.codexHostId,
    value.workspacePath,
  ];
  if (identityFields.every((field) => field === undefined)) return { threadId };
  if (identityFields.some((field) => field === undefined)) {
    throw new ApiError(400, "INVALID_FIELD", "Thread identity must include project, kind, host, and workspace");
  }
  const codexProjectId = stringField(value.codexProjectId, "threadBinding.codexProjectId", {
    required: true,
    maxLength: 256,
  });
  const codexProjectKind = value.codexProjectKind;
  const codexHostId = stringField(value.codexHostId, "threadBinding.codexHostId", {
    required: true,
    maxLength: 256,
  });
  const workspacePath = stringField(value.workspacePath, "threadBinding.workspacePath", {
    required: true,
    maxLength: 4096,
  });
  if (codexProjectKind !== "local" && codexProjectKind !== "remote") {
    throw new ApiError(400, "INVALID_FIELD", "threadBinding.codexProjectKind must be local or remote");
  }
  if (
    (codexProjectKind === "local" && codexHostId !== "local")
    || (codexProjectKind === "remote" && codexHostId === "local")
    || workspacePath.includes("\0")
  ) {
    throw new ApiError(400, "INVALID_FIELD", "Thread project identity is invalid");
  }
  return { threadId, codexProjectId, codexProjectKind, codexHostId, workspacePath };
}

function requestHeader(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function actorFromRequest(request) {
  if (request.headers["x-knotline-client"] === "knotctl") {
    return CODEX_AGENT_ACTOR;
  }

  const rawId = requestHeader(request, "x-knotline-user-id");
  const rawName = requestHeader(request, "x-knotline-user-name");
  const rawAvatarUrl = requestHeader(request, "x-knotline-user-avatar");
  if (rawId === undefined && rawName === undefined && rawAvatarUrl === undefined) {
    return { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
  }
  if (rawId === undefined || rawName === undefined) {
    throw new ApiError(400, "INVALID_ACTOR", "User identity requires both an ID and name");
  }

  const id = stringField(rawId, "X-Knotline-User-Id", { required: true, maxLength: 96 });
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(id)) {
    throw new ApiError(400, "INVALID_ACTOR", "User ID contains unsupported characters");
  }
  let decodedName;
  try {
    decodedName = decodeURIComponent(rawName);
  } catch {
    throw new ApiError(400, "INVALID_ACTOR", "User name is not valid URL-encoded text");
  }
  const name = stringField(decodedName, "X-Knotline-User-Name", { required: true, maxLength: 120 });

  let avatarUrl = null;
  if (rawAvatarUrl !== undefined) {
    const value = stringField(rawAvatarUrl, "X-Knotline-User-Avatar", { required: true, maxLength: 2048 });
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new ApiError(400, "INVALID_ACTOR", "User avatar URL is invalid");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new ApiError(400, "INVALID_ACTOR", "User avatar URL must use HTTP or HTTPS");
    }
    avatarUrl = parsed.toString();
  }
  return { type: "user", id, name, avatarUrl };
}

function parseAssigneeTarget(value) {
  if (value === undefined) return undefined;
  if (value !== "current-user" && value !== "codex-agent") {
    throw new ApiError(400, "INVALID_FIELD", "'assigneeTarget' must be current-user or codex-agent");
  }
  return value;
}

function resolveAssignee(target, actor) {
  if (target === undefined) return actor;
  if (target === "codex-agent") return CODEX_AGENT_ACTOR;
  if (actor.type !== "user") {
    throw new ApiError(400, "INVALID_FIELD", "'current-user' requires a user request identity");
  }
  return actor;
}

function parseWorkflowId(value) {
  const workflowId = stringField(value, "workflowId", { nullable: true, maxLength: 128 });
  if (workflowId === "") {
    throw new ApiError(400, "INVALID_FIELD", "'workflowId' cannot be empty");
  }
  return workflowId;
}

function parseTaskCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "projectId", "title", "description", "status", "priority", "labels", "sortOrder", "threadId", "threadBinding",
    "assigneeTarget", "workflowId", "developmentContext", "startDate", "dueDate", "recurrence",
  ]));
  const projectId = validateProjectId(body.projectId ?? DEFAULT_PROJECT_ID);
  const task = {
    projectId,
    title: stringField(body.title, "title", { required: true, maxLength: 240 }),
    description: stringField(body.description ?? "", "description", { maxLength: 100_000 }),
    status: parseStatus(body.status, "backlog"),
    priority: parsePriority(body.priority, "none"),
    labels: body.labels === undefined ? [] : parseLabels(body.labels),
    sortOrder: body.sortOrder === undefined ? undefined : parseSortOrder(body.sortOrder),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
    assigneeTarget: parseAssigneeTarget(body.assigneeTarget),
    workflowId: parseWorkflowId(body.workflowId ?? null),
    developmentContext: parseDevelopmentContext(body.developmentContext ?? null),
    startDate: parseDueDate(body.startDate ?? null, "startDate"),
    dueDate: parseDueDate(body.dueDate ?? null),
    recurrence: parseRecurrence(body.recurrence ?? null),
  };
  if (task.recurrence && !task.dueDate) {
    throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires 'dueDate'");
  }
  return task;
}

function parseTaskPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "version", "projectId", "title", "description", "status", "priority", "labels", "threadId", "threadBinding",
    "assigneeTarget", "workflowId", "developmentContext", "startDate", "dueDate", "recurrence",
  ]));
  const version = parseVersion(body.version);
  const threadId = parseThreadId(body.threadId);
  const threadBinding = parseThreadBinding(body.threadBinding);
  const assigneeTarget = parseAssigneeTarget(body.assigneeTarget);
  const changes = {};
  if (body.projectId !== undefined) changes.projectId = validateProjectId(body.projectId);
  if (body.title !== undefined) changes.title = stringField(body.title, "title", { required: true, maxLength: 240 });
  if (body.description !== undefined) changes.description = stringField(body.description, "description", { maxLength: 100_000 });
  if (body.status !== undefined) changes.status = parseStatus(body.status);
  if (body.priority !== undefined) changes.priority = parsePriority(body.priority);
  if (body.labels !== undefined) changes.labels = parseLabels(body.labels);
  if (body.workflowId !== undefined) changes.workflowId = parseWorkflowId(body.workflowId);
  if (body.developmentContext !== undefined) changes.developmentContext = parseDevelopmentContext(body.developmentContext);
  if (body.startDate !== undefined) changes.startDate = parseDueDate(body.startDate, "startDate");
  if (body.dueDate !== undefined) changes.dueDate = parseDueDate(body.dueDate);
  if (body.recurrence !== undefined) changes.recurrence = parseRecurrence(body.recurrence);
  if (changes.recurrence && body.dueDate === null) {
    throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires 'dueDate'");
  }
  if (Object.keys(changes).length === 0 && assigneeTarget === undefined) {
    throw new ApiError(400, "INVALID_BODY", "PATCH requires at least one task field");
  }
  return { version, changes, threadId, threadBinding, assigneeTarget };
}

function parseMove(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "status", "sortOrder", "threadId", "threadBinding"]));
  return {
    version: parseVersion(body.version),
    status: parseStatus(body.status),
    sortOrder: body.sortOrder === undefined ? undefined : parseSortOrder(body.sortOrder),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseArchive(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "threadId", "threadBinding"]));
  return {
    version: parseVersion(body.version),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseIssueRelationType(value) {
  if (!["parent", "blocks", "blocked_by", "related"].includes(value)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'relation type' must be parent, blocks, blocked_by, or related",
    );
  }
  return value;
}

function parseCommentCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["body", "threadId", "threadBinding"]));
  return {
    body: stringField(body.body ?? "", "body", { maxLength: 100_000 }),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseCommentPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "body", "threadId", "threadBinding"]));
  if (body.body === undefined) {
    throw new ApiError(400, "INVALID_FIELD", "'body' is required");
  }
  return {
    version: parseVersion(body.version),
    body: stringField(body.body, "body", { maxLength: 100_000 }),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseAttachmentHeaders(request) {
  const encodedFilename = request.headers["x-knotline-filename"];
  if (typeof encodedFilename !== "string") {
    throw new ApiError(400, "INVALID_FILENAME", "X-Knotline-Filename is required");
  }
  let filename;
  try {
    filename = decodeURIComponent(encodedFilename).trim();
  } catch {
    throw new ApiError(400, "INVALID_FILENAME", "Attachment filename contains invalid encoding");
  }
  if (
    filename.length === 0
    || filename.length > 240
    || filename === "."
    || filename === ".."
    || /[\u0000-\u001f\u007f/\\]/.test(filename)
  ) {
    throw new ApiError(400, "INVALID_FILENAME", "Attachment filename is invalid");
  }

  const rawContentType = request.headers["content-type"];
  const contentType = typeof rawContentType === "string"
    ? rawContentType.split(";", 1)[0].trim().toLowerCase()
    : "application/octet-stream";
  if (contentType.length === 0 || contentType.length > 200 || !/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(contentType)) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Attachment Content-Type is invalid");
  }
  return { filename, contentType };
}

async function readBody(request, limit, tooLargeMessage) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new ApiError(413, "BODY_TOO_LARGE", tooLargeMessage);
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) {
      throw new ApiError(413, "BODY_TOO_LARGE", tooLargeMessage);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(
  request,
  limit = JSON_BODY_LIMIT,
  tooLargeMessage = "Request body cannot exceed 1 MiB",
) {
  const contentType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  const body = await readBody(request, limit, tooLargeMessage);
  const length = body.length;
  if (length === 0) {
    throw new ApiError(400, "INVALID_JSON", "Request body cannot be empty");
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must contain valid JSON");
  }
}

async function assertEmptyRequestBody(request, routeLabel) {
  const body = await readBody(request, JSON_BODY_LIMIT, "Request body cannot exceed 1 MiB");
  if (body.length > 0) {
    throw new ApiError(400, "INVALID_BODY", `${routeLabel} does not accept a request body`);
  }
}

function parseTaskFilters(searchParams) {
  const allowed = new Set(["projectId", "status", "archived"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter '${key}'`);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_QUERY_PARAMETER", `Query parameter '${key}' cannot be repeated`);
    }
  }

  const projectIdValue = searchParams.get("projectId");
  const statusValue = searchParams.get("status");
  const archived = searchParams.get("archived") ?? "false";
  if (statusValue !== null && !isTaskStatus(statusValue)) {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", "Invalid task status");
  }
  if (!new Set(["true", "false", "all"]).has(archived)) {
    throw new ApiError(400, "INVALID_QUERY_PARAMETER", "'archived' must be true, false, or all");
  }
  const projectId = projectIdValue === null ? undefined : validateProjectId(projectIdValue);
  return { projectId, status: statusValue ?? undefined, archived };
}

function parseAiSandbox(value) {
  if (value === undefined) return undefined;
  if (!["read-only", "workspace-write", "danger-full-access"].includes(value)) {
    throw new ApiError(
      400,
      "INVALID_SANDBOX",
      "'sandbox' must be read-only, workspace-write, or danger-full-access",
    );
  }
  return value;
}

function parseAiSetting(value, name, maxLength) {
  const setting = stringField(value, name, { maxLength });
  if (setting === "") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  return setting;
}

function parseAiThreadCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "projectId",
    "issueId",
    "title",
    "model",
    "reasoningEffort",
    "sandbox",
  ]));
  return {
    projectId: validateProjectId(body.projectId),
    issueId: parseAiSetting(body.issueId, "issueId", 128),
    title: parseAiSetting(body.title, "title", 160),
    model: parseAiSetting(body.model, "model", 128),
    reasoningEffort: parseAiSetting(body.reasoningEffort, "reasoningEffort", 64),
    sandbox: parseAiSandbox(body.sandbox),
  };
}

function parseAiThreadPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["title", "model", "reasoningEffort", "sandbox"]));
  const input = {};
  if (body.title !== undefined) input.title = parseAiSetting(body.title, "title", 160);
  if (body.model !== undefined) input.model = parseAiSetting(body.model, "model", 128);
  if (body.reasoningEffort !== undefined) {
    input.reasoningEffort = parseAiSetting(body.reasoningEffort, "reasoningEffort", 64);
  }
  if (body.sandbox !== undefined) input.sandbox = parseAiSandbox(body.sandbox);
  if (Object.keys(input).length === 0) {
    throw new ApiError(400, "INVALID_BODY", "PATCH requires at least one thread setting");
  }
  return input;
}

function parseAiSkillIds(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) {
    throw new ApiError(400, "INVALID_FIELD", "'skillIds' must be an array with at most 20 entries");
  }
  const skillIds = value.map((skillId, index) => (
    stringField(skillId, `skillIds[${index}]`, { required: true, maxLength: 256 })
  ));
  return skillIds;
}

function parseAiAttachments(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > AI_CHAT_ATTACHMENT_LIMIT) {
    throw new ApiError(
      400,
      "INVALID_ATTACHMENT",
      `'attachments' must be an array with at most ${AI_CHAT_ATTACHMENT_LIMIT} files`,
    );
  }
  return value.map((attachment, index) => {
    assertPlainObject(attachment);
    assertAllowedKeys(attachment, new Set(["filename", "contentType", "dataBase64"]));
    const filename = stringField(attachment.filename, `attachments[${index}].filename`, {
      required: true,
      maxLength: 240,
    });
    if (/[\u0000-\u001f\u007f/\\]/.test(filename)) {
      throw new ApiError(
        400,
        "INVALID_ATTACHMENT",
        `'attachments[${index}].filename' is invalid`,
      );
    }
    const contentType = stringField(
      attachment.contentType,
      `attachments[${index}].contentType`,
      { required: true, maxLength: 256 },
    ).toLowerCase();
    const dataBase64 = stringField(
      attachment.dataBase64,
      `attachments[${index}].dataBase64`,
      { required: true, maxLength: AI_CHAT_TURN_BODY_LIMIT },
    );
    if (
      dataBase64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)
    ) {
      throw new ApiError(
        400,
        "INVALID_ATTACHMENT",
        `'attachments[${index}].dataBase64' must contain valid base64`,
      );
    }
    const data = Buffer.from(dataBase64, "base64");
    if (data.length === 0 || data.toString("base64") !== dataBase64) {
      throw new ApiError(
        400,
        "INVALID_ATTACHMENT",
        `'attachments[${index}].dataBase64' must contain valid base64`,
      );
    }
    return { filename, contentType, data, size: data.length };
  });
}

function parseAiTurn(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "message",
    "skillIds",
    "dangerFullAccessConfirmed",
    "attachments",
  ]));
  if (
    body.dangerFullAccessConfirmed !== undefined
    && typeof body.dangerFullAccessConfirmed !== "boolean"
  ) {
    throw new ApiError(400, "INVALID_FIELD", "'dangerFullAccessConfirmed' must be a boolean");
  }
  const message = stringField(body.message ?? "", "message", { maxLength: 100_000 });
  const skillIds = parseAiSkillIds(body.skillIds) ?? [];
  if (message.split(AI_CHAT_SKILL_MARKER).length - 1 !== skillIds.length) {
    throw new ApiError(400, "INVALID_FIELD", "'skillIds' must match the Skill markers in 'message'");
  }
  const attachments = parseAiAttachments(body.attachments);
  if (message === "" && attachments.length === 0) {
    throw new ApiError(
      400,
      "INVALID_MESSAGE",
      "A message or at least one attachment is required",
    );
  }
  return {
    message,
    skillIds,
    dangerFullAccessConfirmed: body.dangerFullAccessConfirmed,
    attachments,
  };
}

class EventHub {
  constructor() {
    this.clients = new Set();
    this.keepAlive = setInterval(() => {
      for (const response of this.clients) response.write(": keep-alive\n\n");
    }, 20_000);
    this.keepAlive.unref();
  }

  connect(request, response) {
    response.writeHead(200, {
      connection: "keep-alive",
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    response.write(": connected\n\n");
    this.clients.add(response);
    request.once("close", () => this.clients.delete(response));
  }

  emit(type, value) {
    const event = {
      type,
      projectId: value.projectId ?? value.project?.id ?? value.task?.projectId,
      taskId: value.task?.id ?? value.comment?.taskId ?? value.attachment?.taskId,
      ...value,
      at: new Date().toISOString(),
    };
    const message = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const response of this.clients) response.write(message);
  }

  close() {
    clearInterval(this.keepAlive);
    for (const response of this.clients) response.end();
    this.clients.clear();
  }
}

async function serveStatic(request, response, pathname, staticDirectory) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    throw new ApiError(400, "INVALID_PATH", "URL path contains invalid encoding");
  }
  if (decodedPath.includes("\0")) {
    throw new ApiError(400, "INVALID_PATH", "URL path is invalid");
  }

  const root = path.resolve(staticDirectory);
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  let filename = path.resolve(root, relativePath);
  if (filename !== root && !filename.startsWith(`${root}${path.sep}`)) {
    throw new ApiError(400, "INVALID_PATH", "URL path is outside the static directory");
  }

  let fileStats;
  try {
    fileStats = await stat(filename);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!fileStats?.isFile() && !path.extname(relativePath)) {
    filename = path.join(root, "index.html");
    try {
      fileStats = await stat(filename);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!fileStats?.isFile()) return false;

  const body = await readFile(filename);
  const headers = {
    "cache-control": path.basename(filename) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    "content-length": body.length,
    "content-type": CONTENT_TYPES.get(path.extname(filename).toLowerCase()) ?? "application/octet-stream",
  };
  response.writeHead(200, headers);
  response.end(request.method === "HEAD" ? undefined : body);
  return true;
}

function methodNotAllowed(response, allowed) {
  sendJson(response, 405, {
    error: { code: "METHOD_NOT_ALLOWED", message: `Allowed methods: ${allowed.join(", ")}` },
  }, { allow: allowed.join(", ") });
}

function codexProjectRoot(state, projectId) {
  if (!projectId || !state || typeof state !== "object") return null;
  const project = state["local-projects"]?.[projectId];
  const root = Array.isArray(project?.rootPaths) ? project.rootPaths[0] : null;
  return typeof root === "string" && root.trim() ? root : null;
}

async function readCodexProjectWorkspaces(codexStatePath) {
  try {
    const state = JSON.parse(await readFile(codexStatePath, "utf8"));
    const projects = state["local-projects"];
    if (!projects || typeof projects !== "object" || Array.isArray(projects)) return {};
    return Object.fromEntries(Object.keys(projects).flatMap((projectId) => {
      const root = codexProjectRoot(state, projectId);
      return root ? [[projectId, root]] : [];
    }));
  } catch {
    return {};
  }
}

function latestThreadCwd(value, threadId) {
  const matches = [];
  const stack = [value];
  while (stack.length > 0) {
    const candidate = stack.pop();
    if (!candidate || typeof candidate !== "object") continue;
    if (candidate.conversationId === threadId && typeof candidate.cwd === "string" && candidate.cwd.trim()) {
      matches.push(candidate);
    }
    stack.push(...(Array.isArray(candidate) ? candidate : Object.values(candidate)));
  }
  matches.sort((left, right) => Number(right.updatedAtMs ?? 0) - Number(left.updatedAtMs ?? 0));
  return matches[0]?.cwd ?? null;
}

async function resolveProjectWorkspace(project, codexProjectId, codexThreadId, codexStatePath, codexProcessesPath) {
  try {
    const state = JSON.parse(await readFile(codexStatePath, "utf8"));
    const assignment = state["thread-project-assignments"]?.[codexThreadId];
    const root = codexProjectRoot(state, project.id)
      ?? codexProjectRoot(state, codexProjectId)
      ?? codexProjectRoot(state, assignment?.projectId)
      ?? (typeof assignment?.cwd === "string" ? assignment.cwd : null);
    if (root) return root;
  } catch {}
  if (project.workspacePath) return project.workspacePath;
  if (!codexThreadId) return null;
  try {
    const processes = JSON.parse(await readFile(codexProcessesPath, "utf8"));
    return latestThreadCwd(processes, codexThreadId);
  } catch {
    return null;
  }
}

function parseWorktrees(output) {
  const contexts = [];
  for (const block of output.trim().split(/\n\s*\n/)) {
    if (!block) continue;
    let worktreePath = "";
    let branch = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) worktreePath = line.slice(9);
      if (line.startsWith("branch refs/heads/")) branch = line.slice(18);
    }
    if (worktreePath) contexts.push({ type: "worktree", path: worktreePath, branch });
  }
  return contexts;
}

async function scanDevelopmentContexts(workspacePath, processEnv = process.env) {
  if (!workspacePath) return { workspacePath: null, contexts: [] };
  const environment = withoutKnotlineLauncherEnvironment(processEnv);
  try {
    const rootResult = await execFileAsync("git", ["-C", workspacePath, "rev-parse", "--show-toplevel"], {
      env: environment,
      timeout: 4_000,
      maxBuffer: 1024 * 1024,
    });
    const root = rootResult.stdout.trim();
    const [branchesResult, worktreesResult] = await Promise.all([
      execFileAsync("git", ["-C", root, "for-each-ref", "--format=%(refname:short)", "refs/heads"], {
        env: environment,
        timeout: 4_000,
        maxBuffer: 1024 * 1024,
      }),
      execFileAsync("git", ["-C", root, "worktree", "list", "--porcelain"], {
        env: environment,
        timeout: 4_000,
        maxBuffer: 1024 * 1024,
      }),
    ]);
    const branches = branchesResult.stdout.split("\n").map((branch) => branch.trim()).filter(Boolean);
    return {
      workspacePath: root,
      contexts: [
        ...branches.map((branch) => ({ type: "branch", branch })),
        ...parseWorktrees(worktreesResult.stdout),
      ],
    };
  } catch {
    return { workspacePath, contexts: [] };
  }
}

async function discoverSkills(codexExecutable, workspacePath, processEnv) {
  const entries = await new Promise((resolve, reject) => {
    const command = executableCommand(codexExecutable, ["app-server", "--stdio"]);
    const child = spawn(command.executable, command.args, {
      cwd: workspacePath,
      env: processEnv,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    let buffer = "";
    const timeout = setTimeout(() => {
      finish(new Error("Timed out while reading Codex skills"));
    }, 10_000);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value);
    }

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function handleMessage(message) {
      if (message?.id === 1) {
        if (message.error) {
          finish(new Error("Codex app-server rejected initialization"));
          return;
        }
        send({ method: "initialized" });
        send({
          id: 2,
          method: "skills/list",
          params: { cwds: [workspacePath], forceReload: false },
        });
        return;
      }
      if (message?.id !== 2) return;
      if (message.error) {
        finish(new Error("Codex app-server could not list skills"));
        return;
      }
      finish(null, Array.isArray(message.result?.data) ? message.result.data : []);
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            handleMessage(JSON.parse(line));
          } catch {}
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    child.stdin.on("error", (error) => finish(error));
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) {
        finish(new Error(`Codex app-server exited before listing skills (${signal || code})`));
      }
    });
    child.once("spawn", () => {
      send({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "knotline", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        },
      });
    });
  });

  const unique = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry?.skills)) continue;
    for (const skill of entry.skills) {
      if (
        !skill
        || typeof skill !== "object"
        || skill.enabled === false
        || typeof skill.name !== "string"
        || !skill.name.trim()
      ) {
        continue;
      }
      const id = skill.name.trim();
      if (unique.has(id)) continue;
      const displayName = typeof skill.interface?.displayName === "string"
        ? skill.interface.displayName.trim()
        : "";
      unique.set(id, {
        id,
        label: displayName || id,
        description: typeof skill.description === "string" ? skill.description.trim() : "",
        path: typeof skill.path === "string" ? skill.path.trim() : "",
        scope: ["user", "repo", "system", "admin"].includes(skill.scope)
          ? skill.scope
          : "user",
      });
    }
  }
  return [...unique.values()].sort((left, right) => left.label.localeCompare(right.label));
}

async function discoverMcpServers(codexExecutable, processEnv) {
  const command = executableCommand(codexExecutable, ["mcp", "list", "--json"]);
  const result = await execFileAsync(command.executable, command.args, {
    env: processEnv,
    timeout: 8_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const entries = JSON.parse(result.stdout);
  if (!Array.isArray(entries)) throw new Error("Codex returned an invalid MCP server list");
  return entries
    .filter((entry) => (
      entry
      && typeof entry === "object"
      && typeof entry.name === "string"
      && entry.name.trim()
      && entry.enabled !== false
    ))
    .map((entry) => ({
      id: entry.name.trim(),
      label: entry.name.trim(),
      transport: typeof entry.transport?.type === "string"
        ? entry.transport.type
        : "unknown",
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

async function discoverWorkflowCapabilities(resolved, workspacePath, processEnv) {
  const [skills, mcpServers] = await Promise.all([
    discoverSkills(resolved.codexExecutable, workspacePath, processEnv),
    discoverMcpServers(resolved.codexExecutable, processEnv),
  ]);
  return { skills, mcpServers };
}

export function resolveServerOptions(options = {}) {
  const configuredDataDirectory = options.dataDirectory ?? process.env.KNOTLINE_DATA_DIR;
  const dataDirectory = configuredDataDirectory
    ? path.resolve(configuredDataDirectory)
    : path.join(PROJECT_ROOT, ".data");
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const instanceToken = String(
    options.instanceToken ?? process.env.KNOTLINE_INSTANCE_TOKEN ?? "",
  ).trim();
  if (instanceToken && !/^[a-z0-9-]{16,128}$/i.test(instanceToken)) {
    throw new Error("KNOTLINE_INSTANCE_TOKEN must be an identifier");
  }
  const instanceSecret = String(
    options.instanceSecret ?? process.env.KNOTLINE_INSTANCE_SECRET ?? "",
  ).trim();
  if (instanceToken && !/^[a-f0-9-]{32,128}$/i.test(instanceSecret)) {
    throw new Error("KNOTLINE_INSTANCE_SECRET must be set in launcher mode");
  }
  return {
    dshMode: options.dshMode === true,
    dataDirectory,
    databasePath: options.databasePath ?? path.join(dataDirectory, "knotline.sqlite"),
    attachmentsDirectory: options.attachmentsDirectory ?? path.join(dataDirectory, "attachments"),
    cloudConfigPath: options.cloudConfigPath ?? path.join(dataDirectory, "cloud-companion.json"),
    jiraConfigPath: options.jiraConfigPath ?? path.join(dataDirectory, "jira-connection.json"),
    clientStoragePath: options.clientStoragePath ?? path.join(dataDirectory, "client-storage.json"),
    staticDirectory: options.staticDirectory ?? path.join(PROJECT_ROOT, "dist", "web"),
    skillPath: options.skillPath ?? path.join(PROJECT_ROOT, "skills", "manage-knotline", "SKILL.md"),
    codexExecutable: resolveCodexExecutable({ explicit: options.codexExecutable }),
    codexStatePath: options.codexStatePath
      ?? path.join(codexHome, ".codex-global-state.json"),
    codexProcessesPath: options.codexProcessesPath
      ?? path.join(codexHome, "process_manager", "chat_processes.json"),
    instanceToken,
    instanceSecret,
    version: String(
      options.version ?? process.env.KNOTLINE_VERSION ?? "development",
    ).trim(),
  };
}

export function resolvePort(value = process.env.KNOTLINE_PORT ?? "47823") {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("KNOTLINE_PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function resolveHost(value = process.env.KNOTLINE_HOST ?? "0.0.0.0") {
  const host = String(value).trim();
  if (host !== "127.0.0.1" && host !== "0.0.0.0") {
    throw new Error("KNOTLINE_HOST must be 127.0.0.1 or 0.0.0.0");
  }
  return host;
}

export function createKnotlineServer(options = {}) {
  const resolved = resolveServerOptions(options);
  const codexProcessEnvironment = withoutKnotlineLauncherEnvironment(
    options.processEnv ?? process.env,
  );
  const routePrefix = resolved.instanceToken ? `/${resolved.instanceToken}` : "";
  const database = new KnotlineDatabase(resolved.databasePath);
  const orchestration = createOrchestrationStore(database);
  const knowledge = createKnowledgeService(database, orchestration);
  const governance = createGovernanceService(database);
  const notifications = createNotificationService(database);
  const graph = createGraphService(database, {
    runtimeProvider: options.agentRuntimeProvider,
    governance,
    orchestration,
    knowledge,
    messageAgent: options.agentOrchestrator?.messageAgent,
  });
  const events = new EventHub();
  let clientStorageWrite = Promise.resolve();
  let scheduledTriggerDispatching = false;

  async function dispatchScheduledTriggers() {
    if (scheduledTriggerDispatching || !options.agentOrchestrator?.startNodeRun) return;
    scheduledTriggerDispatching = true;
    try {
      for (const trigger of database.listDueScheduledTriggers()) {
        const targets = database.listGraphEdges(trigger.projectId)
          .filter((edge) => (
            edge.sourceNodeId === `scheduled_trigger:${trigger.id}`
            && edge.relationType === "scheduled_for"
            && edge.state === "active"
            && edge.targetNodeId.startsWith("agent_profile:")
          ))
          .map((edge) => edge.targetNodeId.slice("agent_profile:".length));
        if (targets.length === 0) continue;
        const fired = database.recordScheduledTriggerFired(trigger.id);
        for (const agentProfileId of targets) {
          const title = `Scheduled: ${trigger.prompt.split(/\r?\n/, 1)[0].slice(0, 220)}`;
          const instruction = `${trigger.prompt}\nScheduled trigger fired at: ${fired.lastTriggeredAt}`;
          const run = orchestration.createStandaloneRun(agentProfileId, title, instruction);
          events.emit("task.created", { projectId: trigger.projectId, task: run.task });
          events.emit("node_run.queued", { projectId: trigger.projectId, nodeRun: run.nodeRun });
          await options.agentOrchestrator.startNodeRun(run.nodeRun.id);
        }
        events.emit("graph.node.updated", {
          projectId: trigger.projectId,
          entityType: "scheduled_trigger",
          entityId: fired.id,
        });
      }
    } catch (error) {
      console.error(error);
    } finally {
      scheduledTriggerDispatching = false;
    }
  }

  const scheduledTriggerTimer = setInterval(() => void dispatchScheduledTriggers(), 1_000);
  scheduledTriggerTimer.unref?.();

  function emitNotification(notification) {
    events.emit("notification.created", { projectId: notification.projectId, notification });
    return notification;
  }

  function emitContextAttached(projectId, result) {
    if (result.demand) {
      events.emit("graph.node.updated", { projectId, entityType: "demand", entityId: result.demand.id });
    }
    events.emit("graph.node.updated", { projectId, entityType: "knowledge_asset", entityId: result.asset.id });
    events.emit("graph.node.updated", { projectId, entityType: "agent_profile", entityId: result.agent.id });
    events.emit("knowledge.updated", {
      projectId,
      asset: result.asset,
      knowledgeVersion: result.knowledgeVersion,
      knowledgeBinding: result.knowledgeBinding,
    });
    if (result.directEdge) events.emit("graph.edge.updated", { projectId, edge: result.directEdge });
    if (result.contextEdge) events.emit("graph.edge.updated", { projectId, edge: result.contextEdge });
    if (!result.runtimeProduced) {
      void options.agentOrchestrator?.rememberContext?.(
        result.agent.id,
        result.asset.title,
        result.knowledgeVersion.content,
      )?.catch((error) => {
        console.warn("Knotline could not append Context Document to the Agent conversation", error);
      });
    }
  }

  function publishTaskStatusNotification(task, previousStatus, actor) {
    if (task.status === previousStatus) return null;
    const reviewers = database.listAgentProfiles(task.projectId).filter((agent) => agent.role === "reviewer");
    const assignedReviewer = task.assignee.type === "agent"
      ? reviewers.find((reviewer) => reviewer.id === task.assignee.id)
      : null;
    if (task.status === "in_review") {
      return emitNotification(notifications.publish("review.requested", {
        projectId: task.projectId,
        entityType: "task",
        entityId: task.id,
        graphNodeId: `task:${task.id}`,
        actor,
        reviewerAgentId: assignedReviewer?.id ?? reviewers[0]?.id ?? null,
        title: `${task.identifier} is ready for review`,
        body: task.title,
        reason: "This Task entered in_review and requires an independent decision.",
        dueAt: task.dueDate,
        impact: "Delivery waits until the review is approved or changes are requested.",
        context: {
          taskNodeId: `task:${task.id}`,
          reviewerOptions: reviewers.map((reviewer) => ({ id: reviewer.id, name: reviewer.name })),
        },
        dedupeKey: `task-review:${task.id}:${task.version}`,
      }));
    }
    if (task.status === "done") {
      return emitNotification(notifications.publish("task.completed", {
        projectId: task.projectId,
        entityType: "task",
        entityId: task.id,
        graphNodeId: `task:${task.id}`,
        actor,
        title: `${task.identifier} completed`,
        body: task.title,
        reason: "This Task reached done.",
        dueAt: task.dueDate,
        impact: "The Task is now reflected as complete across Map, Board, List, Gantt, and Dashboard.",
        context: { taskNodeId: `task:${task.id}` },
        dedupeKey: `task-completed:${task.id}:${task.version}`,
      }));
    }
    return null;
  }

  function requireNodeRun(id) {
    const nodeRun = orchestration.getNodeRun(id);
    if (!nodeRun) throw new ApiError(404, "NODE_RUN_NOT_FOUND", `Node Run '${id}' does not exist`);
    return nodeRun;
  }

  function updateExecutionProgress(nodeRunId, input, actor) {
    const current = requireNodeRun(nodeRunId);
    const nodeRunStatus = input.status === "running" ? "running" : "waiting_input";
    const nodeRun = orchestration.updateNodeRun(nodeRunId, {
      status: nodeRunStatus,
      error: input.status === "blocked" ? input.comment || "Blocked" : null,
    });
    const task = database.getTask(current.taskId);
    const taskStatus = input.status === "blocked" ? "blocked" : "in_progress";
    const updatedTask = task.status === taskStatus
      ? task
      : database.moveTask(task.id, task.version, taskStatus, undefined, undefined, undefined, actor);
    if (input.comment) database.createComment(task.id, { body: input.comment, actor });
    const binding = orchestration.updateBinding(current.agentProfileId, {
      currentNodeRunId: current.id,
      status: input.status === "running" ? "working" : input.status,
      lastError: input.status === "blocked" ? input.comment || "Blocked" : null,
    });
    const workstream = input.status === "running"
      ? database.setWorkstreamStatus(current.workstreamId, "executing")
      : database.getWorkstream(current.workstreamId);
    return { nodeRun, task: updatedTask, binding, workstream };
  }

  function submitExecutionForReview(nodeRunId, delivery, actor) {
    const current = requireNodeRun(nodeRunId);
    if (!current.workstreamId) {
      const approvalMatch = current.instruction.match(
        /<knotline_approval_execution artifact_id="([^"]+)" pool_id="([^"]+)">/,
      );
      const completed = knowledge.completeContextualization(nodeRunId, delivery, actor)
        ?? knowledge.completeKnowledgeSync(nodeRunId, delivery)
        ?? knowledge.completeStandaloneNodeRun(nodeRunId, delivery);
      return {
        ...completed,
        approvalExecution: approvalMatch ? {
          artifact: database.getRequestArtifact(approvalMatch[1]),
          approvalPool: database.getApprovalPool(approvalMatch[2]),
        } : null,
        nextAssignment: graph.scheduleAgentWork(current.projectId, current.agentProfileId, actor),
      };
    }
    const nodeRun = orchestration.updateNodeRun(nodeRunId, { status: "waiting_review", result: delivery, error: null });
    const requestArtifacts = database.completeRequestArtifacts(nodeRunId, delivery);
    const task = database.getTask(current.taskId);
    const updatedTask = task.status === "in_review"
      ? task
      : database.moveTask(task.id, task.version, "in_review", undefined, undefined, undefined, actor);
    const workstream = database.setWorkstreamStatus(current.workstreamId, "acceptance");
    const binding = orchestration.updateBinding(current.agentProfileId, {
      currentNodeRunId: current.id,
      status: "waiting",
      lastError: null,
    });
    const review = knowledge.requestExecutionReview(nodeRunId);
    const approvalDeposit = graph.storeApprovalArtifacts(
      current.projectId,
      current.agentProfileId,
      requestArtifacts,
      actor,
    );
    const nextAssignment = graph.scheduleAgentWork(current.projectId, current.agentProfileId, actor);
    const reviewerOptions = governance.projectState(current.projectId).agents
      .filter((agent) => agent.id !== current.agentProfileId)
      .map((agent) => ({ id: agent.id, name: agent.name }));
    emitNotification(notifications.publish("review.requested", {
      projectId: current.projectId,
      entityType: "review_gate",
      entityId: review.reviewGate.id,
      graphNodeId: `review_gate:${review.reviewGate.id}`,
      actor,
      reviewerAgentId: review.reviewGate.reviewerAgentId,
      title: `${workstream.title} delivery requires independent review`,
      body: delivery.summary,
      reason: "The assigned execution Agent submitted delivery evidence and cannot self-approve.",
      impact: "Approval creates a Delivery; rejection creates a Rework Node Run.",
      actions: review.reviewGate.reviewerAgentId
        ? ["open", "approve", "reject", "ask", "reassign", "postpone"]
        : ["open", "reassign"],
      context: {
        executionReview: true,
        reviewGateNodeId: `review_gate:${review.reviewGate.id}`,
        workstreamNodeId: `workstream:${workstream.id}`,
        nodeRunNodeId: `node_run:${nodeRun.id}`,
        taskNodeId: `task:${updatedTask.id}`,
        reviewerOptions,
      },
      dedupeKey: `execution-review:${review.reviewGate.id}:${review.reviewGate.version}`,
    }));
    return {
      nodeRun,
      task: updatedTask,
      binding,
      workstream,
      reviewGate: review.reviewGate,
      requestArtifacts,
      approvalDeposit,
      nextAssignment,
    };
  }

  function publishKnowledgeProposalNotification(proposal, asset, actor) {
    return emitNotification(notifications.publish("decision.required", {
      projectId: proposal.projectId,
      entityType: "knowledge_proposal",
      entityId: proposal.id,
      graphNodeId: `knowledge_proposal:${proposal.id}`,
      actor,
      title: proposal.title,
      body: proposal.content,
      reason: "A Delivery or Agent proposed a new Project Knowledge version.",
      impact: "Approval publishes a new version and marks older Agent bindings stale.",
      context: {
        knowledgeProposalNodeId: `knowledge_proposal:${proposal.id}`,
        knowledgeNodeId: `knowledge_asset:${asset.id}`,
        deliveryNodeId: proposal.deliveryId ? `delivery:${proposal.deliveryId}` : null,
      },
      dedupeKey: `knowledge-proposal:${proposal.id}:${proposal.version}`,
    }));
  }

  async function projectContextForNodeRun(nodeRunId) {
    const nodeRun = requireNodeRun(nodeRunId);
    const project = database.getProject(nodeRun.projectId);
    const workspacePath = project?.workspacePath ? path.resolve(project.workspacePath) : null;
    const files = [];
    if (workspacePath) {
      const rootEntries = await readdir(workspacePath, { withFileTypes: true });
      let docEntries = [];
      try {
        docEntries = await readdir(path.join(workspacePath, "docs"), { withFileTypes: true });
      } catch {
        // Documentation directory is optional.
      }
      const candidates = [
        ...rootEntries
          .filter((entry) => entry.isFile() && /^(AGENTS\.md|README[^/]*\.md|package\.json)$/i.test(entry.name))
          .map((entry) => entry.name),
        ...docEntries
          .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
          .map((entry) => `docs/${entry.name}`),
        "server/app.mjs",
        "server/database.mjs",
        "server/graph-service.mjs",
        "server/governance-service.mjs",
        "server/knowledge-service.mjs",
        "server/orchestration-store.mjs",
        "src/host/index.ts",
        "web/src/App.tsx",
      ]
        .filter((entry, index, entries) => entries.indexOf(entry) === index)
        .sort((left, right) => left.localeCompare(right))
        .slice(0, 18);
      for (const relativePath of candidates) {
        const absolutePath = path.resolve(workspacePath, relativePath);
        if (absolutePath !== workspacePath && !absolutePath.startsWith(`${workspacePath}${path.sep}`)) continue;
        try {
          const info = await stat(absolutePath);
          if (!info.isFile()) continue;
          const content = await readFile(absolutePath, "utf8");
          files.push({ path: relativePath, content: content.slice(0, 12_000) });
        } catch {
          // The project may change while the snapshot is assembled.
        }
      }
    }
    const runtimeSessions = await (options.agentRuntimeProvider?.() ?? []);
    const normalizedWorkspace = workspacePath?.replaceAll("\\", "/").toLowerCase();
    const sessions = runtimeSessions.filter((session) => (
      normalizedWorkspace
      && session.cwd?.replaceAll("\\", "/").toLowerCase() === normalizedWorkspace
    )).slice(0, 50);
    const snapshot = {
      project,
      tasks: database.listTasks({ projectId: nodeRun.projectId, archived: "false" }).map((task) => ({
        id: task.id,
        identifier: task.identifier,
        title: task.title,
        status: task.status,
        priority: task.priority,
      })),
      governance: governance.projectState(nodeRun.projectId),
      knowledge: knowledge.projectState(nodeRun.projectId),
      sessions,
      files,
    };
    return [
      "Grounded Knotline Project Context",
      "Use only these observed facts. Identify gaps explicitly.",
      JSON.stringify(snapshot, null, 2),
    ].join("\n\n");
  }

  function emitGraphCommandEvents(projectId, command, actor) {
    const result = command.result;
    if (result?.kind === "graph_edge") {
      events.emit("graph.edge.updated", { projectId, edge: result.edge });
    }
    if (result?.kind === "task_relation") {
      events.emit("task.relation.updated", {
        projectId,
        task: result.task,
        relatedTask: result.relatedTask,
      });
    }
    if (result?.kind === "workstream_intake") {
      events.emit("workstream.updated", { projectId, workstream: result.workstream });
      events.emit("review.requested", { projectId, reviewGate: result.reviewGate });
    }
    if (result?.kind === "agent_team_created") {
      events.emit("graph.node.updated", { projectId, entityType: "agent_profile", entityId: result.team.id });
      events.emit("graph.node.updated", { projectId, entityType: result.plan.kind, entityId: result.plan.id });
      events.emit("graph.node.updated", { projectId, entityType: result.protocol.kind, entityId: result.protocol.id });
    }
    if (result?.kind === "skill_binding") {
      events.emit("graph.node.updated", { projectId, entityType: "agent_profile", entityId: result.agent.id });
    }
    if (result?.kind === "scheduled_trigger_connected") {
      events.emit("graph.edge.updated", { projectId, edge: result.edge });
      events.emit("graph.node.updated", { projectId, entityType: "scheduled_trigger", entityId: result.trigger.id });
    }
    if (result?.kind === "review_assigned") {
      events.emit("review.requested", { projectId, reviewGate: result.reviewGate });
      emitNotification(notifications.publish("review.requested", {
        projectId,
        entityType: "review_gate",
        entityId: result.reviewGate.id,
        graphNodeId: `review_gate:${result.reviewGate.id}`,
        actor,
        reviewerAgentId: result.reviewGate.reviewerAgentId,
        title: `${result.workstream.title} requires review`,
        body: "Review the Workstream scope, risks, acceptance criteria, deliverables, and evidence.",
        reason: "You are the assigned independent Reviewer.",
        impact: "Formal execution cannot start before approval.",
        context: {
          reviewGateNodeId: `review_gate:${result.reviewGate.id}`,
          workstreamNodeId: `workstream:${result.workstream.id}`,
          reviewerOptions: governance.projectState(projectId).agents
            .filter((agent) => agent.role === "reviewer")
            .map((agent) => ({ id: agent.id, name: agent.name })),
        },
        dedupeKey: `review-requested:${result.reviewGate.id}:${result.reviewGate.version}`,
      }));
    }
    if (result?.kind === "review_decision") {
      events.emit("review.completed", { projectId, reviewGate: result.reviewGate, workstream: result.workstream });
      events.emit("workstream.updated", { projectId, workstream: result.workstream });
      const eventType = result.reviewGate.status === "approved" ? "review.approved" : "review.rejected";
      emitNotification(notifications.publish(eventType, {
        projectId,
        entityType: "review_gate",
        entityId: result.reviewGate.id,
        graphNodeId: `review_gate:${result.reviewGate.id}`,
        actor,
        title: `${result.workstream.title} review ${result.reviewGate.status}`,
        body: result.decision.comment || "Review decision recorded.",
        reason: "The assigned Reviewer completed the governance decision.",
        impact: result.reviewGate.status === "approved"
          ? "The Workstream can now be staffed."
          : "The Workstream returned to draft.",
        context: {
          reviewGateNodeId: `review_gate:${result.reviewGate.id}`,
          workstreamNodeId: `workstream:${result.workstream.id}`,
        },
        dedupeKey: `review-completed:${result.reviewGate.id}:${result.reviewGate.version}`,
      }));
    }
    if (result?.kind === "change_request") {
      events.emit("workstream.scope_changed", { projectId, changeRequest: result.changeRequest });
      emitNotification(notifications.publish("workstream.scope_changed", {
        projectId,
        entityType: "change_request",
        entityId: result.changeRequest.id,
        graphNodeId: `change_request:${result.changeRequest.id}`,
        actor,
        title: result.changeRequest.title,
        body: result.changeRequest.description,
        reason: "A new Demand targeted an already-approved Workstream.",
        impact: "Approved scope remains unchanged until this Change Request is reviewed.",
        context: { workstreamNodeId: `workstream:${result.workstream.id}` },
        dedupeKey: `change-request:${result.changeRequest.id}`,
      }));
    }
    if (["agent_assignment", "demand_assignment", "context_assignment", "artifact_review_assignment"].includes(result?.kind)) {
      events.emit("task.created", { projectId, task: result.task });
      events.emit("node_run.queued", { projectId, nodeRun: result.nodeRun });
      if (result.workstream) events.emit("workstream.updated", { projectId, workstream: result.workstream });
      events.emit("agent.runtime.updated", { projectId, binding: result.binding });
      if (["demand_assignment", "context_assignment"].includes(result.kind)) {
        events.emit("graph.node.updated", { projectId, entityType: "demand", entityId: result.demand.id });
        for (const artifact of result.artifacts ?? []) {
          events.emit("graph.node.updated", { projectId, entityType: "request_artifact", entityId: artifact.id });
        }
        if (result.delegationEdge) events.emit("graph.edge.updated", { projectId, edge: result.delegationEdge });
        if (result.directEdge) events.emit("graph.edge.updated", { projectId, edge: result.directEdge });
        if (result.queueEdge) events.emit("graph.edge.updated", { projectId, edge: result.queueEdge });
        if (result.workerEdge) events.emit("graph.edge.updated", { projectId, edge: result.workerEdge });
        for (const cached of result.cachedEdges ?? []) {
          if (cached.directEdge) events.emit("graph.edge.updated", { projectId, edge: cached.directEdge });
          if (cached.queueEdge) events.emit("graph.edge.updated", { projectId, edge: cached.queueEdge });
        }
      }
      if (result.kind === "artifact_review_assignment") {
        events.emit("review.requested", { projectId, reviewGate: result.reviewGate });
        emitNotification(notifications.publish("review.requested", {
          projectId,
          entityType: "review_gate",
          entityId: result.reviewGate.id,
          graphNodeId: `review_gate:${result.reviewGate.id}`,
          actor,
          reviewerAgentId: result.reviewGate.reviewerAgentId,
          title: `${result.workstream.title} delivery is ready for independent review`,
          body: result.nodeRun.instruction,
          reason: "You are the assigned independent Reviewer for this delivery.",
          impact: "Approval creates a Delivery; rejection creates a Rework Node Run.",
          context: {
            executionReview: true,
            reviewGateNodeId: `review_gate:${result.reviewGate.id}`,
            workstreamNodeId: `workstream:${result.workstream.id}`,
            nodeRunNodeId: `node_run:${result.nodeRun.id}`,
            taskNodeId: `task:${result.task.id}`,
            reviewerOptions: governance.projectState(projectId).agents
              .filter((agent) => agent.id !== requireNodeRun(result.reviewGate.nodeRunId).agentProfileId)
              .map((agent) => ({ id: agent.id, name: agent.name })),
          },
          dedupeKey: `execution-review-assigned:${result.reviewGate.id}:${result.reviewGate.version}`,
        }));
      }
    }
    if (["backlog_demand_queued", "backlog_agent_joined", "direct_demand_queued", "direct_demand_cached"].includes(result?.kind)) {
      events.emit("graph.edge.updated", { projectId, edge: result.edge });
      for (const cached of result.cachedEdges ?? []) {
        if (cached.directEdge) events.emit("graph.edge.updated", { projectId, edge: cached.directEdge });
        if (cached.queueEdge) events.emit("graph.edge.updated", { projectId, edge: cached.queueEdge });
      }
    }
    if (result?.kind === "approval_assignment") {
      events.emit("task.created", { projectId, task: result.task });
      events.emit("node_run.queued", { projectId, nodeRun: result.nodeRun });
      events.emit("agent.runtime.updated", { projectId, binding: result.binding });
      events.emit("graph.node.updated", { projectId, entityType: "request_artifact", entityId: result.approvalArtifact.id });
      events.emit("graph.node.updated", { projectId, entityType: "approval_pool", entityId: result.approvalPool.id });
      events.emit("graph.edge.updated", { projectId, edge: result.approvalEdge });
    }
    if (result?.kind === "approval_pool_agent_joined") {
      events.emit("graph.edge.updated", { projectId, edge: result.edge });
    }
    if (result?.approvalWorkerEdge) {
      events.emit("graph.edge.updated", { projectId, edge: result.approvalWorkerEdge });
    }
    if (result?.kind === "knowledge_binding") {
      events.emit("knowledge.updated", {
        projectId,
        asset: result.asset,
        knowledgeBinding: result.knowledgeBinding,
      });
      events.emit("task.created", { projectId, task: result.task });
      events.emit("node_run.queued", { projectId, nodeRun: result.nodeRun });
    }
    if (result?.kind === "context_attached") {
      emitContextAttached(projectId, result);
    }
    if (result?.kind === "agent_message") {
      events.emit("graph.node.updated", {
        projectId,
        entityType: result.mapItem.kind,
        entityId: result.mapItem.id,
      });
      if (result.nodeRun) events.emit("node_run.queued", { projectId, nodeRun: result.nodeRun });
    }
    if (result?.kind === "knowledge_proposal") {
      events.emit("knowledge.updated", { projectId, proposal: result.proposal, asset: result.asset });
      publishKnowledgeProposalNotification(result.proposal, result.asset, actor);
    }
    if (result?.kind === "execution_review_approved") {
      events.emit("review.completed", { projectId, reviewGate: result.reviewGate, nodeRun: result.nodeRun });
      events.emit("delivery.created", { projectId, delivery: result.delivery });
      events.emit("workstream.updated", { projectId, workstream: result.workstream });
      emitNotification(notifications.publish("delivery.created", {
        projectId,
        entityType: "delivery",
        entityId: result.delivery.id,
        graphNodeId: `delivery:${result.delivery.id}`,
        actor,
        title: `${result.workstream.title} delivered`,
        body: result.delivery.summary,
        reason: "The independent execution Reviewer approved the submitted evidence.",
        impact: result.knowledgeProposal
          ? "A Knowledge Update Proposal now requires a decision."
          : "The Workstream is delivered.",
        context: { deliveryNodeId: `delivery:${result.delivery.id}` },
        dedupeKey: `delivery-created:${result.delivery.id}`,
      }));
      if (result.knowledgeProposal && result.knowledgeAsset) {
        publishKnowledgeProposalNotification(result.knowledgeProposal, result.knowledgeAsset, actor);
      }
    }
    if (result?.kind === "execution_review_rejected") {
      events.emit("review.completed", { projectId, reviewGate: result.reviewGate, nodeRun: result.nodeRun });
      events.emit("node_run.queued", { projectId, nodeRun: result.reworkRun });
      events.emit("workstream.updated", { projectId, workstream: result.workstream });
      emitNotification(notifications.publish("review.rejected", {
        projectId,
        entityType: "node_run",
        entityId: result.reworkRun.id,
        graphNodeId: `node_run:${result.reworkRun.id}`,
        actor,
        title: `${result.workstream.title} requires rework`,
        body: result.nodeRun.error || "Address the independent review feedback.",
        reason: "The independent execution Reviewer rejected the Delivery.",
        impact: "A Rework Node Run has been queued for the execution Agent.",
        context: { nodeRunNodeId: `node_run:${result.reworkRun.id}` },
        dedupeKey: `execution-rework:${result.reworkRun.id}`,
      }));
    }
    if (result?.kind === "knowledge_decision") {
      events.emit("knowledge.updated", {
        projectId,
        asset: result.asset,
        proposal: result.proposal,
        knowledgeVersion: result.knowledgeVersion,
      });
      if (result.knowledgeVersion) {
        emitNotification(notifications.publish("knowledge.updated", {
          projectId,
          entityType: "knowledge_asset",
          entityId: result.asset.id,
          graphNodeId: `knowledge_asset:${result.asset.id}`,
          actor,
          title: `${result.asset.title} v${result.asset.currentVersion} published`,
          body: result.knowledgeVersion.content,
          reason: "The Knowledge Update Proposal was approved.",
          impact: "Agent bindings on older versions are now stale and can be synchronized incrementally.",
          context: { knowledgeNodeId: `knowledge_asset:${result.asset.id}` },
          dedupeKey: `knowledge-version:${result.asset.id}:${result.asset.currentVersion}`,
        }));
      }
    }
    if (result?.kind === "task_review_decision") {
      events.emit("task.moved", { projectId, task: result.task });
      publishTaskStatusNotification(result.task, "in_review", actor);
    }
    if (result?.kind === "task_comment") {
      events.emit("comment.created", { projectId, comment: result.comment, task: database.getTask(result.comment.taskId) });
    }
    if (result?.kind === "task_updated") {
      events.emit("task.updated", { projectId, task: result.task });
    }
    events.emit("graph.command.completed", { projectId, command });
  }

  async function readClientStorage() {
    try {
      const value = JSON.parse(await readFile(resolved.clientStoragePath, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  async function updateClientStorage(body) {
    assertPlainObject(body);
    assertAllowedKeys(body, new Set(["key", "value"]));
    const key = stringField(body.key, "key", { required: true, maxLength: 512 });
    const value = stringField(body.value, "value", { nullable: true, maxLength: 100_000 });
    clientStorageWrite = clientStorageWrite.catch(() => {}).then(async () => {
      const entries = await readClientStorage();
      if (value === null) delete entries[key];
      else entries[key] = value;
      await mkdir(path.dirname(resolved.clientStoragePath), { recursive: true });
      const temporaryPath = `${resolved.clientStoragePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(entries)}\n`, { mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, resolved.clientStoragePath);
      await chmod(resolved.clientStoragePath, 0o600);
    });
    await clientStorageWrite;
  }
  const cloudConfig = options.cloudConfigStore ?? createCloudConfigStore({
    configPath: resolved.cloudConfigPath,
  });
  const jiraConfig = options.jiraConfigStore ?? createJiraConfigStore({
    configPath: resolved.jiraConfigPath,
  });
  const jira = createJiraIntegration({
    configStore: jiraConfig,
    database,
    fetch: options.jiraFetch ?? globalThis.fetch,
  });
  let hostRuntime = null;
  function currentHostThreadBinding(threadId) {
    if (
      !hostRuntime
      || hostRuntime.threadId !== threadId
      || !hostRuntime.codexProjectId
      || !hostRuntime.codexProjectKind
      || !hostRuntime.codexHostId
      || !hostRuntime.workspacePath
    ) return undefined;
    return {
      threadId,
      codexProjectId: hostRuntime.codexProjectId,
      codexProjectKind: hostRuntime.codexProjectKind,
      codexHostId: hostRuntime.codexHostId,
      workspacePath: hostRuntime.workspacePath,
    };
  }
  function resolveInputThreadBinding(input) {
    if (input.threadBinding !== undefined) return input;
    const threadBinding = currentHostThreadBinding(input.threadId);
    return threadBinding ? { ...input, threadBinding } : input;
  }
  const cloudProxy = createCloudProxy({
    configStore: cloudConfig,
    fetch: options.remoteFetch ?? globalThis.fetch,
    resolveThreadBinding: currentHostThreadBinding,
    resolveDevelopmentContext: async (projectId, context) => {
      if (!context.branch) return null;
      const config = await cloudConfig.read();
      const workspacePath = config.projectMappings[projectId];
      if (!workspacePath) return null;
      const result = await scanDevelopmentContexts(workspacePath, codexProcessEnvironment);
      return result.contexts.find((candidate) => (
        candidate.type === "worktree" && candidate.branch === context.branch
      )) ?? null;
    },
    assertTaskProjectMoveAllowed: (taskId, targetProjectId) => {
      if (!database.hasAiChatThreadProjectConflict(taskId, targetProjectId)) return;
      throw new CloudProxyError(
        409,
        "AI_CHAT_PROJECT_MOVE_BLOCKED",
        "Delete issue-linked AI conversations before moving the issue to another project",
      );
    },
  });
  async function readCloudJson(pathname) {
    const upstream = await cloudProxy.forward(new Request(`http://127.0.0.1${pathname}`, {
      headers: { accept: "application/json" },
    }));
    let payload;
    try {
      payload = await upstream.json();
    } catch {
      throw new ApiError(
        upstream.ok ? 502 : upstream.status,
        "INVALID_CLOUD_RESPONSE",
        "Cloud knotline returned an invalid JSON response",
      );
    }
    if (!upstream.ok) {
      throw new ApiError(
        upstream.status,
        payload?.error?.code ?? "CLOUD_REQUEST_FAILED",
        payload?.error?.message ?? "Cloud knotline request failed",
        payload?.error?.details,
      );
    }
    return payload;
  }

  async function resolveAiChatContext(projectId, issueId) {
    const config = await cloudConfig.read();
    if (!config.remoteUrl) {
      let resolvedWorkspace;
      try {
        resolvedWorkspace = await resolveAiWorkspace(
          projectId,
          resolved.codexStatePath,
          database,
        );
      } catch (error) {
        if (
          !(error instanceof ApiError)
          || error.code !== "PROJECT_WORKSPACE_UNAVAILABLE"
          || projectId !== DEFAULT_PROJECT_ID
        ) {
          throw error;
        }
        resolvedWorkspace = {
          workspacePath: PROJECT_ROOT,
          addDirectories: [],
          project: database.getProject(projectId),
        };
      }
      let issue;
      if (issueId !== undefined) {
        issue = database.getTask(issueId);
        if (!issue || issue.projectId !== projectId || issue.archivedAt != null) {
          throw new ApiError(
            404,
            "AI_CHAT_ISSUE_NOT_FOUND",
            `Task '${issueId}' is not an active task in project '${projectId}'`,
          );
        }
      }
      return { ...resolvedWorkspace, issue };
    }

    const projectPayload = await readCloudJson("/api/projects");
    const project = Array.isArray(projectPayload.projects)
      ? projectPayload.projects.find((candidate) => candidate?.id === projectId)
      : null;
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }

    let issue;
    if (issueId !== undefined) {
      const issuePayload = await readCloudJson(`/api/tasks/${encodeURIComponent(issueId)}`);
      issue = issuePayload.task;
      if (!issue || issue.projectId !== projectId || issue.archivedAt != null) {
        throw new ApiError(
          404,
          "AI_CHAT_ISSUE_NOT_FOUND",
          `Task '${issueId}' is not an active task in project '${projectId}'`,
        );
      }
    }

    const resolvedWorkspace = await resolveMappedAiWorkspace(
      projectId,
      project,
      config.projectMappings,
    );
    return { ...resolvedWorkspace, issue };
  }

  const aiChat = new AiChatService({
    database,
    codexExecutable: resolved.codexExecutable,
    codexStatePath: resolved.codexStatePath,
    manageKnotlineSkillPath: resolved.skillPath,
    processEnv: codexProcessEnvironment,
    resolveContext: resolveAiChatContext,
  });
  const projectSummary = new ProjectSummaryService({
    database,
    codexExecutable: resolved.codexExecutable,
    processEnv: codexProcessEnvironment,
    workspacePath: PROJECT_ROOT,
    disabled: resolved.dshMode,
  });
  const aiEventResponses = new Set();
  const codexSessionSearches = new Map();
  const codexSessionStateCache = new Map();
  const codexSessionsDirectory = path.join(path.dirname(resolved.codexStatePath), "sessions");

  async function findCodexSession(threadId) {
    const cached = codexSessionSearches.get(threadId);
    if (cached && (cached.path || Date.now() - cached.checkedAt < 5_000)) return cached.path;

    const suffix = `-${threadId}.jsonl`;
    const directories = [codexSessionsDirectory];
    while (directories.length > 0) {
      const directory = directories.pop();
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          directories.push(entryPath);
        } else if (entry.isFile() && entry.name.endsWith(suffix)) {
          codexSessionSearches.set(threadId, { path: entryPath, checkedAt: Date.now() });
          return entryPath;
        }
      }
    }

    codexSessionSearches.set(threadId, { path: null, checkedAt: Date.now() });
    return null;
  }

  async function readCodexSessionState(threadId) {
    const sessionPath = await findCodexSession(threadId);
    if (!sessionPath) return null;

    const sessionStat = await stat(sessionPath);
    const cached = codexSessionStateCache.get(sessionPath);
    if (cached?.size === sessionStat.size && cached.mtimeMs === sessionStat.mtimeMs) {
      return cached.state;
    }

    const length = Math.min(sessionStat.size, CODEX_PLAN_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const handle = await open(sessionPath, "r");
    try {
      await handle.read(buffer, 0, length, sessionStat.size - length);
    } finally {
      await handle.close();
    }

    const lines = buffer.toString("utf8").split("\n");
    if (length < sessionStat.size) lines.shift();
    const records = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {}
    }

    let runningTurnId = null;
    for (const record of records) {
      const payload = record?.payload;
      if (record?.type !== "event_msg" || typeof payload?.turn_id !== "string") continue;
      if (payload.type === "task_started") runningTurnId = payload.turn_id;
      if (
        (payload.type === "task_complete" || payload.type === "turn_aborted")
        && payload.turn_id === runningTurnId
      ) {
        runningTurnId = null;
      }
    }

    let progress = null;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      const payload = record?.payload;
      if (payload?.type !== "custom_tool_call" || typeof payload.input !== "string") continue;

      let statuses = [];
      if (payload.name === "update_plan") {
        try {
          const input = JSON.parse(payload.input);
          statuses = Array.isArray(input.plan)
            ? input.plan.map((item) => item?.status).filter(Boolean)
            : [];
        } catch {}
      } else if (payload.name === "exec") {
        const callIndex = payload.input.lastIndexOf("tools.update_plan(");
        if (callIndex < 0) continue;
        statuses = [...payload.input.slice(callIndex).matchAll(
          /["']?status["']?\s*:\s*["'](completed|in_progress|pending)["']/g,
        )].map((match) => match[1]);
      }

      if (statuses.length > 0) {
        progress = {
          completed: statuses.filter((status) => status === "completed").length,
          total: statuses.length,
        };
        break;
      }
    }

    const state = {
      completed: progress?.completed ?? null,
      total: progress?.total ?? null,
      running: runningTurnId !== null,
    };
    codexSessionStateCache.set(sessionPath, {
      size: sessionStat.size,
      mtimeMs: sessionStat.mtimeMs,
      state,
    });
    return state;
  }

  const server = createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    try {
      const incomingUrl = new URL(request.url, "http://127.0.0.1");
      if (resolved.instanceToken && incomingUrl.pathname !== "/health") {
        if (incomingUrl.pathname === routePrefix) {
          response.writeHead(301, { location: `${incomingUrl.pathname}/${incomingUrl.search}` });
          response.end();
          return;
        }
        if (
          incomingUrl.pathname !== routePrefix
          && !incomingUrl.pathname.startsWith(`${routePrefix}/`)
        ) {
          throw new ApiError(404, "NOT_FOUND", "Route not found");
        }
        request.url = `${incomingUrl.pathname.slice(routePrefix.length) || "/"}${incomingUrl.search}`;
      }

      assertTrustedNetworkRequest(request, Boolean(resolved.instanceToken));
      const origin = request.headers.origin;
      const trustedEmbedOrigin = TRUSTED_EMBED_ORIGINS.has(origin)
        || (Boolean(resolved.instanceToken) && origin === "null");
      if (trustedEmbedOrigin) {
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
        response.setHeader(
          "access-control-allow-headers",
          request.headers["access-control-request-headers"] ?? "content-type",
        );
        response.setHeader("access-control-expose-headers", "x-knotline-proof");
        response.setHeader("access-control-allow-private-network", "true");
        response.setHeader("vary", "origin");
        if (request.method === "OPTIONS") {
          response.writeHead(204);
          response.end();
          return;
        }
      }
      if (resolved.instanceToken && origin === "app://-") {
        const challenge = request.headers["x-knotline-challenge"];
        if (typeof challenge !== "string" || !/^[a-f0-9]{32,128}$/i.test(challenge)) {
          throw new ApiError(401, "INVALID_INSTANCE_CHALLENGE", "Launcher challenge is required");
        }
        response.setHeader(
          "x-knotline-proof",
          createHmac("sha256", resolved.instanceSecret).update(challenge).digest("hex"),
        );
      }
      const url = new URL(request.url, "http://127.0.0.1");
      const pathname = url.pathname;
      const isLocalAiRoute = pathname === "/api/local/ai" || pathname.startsWith("/api/local/ai/");
      if (isLocalAiRoute) {
        assertAiLoopbackRequest(request);
      } else if (pathname.startsWith("/api/local/")) {
        assertLoopbackRequest(request);
      }
      const isMachineCapabilityRoute = pathname === "/api/meta"
        || pathname === "/api/device-workspaces"
        || pathname === "/api/workflow-capabilities"
        || pathname === "/api/model-selection"
        || /^\/api\/projects\/[^/]+\/development-contexts$/.test(pathname);
      const capabilityCloudConfig = isMachineCapabilityRoute
        ? await cloudConfig.read()
        : null;
      if (capabilityCloudConfig?.remoteUrl) assertLoopbackRequest(request);

      if (pathname === "/health") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if (resolved.instanceToken) {
          const challenge = request.headers["x-knotline-challenge"];
          if (typeof challenge !== "string" || !/^[a-f0-9]{32,128}$/i.test(challenge)) {
            throw new ApiError(401, "INVALID_INSTANCE_CHALLENGE", "Launcher challenge is required");
          }
          return sendJson(response, 200, {
            status: "ok",
            product: "knotline",
            version: resolved.version,
            proof: createHmac("sha256", resolved.instanceSecret)
              .update(challenge)
              .digest("hex"),
          });
        }
        return sendJson(response, 200, { status: "ok" });
      }

      if (pathname === "/api/client-storage") {
        if (request.method === "GET") {
          await clientStorageWrite;
          return sendJson(response, 200, { entries: await readClientStorage() });
        }
        if (request.method === "PATCH") {
          await updateClientStorage(await readJson(request));
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["GET", "PATCH"]);
      }

      if (pathname === "/api/local/codex-thread-progress") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].some((key) => key !== "threadId")) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Only 'threadId' is supported");
        }
        const threadIds = [...new Set(url.searchParams.getAll("threadId").map((value) => (
          value.trim().replace(/^(?:local|cloud):/i, "")
        )))];
        if (threadIds.length > 64 || threadIds.some((threadId) => (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)
        ))) {
          throw new ApiError(400, "INVALID_FIELD", "'threadId' must contain valid Codex thread IDs");
        }
        const entries = await Promise.all(threadIds.map(async (threadId) => (
          [threadId, await readCodexSessionState(threadId)]
        )));
        return sendJson(response, 200, { progress: Object.fromEntries(entries) });
      }

      if (pathname === "/api/local/host-runtime") {
        if (request.method === "GET") {
          const runtime = hostRuntime && Date.now() - hostRuntime.updatedAt <= HOST_RUNTIME_TTL_MS
            ? hostRuntime
            : null;
          return sendJson(response, 200, { runtime });
        }
        if (request.method === "PUT") {
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set([
            "threadId",
            "threadRunning",
            "threadTodoProgress",
            "codexProjectId",
            "codexProjectKind",
            "codexHostId",
            "workspacePath",
          ]));
          const threadId = stringField(body.threadId, "threadId", { required: true, maxLength: 256 });
          if (typeof body.threadRunning !== "boolean") {
            throw new ApiError(400, "INVALID_FIELD", "'threadRunning' must be a boolean");
          }
          let threadTodoProgress = null;
          if (body.threadTodoProgress != null) {
            assertPlainObject(body.threadTodoProgress);
            assertAllowedKeys(body.threadTodoProgress, new Set(["completed", "total"]));
            const { completed, total } = body.threadTodoProgress;
            if (!Number.isInteger(completed) || !Number.isInteger(total) || completed < 0 || total < 1) {
              throw new ApiError(400, "INVALID_FIELD", "'threadTodoProgress' is invalid");
            }
            threadTodoProgress = { completed: Math.min(completed, total), total };
          }
          hostRuntime = {
            threadId,
            threadRunning: body.threadRunning,
            threadTodoProgress,
            codexProjectId: stringField(body.codexProjectId ?? null, "codexProjectId", {
              nullable: true,
              maxLength: 256,
            }),
            codexProjectKind: body.codexProjectKind === "local" || body.codexProjectKind === "remote"
              ? body.codexProjectKind
              : null,
            codexHostId: stringField(body.codexHostId ?? null, "codexHostId", {
              nullable: true,
              maxLength: 256,
            }),
            workspacePath: stringField(body.workspacePath ?? null, "workspacePath", {
              nullable: true,
              maxLength: 4096,
            }),
            updatedAt: Date.now(),
          };
          return sendJson(response, 200, { runtime: hostRuntime });
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      if (pathname === "/api/local/cloud-session") {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Cloud session routes do not accept query parameters");
        }
        if (request.method === "GET") {
          const config = await cloudConfig.read();
          return sendJson(response, 200, config.remoteUrl
            ? {
              mode: "cloud",
              remoteUrl: config.remoteUrl,
              actorName: config.actorName,
              authenticated: true,
            }
            : { mode: "local", authenticated: false });
        }
        if (request.method === "PUT") {
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set(["remoteUrl", "actorName", "sharedKey"]));
          try {
            const config = await cloudConfig.configure({
              remoteUrl: body.remoteUrl,
              actorName: body.actorName,
              sharedKey: body.sharedKey,
            });
            return sendJson(response, 200, {
              mode: "cloud",
              remoteUrl: config.remoteUrl,
              actorName: config.actorName,
              authenticated: true,
            });
          } catch (error) {
            throw new ApiError(400, error.code ?? "INVALID_CLOUD_CONFIG", error.message);
          }
        }
        if (request.method === "DELETE") {
          await cloudConfig.clearCloud();
          return sendJson(response, 200, { mode: "local", authenticated: false });
        }
        return methodNotAllowed(response, ["GET", "PUT", "DELETE"]);
      }

      if (pathname === "/api/local/jira-connection") {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Jira 连接接口不接受查询参数");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { connection: await jira.status() });
        }
        if (request.method === "PUT") {
          const activeCloudConfig = await cloudConfig.read();
          if (activeCloudConfig.remoteUrl) {
            throw new ApiError(
              409,
              "JIRA_LOCAL_MODE_REQUIRED",
              "Jira 连接当前仅支持本地数据模式，请先退出云端协作模式",
            );
          }
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set(["baseUrl", "username", "password", "projects"]));
          const baseUrl = stringField(body.baseUrl, "baseUrl", { required: true, maxLength: 2048 });
          const username = stringField(body.username ?? "", "username", { maxLength: 254 });
          const password = body.password ?? "";
          if (typeof password !== "string") {
            throw new ApiError(400, "INVALID_FIELD", "'password' must be a string");
          }
          if (password.length > 4096) {
            throw new ApiError(400, "INVALID_FIELD", "'password' cannot exceed 4096 characters");
          }
          try {
            const connection = await jira.configure({
              baseUrl,
              username,
              password,
              projects: body.projects,
            });
            events.emit("project.labels.updated", { project: database.getProject(JIRA_PROJECT_ID) });
            return sendJson(response, 200, { connection });
          } catch (error) {
            if (error instanceof ApiError) throw error;
            throw new ApiError(400, error.code ?? "INVALID_JIRA_CONFIG", error.message);
          }
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      if (pathname === "/api/local/jira-connection/sync") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Jira 同步接口不接受查询参数");
        }
        await assertEmptyRequestBody(request, "POST /api/local/jira-connection/sync");
        const connection = await jira.sync({ force: true });
        events.emit("project.labels.updated", { project: database.getProject(JIRA_PROJECT_ID) });
        return sendJson(response, 200, { connection });
      }

      const projectMappingRoute = pathname.match(/^\/api\/local\/project-mappings\/([^/]+)$/);
      if (projectMappingRoute) {
        if (request.method !== "PUT") return methodNotAllowed(response, ["PUT"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project mapping routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectMappingRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["workspacePath"]));
        const workspacePath = pathField(body.workspacePath, "workspacePath");
        if (!workspacePath || !path.isAbsolute(workspacePath)) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be absolute");
        }
        await cloudConfig.setProjectWorkspace(projectId, workspacePath);
        return sendJson(response, 200, { projectId, workspacePath });
      }

      if (pathname === "/api/meta") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/meta does not accept query parameters");
        }
        return sendJson(response, 200, {
          manageKnotlineSkillPath: resolved.skillPath,
          capabilities: {
            localAiChat: !resolved.dshMode && isLoopbackAddress(request.socket.remoteAddress),
          },
          ...(capabilityCloudConfig?.remoteUrl
            ? {
              mode: "cloud",
              realtime: { transport: "poll", intervalMs: 2000 },
              localCapabilities: { available: true },
            }
            : {}),
        });
      }

      if (pathname === "/api/local/ai/catalog") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertAllowedQuery(url.searchParams, new Set(["projectId"]), "GET /api/local/ai/catalog");
        const projectId = validateProjectId(url.searchParams.get("projectId") ?? undefined);
        return sendJson(response, 200, await aiChat.getCatalog(projectId));
      }

      const projectSummaryRoute = pathname.match(/^\/api\/local\/projects\/([^/]+)\/summary$/);
      if (projectSummaryRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/projects/:id/summary");
        const projectId = validateProjectId(
          decodeRouteSegment(projectSummaryRoute[1], "Project id"),
        );
        return sendJson(response, 200, projectSummary.get(projectId));
      }

      if (pathname === "/api/local/ai/threads") {
        assertNoQuery(url.searchParams, "/api/local/ai/threads");
        if (request.method === "GET") {
          return sendJson(response, 200, { threads: await aiChat.listThreads() });
        }
        if (request.method === "POST") {
          const thread = await aiChat.createThread(parseAiThreadCreate(await readJson(request)));
          return sendJson(response, 201, { thread });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const aiThreadEventsRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)\/events$/);
      if (aiThreadEventsRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/ai/threads/:id/events");
        const threadId = decodeRouteSegment(aiThreadEventsRoute[1], "Thread id");
        await aiChat.getThreadSnapshot(threadId);
        response.writeHead(200, {
          connection: "keep-alive",
          "cache-control": "no-cache, no-transform",
          "content-type": "text/event-stream; charset=utf-8",
          "x-accel-buffering": "no",
        });
        aiEventResponses.add(response);
        const unsubscribe = aiChat.subscribe(threadId, (event) => {
          const type = event?.type === "ai.run" ? "ai.run" : "ai.event";
          response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
        });
        response.write(": connected\n\n");
        response.write('event: ai.event\ndata: {"type":"ai.event"}\n\n');
        const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 20_000);
        keepAlive.unref();
        request.once("close", () => {
          clearInterval(keepAlive);
          unsubscribe();
          aiEventResponses.delete(response);
        });
        return;
      }

      const aiThreadTurnRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)\/turns$/);
      if (aiThreadTurnRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/threads/:id/turns");
        const threadId = decodeRouteSegment(aiThreadTurnRoute[1], "Thread id");
        const run = await aiChat.startTurn(
          threadId,
          parseAiTurn(await readJson(
            request,
            AI_CHAT_TURN_BODY_LIMIT,
            "AI chat turn body cannot exceed 25 MiB",
          )),
        );
        return sendJson(response, 202, { run });
      }

      const aiThreadRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)$/);
      if (aiThreadRoute) {
        assertNoQuery(url.searchParams, "/api/local/ai/threads/:id");
        const threadId = decodeRouteSegment(aiThreadRoute[1], "Thread id");
        if (request.method === "GET") {
          return sendJson(response, 200, await aiChat.getThreadSnapshot(threadId));
        }
        if (request.method === "PATCH") {
          const thread = await aiChat.updateThread(threadId, parseAiThreadPatch(await readJson(request)));
          return sendJson(response, 200, { thread });
        }
        if (request.method === "DELETE") {
          await assertEmptyRequestBody(request, "DELETE /api/local/ai/threads/:id");
          await aiChat.deleteThread(threadId);
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["GET", "PATCH", "DELETE"]);
      }

      const aiInterruptRoute = pathname.match(/^\/api\/local\/ai\/runs\/([^/]+)\/interrupt$/);
      if (aiInterruptRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/runs/:id/interrupt");
        const runId = decodeRouteSegment(aiInterruptRoute[1], "Run id");
        await assertEmptyRequestBody(request, "POST /api/local/ai/runs/:id/interrupt");
        const run = await aiChat.interrupt(runId);
        return sendJson(response, 200, { run });
      }

      if (pathname === "/api/device-workspaces") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/device-workspaces does not accept query parameters");
        }
        return sendJson(response, 200, {
          workspaces: options.deviceWorkspaces
            ? await options.deviceWorkspaces()
            : await readCodexProjectWorkspaces(resolved.codexStatePath),
        });
      }

      if (pathname === "/api/workflow-capabilities") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const unknownQuery = [...url.searchParams.keys()].filter((key) => key !== "workspacePath");
        if (unknownQuery.length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${unknownQuery[0]}`);
        }
        const workspacePath = stringField(
          url.searchParams.get("workspacePath") ?? null,
          "workspacePath",
          { nullable: true, maxLength: 4096 },
        );
        if (workspacePath?.includes("\0")) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
        }
        if (workspacePath && !path.isAbsolute(workspacePath)) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be absolute");
        }
        return sendJson(response, 200, options.workflowCapabilities
          ? await options.workflowCapabilities(workspacePath ?? PROJECT_ROOT)
          : await discoverWorkflowCapabilities(
            resolved,
            workspacePath ?? PROJECT_ROOT,
            codexProcessEnvironment,
          ));
      }

      if (pathname === "/api/model-selection") {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Model selection does not accept query parameters");
        }
        if (!options.modelSelection) {
          throw new ApiError(503, "MODEL_SELECTION_UNAVAILABLE", "DeepSeek model selection is unavailable");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, await options.modelSelection.get());
        }
        if (request.method === "PUT") {
          try {
            const selected = await options.modelSelection.select(parseModelSelection(await readJson(request)));
            return sendJson(response, 200, { selected });
          } catch (error) {
            if (error instanceof ApiError) throw error;
            throw new ApiError(
              409,
              "MODEL_UNAVAILABLE",
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      let currentCloudConfig = null;
      if (pathname.startsWith("/api/")) {
        currentCloudConfig = await cloudConfig.read();
        if (currentCloudConfig.remoteUrl) {
          assertLoopbackRequest(request);
          if (!isLocalCompanionRoute(pathname)) {
            return sendFetchResponse(
              response,
              await cloudProxy.forward(toFetchRequest(request)),
            );
          }
        }
      }

      if (pathname === "/api/projects") {
        if (request.method === "GET") {
          if ([...url.searchParams.keys()].length > 0) {
            throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/projects does not accept query parameters");
          }
          const projects = database.listProjects().map((project) => ({
            ...project,
            workspacePath: project.id === DEFAULT_PROJECT_ID
              ? null
              : currentCloudConfig?.projectMappings[project.id] ?? project.workspacePath,
          }));
          return sendJson(response, 200, { projects });
        }
        if (request.method === "POST") {
          const project = database.createProject(parseProjectCreate(await readJson(request)));
          events.emit("project.created", { project });
          return sendJson(response, 201, { project });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const projectRoute = pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projectRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method === "DELETE") {
          database.deleteProject(projectId);
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["DELETE"]);
      }

      const projectLabelsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/labels$/);
      if (projectLabelsRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project label routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectLabelsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method !== "POST" && request.method !== "DELETE") {
          return methodNotAllowed(response, ["POST", "DELETE"]);
        }
        if (request.method === "DELETE" && projectId === JIRA_PROJECT_ID) {
          throw new ApiError(
            409,
            "JIRA_LABEL_CATALOG_DELETE_UNAVAILABLE",
            "Jira 标签目录由同步管理，不能在 Knotline 中删除",
          );
        }
        const label = parseProjectLabel(await readJson(request));
        const project = request.method === "POST"
          ? database.addProjectLabel(projectId, label)
          : database.deleteProjectLabel(projectId, label);
        events.emit("project.labels.updated", { project });
        return sendJson(response, 200, { project });
      }

      const workflowWorkspaceRoute = pathname.match(/^\/api\/projects\/([^/]+)\/workflow-workspace$/);
      if (workflowWorkspaceRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Workflow workspace routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(workflowWorkspaceRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method === "GET") {
          return sendJson(response, 200, { workflow: database.getWorkflowWorkspace(projectId) });
        }
        if (request.method === "PUT") {
          const input = parseWorkflowWorkspaceSave(await readJson(request));
          const workflow = database.saveWorkflowWorkspace(projectId, input.version, input.workspace);
          events.emit("workflow.updated", {
            projectId,
            workflowVersion: workflow.version,
          });
          return sendJson(response, 200, { workflow });
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      const projectMapRoute = pathname.match(/^\/api\/projects\/([^/]+)\/map$/);
      if (projectMapRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertAllowedQuery(url.searchParams, new Set(["canvasId"]), "Project map routes");
        let projectId;
        try {
          projectId = decodeURIComponent(projectMapRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const canvasIdValue = url.searchParams.get("canvasId");
        const canvasId = canvasIdValue === null
          ? null
          : stringField(canvasIdValue, "canvasId", { required: true, maxLength: 256 });
        const map = await graph.getProjectMap(projectId, canvasId);
        if (!map) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
        return sendJson(response, 200, { map });
      }

      const projectCanvasesRoute = pathname.match(/^\/api\/projects\/([^/]+)\/canvases$/);
      if (projectCanvasesRoute) {
        assertNoQuery(url.searchParams, "Project canvas routes");
        const projectId = validateProjectId(decodeRouteSegment(projectCanvasesRoute[1], "Project id"));
        if (request.method === "GET") {
          return sendJson(response, 200, { canvases: database.listProjectCanvases(projectId) });
        }
        if (request.method === "POST") {
          const canvas = database.createProjectCanvas(projectId);
          events.emit("canvas.created", { projectId, canvas });
          return sendJson(response, 201, { canvas });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const projectCanvasNodesRoute = pathname.match(/^\/api\/projects\/([^/]+)\/canvases\/([^/]+)\/nodes$/);
      if (projectCanvasNodesRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "Canvas node routes");
        const projectId = validateProjectId(decodeRouteSegment(projectCanvasNodesRoute[1], "Project id"));
        const canvasId = decodeRouteSegment(projectCanvasNodesRoute[2], "Canvas id");
        const input = parseCanvasNodeAssignment(await readJson(request));
        const membership = await graph.assignNodeToCanvas(projectId, canvasId, input.nodeId);
        events.emit("canvas.node.assigned", { projectId, canvasId, nodeId: input.nodeId });
        return sendJson(response, 201, { membership });
      }

      const projectCanvasClearRoute = pathname.match(/^\/api\/projects\/([^/]+)\/canvases\/([^/]+)\/clear$/);
      if (projectCanvasClearRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "Canvas clear routes");
        const projectId = validateProjectId(decodeRouteSegment(projectCanvasClearRoute[1], "Project id"));
        const canvasId = decodeRouteSegment(projectCanvasClearRoute[2], "Canvas id");
        const result = database.clearProjectCanvas(projectId, canvasId);
        events.emit("canvas.cleared", { projectId, canvasId, clearedNodeCount: result.clearedNodeCount });
        return sendJson(response, 200, result);
      }

      const projectAgentsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/agents$/);
      if (projectAgentsRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        let projectId;
        try {
          projectId = decodeURIComponent(projectAgentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const agent = governance.createAgent(projectId, parseAgentProfileCreate(await readJson(request)));
        const binding = await options.agentOrchestrator?.provisionAgent?.(agent.id);
        events.emit("graph.node.updated", { projectId, entityType: "agent_profile", entityId: agent.id });
        events.emit("agent.runtime.updated", { projectId, binding });
        return sendJson(response, 201, { agent: database.getAgentProfile(agent.id), binding: binding ?? null });
      }

      const projectKnowledgeInitializeRoute = pathname.match(/^\/api\/projects\/([^/]+)\/knowledge\/initialize$/);
      if (projectKnowledgeInitializeRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        let projectId;
        try {
          projectId = decodeURIComponent(projectKnowledgeInitializeRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const input = parseKnowledgeInitialize(await readJson(request));
        const result = knowledge.initializeWithLeader(projectId, input.leaderAgentId);
        events.emit("task.created", { projectId, task: result.task });
        events.emit("node_run.queued", { projectId, nodeRun: result.nodeRun });
        Promise.resolve(options.agentOrchestrator?.startNodeRun?.(result.nodeRun.id)).catch((error) => {
          console.error(error);
        });
        return sendJson(response, 201, result);
      }

      const contextDuplicateRoute = pathname.match(/^\/api\/knowledge-assets\/([^/]+)\/duplicate$/);
      if (contextDuplicateRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        const assetId = decodeRouteSegment(contextDuplicateRoute[1], "Knowledge asset id");
        const result = knowledge.duplicateContext(assetId, actorFromRequest(request));
        events.emit("knowledge.updated", {
          projectId: result.asset.projectId,
          asset: result.asset,
          knowledgeVersion: result.knowledgeVersion,
        });
        return sendJson(response, 201, result);
      }

      const projectDemandsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/demands$/);
      if (projectDemandsRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        let projectId;
        try {
          projectId = decodeURIComponent(projectDemandsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const demand = governance.createDemand(
          projectId,
          parseDemandCreate(await readJson(request)),
          actorFromRequest(request),
        );
        events.emit("graph.node.updated", { projectId, entityType: "demand", entityId: demand.id });
        return sendJson(response, 201, { demand });
      }

      const projectBacklogsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/backlogs$/);
      if (projectBacklogsRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        let projectId;
        try {
          projectId = decodeURIComponent(projectBacklogsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const backlog = governance.createBacklogPool(
          projectId,
          parseBacklogCreate(await readJson(request)),
          actorFromRequest(request),
        );
        events.emit("graph.node.updated", { projectId, entityType: "backlog_pool", entityId: backlog.id });
        return sendJson(response, 201, { backlog });
      }

      const projectApprovalPoolsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/approval-pools$/);
      if (projectApprovalPoolsRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        let projectId;
        try {
          projectId = decodeURIComponent(projectApprovalPoolsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const approvalPool = governance.createApprovalPool(
          projectId,
          parseBacklogCreate(await readJson(request)),
          actorFromRequest(request),
        );
        events.emit("graph.node.updated", { projectId, entityType: "approval_pool", entityId: approvalPool.id });
        return sendJson(response, 201, { approvalPool });
      }

      const projectSkillsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/skills$/);
      if (projectSkillsRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        let projectId;
        try {
          projectId = decodeURIComponent(projectSkillsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const project = database.getProject(projectId);
        if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
        const input = parseSkillNodeCreate(await readJson(request));
        const capabilities = options.workflowCapabilities
          ? await options.workflowCapabilities(project.workspacePath ?? PROJECT_ROOT)
          : await discoverWorkflowCapabilities(
            resolved,
            project.workspacePath ?? PROJECT_ROOT,
            codexProcessEnvironment,
          );
        const installedSkill = capabilities.skills.find((skill) => skill.id === input.skillId);
        if (!installedSkill) {
          throw new ApiError(409, "SKILL_NOT_INSTALLED", `Skill '${input.skillId}' is not installed in this workspace`);
        }
        const actor = actorFromRequest(request);
        const skillNode = database.createSkillNode({
          id: randomUUID(),
          projectId,
          skillId: installedSkill.id,
          label: installedSkill.label,
          description: installedSkill.description,
          scope: installedSkill.scope,
          createdBy: `${actor.type}:${actor.id}`,
        });
        events.emit("graph.node.updated", { projectId, entityType: "skill", entityId: skillNode.id });
        return sendJson(response, 201, { skillNode });
      }

      const projectMapItemsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/map-items$/);
      if (projectMapItemsRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        let projectId;
        try {
          projectId = decodeURIComponent(projectMapItemsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const actor = actorFromRequest(request);
        const input = parseMapItemCreate(await readJson(request));
        const mapItem = database.createMapItem({
          id: randomUUID(),
          projectId,
          ...input,
          createdBy: `${actor.type}:${actor.id}`,
        });
        events.emit("graph.node.updated", { projectId, entityType: mapItem.kind, entityId: mapItem.id });
        return sendJson(response, 201, { mapItem });
      }

      const projectScheduledTriggersRoute = pathname.match(/^\/api\/projects\/([^/]+)\/scheduled-triggers$/);
      if (projectScheduledTriggersRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        let projectId;
        try {
          projectId = decodeURIComponent(projectScheduledTriggersRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (!database.getProject(projectId)) {
          throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
        }
        const actor = actorFromRequest(request);
        const trigger = database.createScheduledTrigger({
          id: randomUUID(),
          projectId,
          ...parseScheduledTriggerCreate(await readJson(request)),
          createdBy: `${actor.type}:${actor.id}`,
        });
        events.emit("graph.node.updated", { projectId, entityType: "scheduled_trigger", entityId: trigger.id });
        return sendJson(response, 201, { trigger });
      }

      const scheduledTriggerRoute = pathname.match(/^\/api\/scheduled-triggers\/([^/]+)$/);
      if (scheduledTriggerRoute) {
        if (request.method !== "PATCH") return methodNotAllowed(response, ["PATCH"]);
        let triggerId;
        try {
          triggerId = decodeURIComponent(scheduledTriggerRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Scheduled Trigger id contains invalid encoding");
        }
        const current = database.getScheduledTrigger(triggerId);
        if (!current) {
          throw new ApiError(404, "SCHEDULED_TRIGGER_NOT_FOUND", `Scheduled Trigger '${triggerId}' does not exist`);
        }
        const input = parseScheduledTriggerUpdate(await readJson(request));
        const trigger = database.updateScheduledTriggerEnabled(triggerId, input.enabled);
        events.emit("graph.node.updated", { projectId: trigger.projectId, entityType: "scheduled_trigger", entityId: trigger.id });
        return sendJson(response, 200, { trigger });
      }

      const graphResolveRoute = pathname.match(/^\/api\/projects\/([^/]+)\/graph\/actions\/resolve$/);
      if (graphResolveRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        let projectId;
        try {
          projectId = decodeURIComponent(graphResolveRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const input = parseGraphResolve(await readJson(request));
        const resolution = await graph.resolveAction(projectId, input.sourceNodeId, input.targetNodeId);
        return sendJson(response, 200, { resolution });
      }

      const projectGraphCommandsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/graph\/commands$/);
      if (projectGraphCommandsRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        let projectId;
        try {
          projectId = decodeURIComponent(projectGraphCommandsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const actor = actorFromRequest(request);
        const command = await graph.executeCommand(
          projectId,
          parseGraphCommand(await readJson(request)),
          actor,
        );
        emitGraphCommandEvents(projectId, command, actor);
        if (["agent_assignment", "demand_assignment", "context_assignment", "artifact_review_assignment", "knowledge_binding", "approval_assignment"].includes(command.result?.kind)) {
          Promise.resolve(options.agentOrchestrator?.startNodeRun?.(command.result.nodeRun.id)).catch((error) => {
            console.error(error);
          });
        }
        if (command.result?.kind === "agent_team_created") {
          const binding = await options.agentOrchestrator?.provisionAgent?.(command.result.team.id);
          events.emit("agent.runtime.updated", { projectId, binding });
        }
        if (command.result?.kind === "execution_review_rejected") {
          Promise.resolve(options.agentOrchestrator?.startNodeRun?.(command.result.reworkRun.id)).catch((error) => {
            console.error(error);
          });
        }
        return sendJson(response, 201, { command });
      }

      const graphCommandRoute = pathname.match(/^\/api\/graph\/commands\/([^/]+)$/);
      if (graphCommandRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        let commandId;
        try {
          commandId = decodeURIComponent(graphCommandRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Graph command id contains invalid encoding");
        }
        const command = graph.getCommand(commandId);
        if (!command) throw new ApiError(404, "GRAPH_COMMAND_NOT_FOUND", `Graph command '${commandId}' does not exist`);
        return sendJson(response, 200, { command });
      }

      const nodeRunRoute = pathname.match(/^\/api\/node-runs\/([^/]+)(?:\/(runtime|start|update|control|submit-delivery|request-review|knowledge-proposals|project-context))?$/);
      if (nodeRunRoute) {
        let nodeRunId;
        try {
          nodeRunId = decodeURIComponent(nodeRunRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Node Run id contains invalid encoding");
        }
        const action = nodeRunRoute[2] ?? null;
        if (action === null && request.method === "GET") {
          return sendJson(response, 200, { nodeRun: requireNodeRun(nodeRunId) });
        }
        if (action === "project-context" && request.method === "GET") {
          return sendJson(response, 200, { context: await projectContextForNodeRun(nodeRunId) });
        }
        if (request.method !== "POST") return methodNotAllowed(response, ["GET", "POST"]);
        const actor = actorFromRequest(request);
        if (action === "knowledge-proposals") {
          const result = knowledge.proposeFromNodeRun(
            nodeRunId,
            parseKnowledgeProposal(await readJson(request)),
            actor,
          );
          if (result.kind === "knowledge_initialized") {
            events.emit("knowledge.updated", {
              projectId: result.asset.projectId,
              asset: result.asset,
              knowledgeVersion: result.knowledgeVersion,
            });
            emitNotification(notifications.publish("knowledge.updated", {
              projectId: result.asset.projectId,
              entityType: "knowledge_asset",
              entityId: result.asset.id,
              graphNodeId: `knowledge_asset:${result.asset.id}`,
              actor,
              title: `${result.asset.title} v1 published`,
              body: result.knowledgeVersion.content,
              reason: "The Project Leader completed Knowledge initialization.",
              impact: "Agents can now bind this exact Project Knowledge version.",
              context: { knowledgeNodeId: `knowledge_asset:${result.asset.id}` },
              dedupeKey: `knowledge-version:${result.asset.id}:1`,
            }));
            return sendJson(response, 201, { proposalId: result.asset.id, status: "published", result });
          }
          events.emit("knowledge.updated", { projectId: result.asset.projectId, ...result });
          publishKnowledgeProposalNotification(result.proposal, result.asset, actor);
          return sendJson(response, 201, { proposalId: result.proposal.id, status: result.proposal.status, result });
        }
        if (action === "runtime") {
          const input = parseNodeRunRuntime(await readJson(request));
          const current = requireNodeRun(nodeRunId);
          const nodeRun = orchestration.updateNodeRun(nodeRunId, {
            sessionId: input.sessionId,
            status: input.status === "blocked" || input.status === "waiting"
              ? "waiting_input"
              : input.status === "working" && current.status === "queued" ? "running" : current.status,
            error: input.error,
            ...(input.finalMessage
              ? { result: { ...(current.result ?? {}), finalMessage: input.finalMessage } }
              : {}),
          });
          const existingBinding = database.getAgentRuntimeBindingByProfile(current.agentProfileId);
          const bindingMovedOn = input.status === "idle"
            && existingBinding?.currentNodeRunId
            && existingBinding.currentNodeRunId !== current.id;
          const binding = bindingMovedOn
            ? existingBinding
            : orchestration.updateBinding(current.agentProfileId, {
              sessionId: input.sessionId,
              currentNodeRunId: current.id,
              status: input.status,
              lastError: input.error,
            });
          events.emit("agent.runtime.updated", { projectId: current.projectId, binding, nodeRun });
          return sendJson(response, 200, { nodeRun, binding });
        }
        if (action === "start") {
          await readJson(request);
          const result = updateExecutionProgress(nodeRunId, { status: "running", comment: "" }, actor);
          events.emit("node_run.updated", { projectId: result.nodeRun.projectId, ...result });
          return sendJson(response, 200, result);
        }
        if (action === "update") {
          const result = updateExecutionProgress(nodeRunId, parseNodeRunProgress(await readJson(request)), actor);
          events.emit("node_run.updated", { projectId: result.nodeRun.projectId, ...result });
          return sendJson(response, 200, result);
        }
        if (action === "control") {
          const input = parseNodeRunControl(await readJson(request));
          const result = await options.agentOrchestrator?.controlNodeRun?.(nodeRunId, input.action);
          if (!result) throw new ApiError(503, "AGENT_RUNTIME_UNAVAILABLE", "DeepSeek Harness Agent runtime is unavailable");
          events.emit("node_run.updated", { projectId: result.nodeRun.projectId, ...result });
          events.emit("agent.runtime.updated", { projectId: result.nodeRun.projectId, binding: result.binding });
          return sendJson(response, 200, result);
        }
        if (action === "submit-delivery" || action === "request-review") {
          const result = submitExecutionForReview(nodeRunId, parseDelivery(await readJson(request)), actor);
          if (result.kind === "context_attached") {
            result.contextEdge = graph.storeContextResult(
              result.nodeRun.projectId,
              result.demand.id,
              result.asset.id,
              actor,
            );
            emitContextAttached(result.nodeRun.projectId, result);
          }
          if (result.approvalExecution?.artifact) {
            emitNotification(notifications.publish("task.completed", {
              projectId: result.nodeRun.projectId,
              entityType: "node_run",
              entityId: result.nodeRun.id,
              graphNodeId: `node_run:${result.nodeRun.id}`,
              actor,
              title: `实施完成：${result.approvalExecution.artifact.title}`,
              body: String(result.nodeRun.result?.summary ?? "实施任务已完成"),
              reason: "执行 Agent 已完成从审批池提取的功能模块。",
              impact: "阅读实施结果后，该通知节点可从画布关闭。",
              context: {
                showOnMap: true,
                evidence: String(result.nodeRun.result?.evidence ?? ""),
                nodeRunNodeId: `node_run:${result.nodeRun.id}`,
                approvalPoolId: result.approvalExecution.approvalPool?.id ?? null,
                artifactId: result.approvalExecution.artifact.id,
              },
              dedupeKey: `approval-execution-completed:${result.nodeRun.id}`,
            }));
          }
          events.emit(result.reviewGate ? "review.requested" : "node_run.updated", {
            projectId: result.nodeRun.projectId,
            ...result,
          });
          if (result.approvalDeposit) {
            for (const edge of result.approvalDeposit.edges) {
              events.emit("graph.edge.updated", { projectId: result.nodeRun.projectId, edge });
            }
            events.emit("graph.node.updated", {
              projectId: result.nodeRun.projectId,
              entityType: "approval_pool",
              entityId: result.approvalDeposit.approvalPool.id,
            });
            if (result.approvalDeposit.assignment) {
              emitGraphCommandEvents(result.nodeRun.projectId, { result: result.approvalDeposit.assignment }, actor);
              Promise.resolve(options.agentOrchestrator?.startNodeRun?.(result.approvalDeposit.assignment.nodeRun.id)).catch((error) => {
                console.error(error);
              });
            }
          }
          if (result.nextAssignment) {
            emitGraphCommandEvents(result.nodeRun.projectId, { result: result.nextAssignment }, actor);
            Promise.resolve(options.agentOrchestrator?.startNodeRun?.(result.nextAssignment.nodeRun.id)).catch((error) => {
              console.error(error);
            });
          }
          return sendJson(response, 200, result);
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const agentRuntimeMessageRoute = pathname.match(/^\/api\/agents\/([^/]+)\/messages$/);
      if (agentRuntimeMessageRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        let agentProfileId;
        try {
          agentProfileId = decodeURIComponent(agentRuntimeMessageRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Agent id contains invalid encoding");
        }
        const input = parseAgentRuntimeMessage(await readJson(request));
        if (!options.agentOrchestrator?.messageAgent) {
          throw new ApiError(503, "AGENT_HOST_UNAVAILABLE", "DeepSeek Harness Agent orchestration is not available");
        }
        let nodeRun = null;
        if (input.mode === "followup") {
          nodeRun = orchestration.queueFollowup(agentProfileId, input.message);
          events.emit("node_run.queued", { projectId: nodeRun.projectId, nodeRun });
        }
        await options.agentOrchestrator.messageAgent(agentProfileId, input.mode, input.message, nodeRun?.id ?? null);
        return sendJson(response, 202, { accepted: true, nodeRun });
      }

      const agentProfileRoute = pathname.match(/^\/api\/agents\/([^/]+)$/);
      if (agentProfileRoute) {
        if (request.method !== "PATCH") return methodNotAllowed(response, ["PATCH"]);
        let agentProfileId;
        try {
          agentProfileId = decodeURIComponent(agentProfileRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Agent id contains invalid encoding");
        }
        const agent = governance.renameAgent(
          agentProfileId,
          parseAgentProfileRename(await readJson(request)).name,
        );
        events.emit("graph.node.updated", {
          projectId: agent.projectId,
          entityType: "agent_profile",
          entityId: agent.id,
        });
        return sendJson(response, 200, { agent });
      }

      const graphNodeLayoutRoute = pathname.match(/^\/api\/graph\/nodes\/([^/]+)\/layout$/);
      if (graphNodeLayoutRoute) {
        if (request.method !== "PATCH") return methodNotAllowed(response, ["PATCH"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Graph layout routes do not accept query parameters");
        }
        let nodeId;
        try {
          nodeId = decodeURIComponent(graphNodeLayoutRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Graph node id contains invalid encoding");
        }
        const input = parseGraphLayout(await readJson(request));
        const node = await graph.saveNodeLayout(nodeId, input);
        if (!node) throw new ApiError(404, "GRAPH_NODE_NOT_FOUND", `Graph node '${nodeId}' does not exist`);
        events.emit("graph.node.updated", { projectId: node.projectId, node });
        return sendJson(response, 200, { node });
      }

      if (pathname === "/api/notifications") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const unknownQuery = [...url.searchParams.keys()].filter((key) => key !== "projectId");
        if (unknownQuery.length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${unknownQuery[0]}`);
        }
        const projectIdValue = url.searchParams.get("projectId");
        const projectId = projectIdValue === null ? null : validateProjectId(projectIdValue);
        return sendJson(response, 200, { notifications: notifications.list(projectId) });
      }

      const notificationActionRoute = pathname.match(/^\/api\/notifications\/([^/]+)\/actions\/([^/]+)$/);
      if (notificationActionRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        let notificationId;
        let action;
        try {
          notificationId = decodeURIComponent(notificationActionRoute[1]);
          action = decodeURIComponent(notificationActionRoute[2]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Notification action path contains invalid encoding");
        }
        const actor = actorFromRequest(request);
        const actionInput = notifications.actionCommand(
          notificationId,
          action,
          parseNotificationAction(await readJson(request)),
        );
        const command = await graph.executeCommand(actionInput.projectId, actionInput, actor);
        emitGraphCommandEvents(actionInput.projectId, command, actor);
        if (["agent_assignment", "demand_assignment", "artifact_review_assignment", "knowledge_binding", "approval_assignment"].includes(command.result?.kind)) {
          Promise.resolve(options.agentOrchestrator?.startNodeRun?.(command.result.nodeRun.id)).catch((error) => {
            console.error(error);
          });
        }
        if (command.result?.kind === "execution_review_rejected") {
          Promise.resolve(options.agentOrchestrator?.startNodeRun?.(command.result.reworkRun.id)).catch((error) => {
            console.error(error);
          });
        }
        const notification = notifications.updateRecipient(notificationId, actor, {
          read: true,
          handled: action !== "ask",
        });
        events.emit("notification.updated", { projectId: actionInput.projectId, notification });
        return sendJson(response, 200, { command, notification });
      }

      const notificationRoute = pathname.match(/^\/api\/notifications\/([^/]+)$/);
      if (notificationRoute) {
        if (request.method !== "PATCH") return methodNotAllowed(response, ["PATCH"]);
        let notificationId;
        try {
          notificationId = decodeURIComponent(notificationRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Notification id contains invalid encoding");
        }
        const notification = notifications.updateRecipient(
          notificationId,
          actorFromRequest(request),
          parseNotificationUpdate(await readJson(request)),
        );
        if (!notification) throw new ApiError(404, "NOTIFICATION_NOT_FOUND", "Notification no longer exists");
        events.emit("notification.updated", { projectId: notification.projectId, notification });
        return sendJson(response, 200, { notification });
      }

      const developmentContextsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/development-contexts$/);
      if (developmentContextsRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const unknownQuery = [...url.searchParams.keys()].filter((key) => (
          !["codexProjectId", "codexThreadId", "workspacePath"].includes(key)
        ));
        if (unknownQuery.length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${unknownQuery[0]}`);
        }
        let projectId;
        try {
          projectId = decodeURIComponent(developmentContextsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const project = currentCloudConfig.remoteUrl
          ? {
            id: projectId,
            workspacePath: projectId === DEFAULT_PROJECT_ID
              ? null
              : currentCloudConfig.projectMappings[projectId] ?? null,
          }
          : database.getProject(projectId);
        if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
        const codexProjectId = stringField(url.searchParams.get("codexProjectId") ?? null, "codexProjectId", {
          nullable: true,
          maxLength: 128,
        });
        const codexThreadId = stringField(url.searchParams.get("codexThreadId") ?? null, "codexThreadId", {
          nullable: true,
          maxLength: 256,
        });
        const deviceWorkspacePath = stringField(
          url.searchParams.get("workspacePath") ?? null,
          "workspacePath",
          { nullable: true, maxLength: 4096 },
        );
        if (deviceWorkspacePath?.includes("\0")) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
        }
        const workspacePath = deviceWorkspacePath ?? await resolveProjectWorkspace(
          project,
          codexProjectId,
          codexThreadId,
          resolved.codexStatePath,
          resolved.codexProcessesPath,
        );
        return sendJson(
          response,
          200,
          await scanDevelopmentContexts(workspacePath, codexProcessEnvironment),
        );
      }

      if (pathname === "/api/tasks") {
        if (request.method === "GET") {
          const filters = parseTaskFilters(url.searchParams);
          if (filters.projectId === JIRA_PROJECT_ID) await jira.sync();
          return sendJson(response, 200, { tasks: database.listTasks(filters) });
        }
        if (request.method === "POST") {
          const actor = actorFromRequest(request);
          const { assigneeTarget, ...parsedInput } = parseTaskCreate(await readJson(request));
          const input = resolveInputThreadBinding(parsedInput);
          if (input.projectId === JIRA_PROJECT_ID) {
            throw new ApiError(
              409,
              "JIRA_CREATE_UNAVAILABLE",
              "请在 Jira 中新建议题，Knotline 当前只同步已分配给你的任务",
            );
          }
          const task = database.createTask({
            ...input,
            actor,
            assignee: resolveAssignee(assigneeTarget, actor),
          });
          events.emit("task.created", { task });
          return sendJson(response, 201, { task });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      if (pathname === "/api/events") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/events does not accept query parameters");
        }
        events.connect(request, response);
        return;
      }

      const taskRelationRoute = pathname.match(
        /^\/api\/tasks\/([^/]+)\/relations\/([^/]+)\/([^/]+)$/,
      );
      if (taskRelationRoute) {
        let taskId;
        let type;
        let relatedTaskId;
        try {
          taskId = decodeURIComponent(taskRelationRoute[1]);
          type = decodeURIComponent(taskRelationRoute[2]);
          relatedTaskId = decodeURIComponent(taskRelationRoute[3]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Issue relation path contains invalid encoding");
        }
        if (
          taskId.length === 0
          || taskId.length > 128
          || relatedTaskId.length === 0
          || relatedTaskId.length > 128
        ) {
          throw new ApiError(400, "INVALID_PATH", "Issue relation task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Issue relation routes do not accept query parameters");
        }
        const relationType = parseIssueRelationType(type);
        if (request.method === "POST") {
          const { version, threadId, threadBinding } = resolveInputThreadBinding(
            parseArchive(await readJson(request)),
          );
          const result = database.addTaskRelation(
            taskId,
            version,
            relationType,
            relatedTaskId,
            threadId,
            threadBinding,
            actorFromRequest(request),
          );
          events.emit("task.relation.updated", result);
          return sendJson(response, 200, result);
        }
        if (request.method === "DELETE") {
          const { version, threadId, threadBinding } = resolveInputThreadBinding(
            parseArchive(await readJson(request)),
          );
          const result = database.removeTaskRelation(
            taskId,
            version,
            relationType,
            relatedTaskId,
            threadId,
            threadBinding,
            actorFromRequest(request),
          );
          events.emit("task.relation.updated", result);
          return sendJson(response, 200, result);
        }
        return methodNotAllowed(response, ["POST", "DELETE"]);
      }

      const taskActivitiesRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/activities$/);
      if (taskActivitiesRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskActivitiesRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Activity routes do not accept query parameters");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { activities: database.listTaskActivities(taskId) });
        }
        return methodNotAllowed(response, ["GET"]);
      }

      const taskCommentsRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/comments$/);
      if (taskCommentsRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskCommentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Comment routes do not accept query parameters");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { comments: database.listComments(taskId) });
        }
        if (request.method === "POST") {
          const comment = database.createComment(taskId, {
            ...resolveInputThreadBinding(parseCommentCreate(await readJson(request))),
            actor: actorFromRequest(request),
          });
          const task = database.getTask(taskId);
          events.emit("comment.created", { comment, task });
          return sendJson(response, 201, { comment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const commentRoute = pathname.match(/^\/api\/comments\/([^/]+)$/);
      if (commentRoute) {
        let id;
        try {
          id = decodeURIComponent(commentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Comment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Comment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Comment routes do not accept query parameters");
        }
        if (request.method === "PATCH") {
          const patch = resolveInputThreadBinding(parseCommentPatch(await readJson(request)));
          const comment = database.updateComment(
            id,
            patch.version,
            patch.body,
            patch.threadId,
            patch.threadBinding,
          );
          const task = database.getTask(comment.taskId);
          events.emit("comment.updated", { comment, task });
          return sendJson(response, 200, { comment });
        }
        if (request.method === "DELETE") {
          const { version } = parseArchive(await readJson(request));
          const comment = database.deleteComment(id, version);
          for (const attachment of comment.attachments) {
            try {
              await unlink(path.join(resolved.attachmentsDirectory, attachment.id));
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
          }
          const task = database.getTask(comment.taskId);
          events.emit("comment.deleted", { comment, task });
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["PATCH", "DELETE"]);
      }

      const commentAttachmentsRoute = pathname.match(/^\/api\/comments\/([^/]+)\/attachments$/);
      if (commentAttachmentsRoute) {
        let commentId;
        try {
          commentId = decodeURIComponent(commentAttachmentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Comment id contains invalid encoding");
        }
        if (commentId.length === 0 || commentId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Comment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { attachments: database.listCommentAttachments(commentId) });
        }
        if (request.method === "POST") {
          const comment = database.getComment(commentId);
          if (!comment) throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
          const metadata = parseAttachmentHeaders(request);
          const body = await readBody(request, ATTACHMENT_BODY_LIMIT, "Attachment cannot exceed 25 MiB");
          const id = randomUUID();
          await mkdir(resolved.attachmentsDirectory, { recursive: true });
          const storagePath = path.join(resolved.attachmentsDirectory, id);
          await writeFile(storagePath, body, { flag: "wx" });
          let attachment;
          try {
            attachment = database.createCommentAttachment(commentId, { id, ...metadata, size: body.length });
          } catch (error) {
            await unlink(storagePath);
            throw error;
          }
          const task = database.getTask(comment.taskId);
          events.emit("attachment.created", { attachment, comment: database.getComment(commentId), task });
          return sendJson(response, 201, { attachment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const taskAttachmentsRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/attachments$/);
      if (taskAttachmentsRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskAttachmentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { attachments: database.listAttachments(taskId) });
        }
        if (request.method === "POST") {
          const task = database.getTask(taskId);
          if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
          const metadata = parseAttachmentHeaders(request);
          const body = await readBody(request, ATTACHMENT_BODY_LIMIT, "Attachment cannot exceed 25 MiB");
          const id = randomUUID();
          await mkdir(resolved.attachmentsDirectory, { recursive: true });
          const storagePath = path.join(resolved.attachmentsDirectory, id);
          await writeFile(storagePath, body, { flag: "wx" });
          let attachment;
          try {
            attachment = database.createAttachment(taskId, { id, ...metadata, size: body.length });
          } catch (error) {
            await unlink(storagePath);
            throw error;
          }
          events.emit("attachment.created", { attachment, task });
          return sendJson(response, 201, { attachment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const attachmentContentRoute = pathname.match(/^\/api\/attachments\/([^/]+)\/(content|download)$/);
      if (attachmentContentRoute) {
        let id;
        try {
          id = decodeURIComponent(attachmentContentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Attachment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Attachment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          return methodNotAllowed(response, ["GET", "HEAD"]);
        }
        const attachment = database.getAttachment(id);
        if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
        const body = await readFile(path.join(resolved.attachmentsDirectory, attachment.id));
        const encodedFilename = encodeURIComponent(attachment.filename).replace(/['()*]/g, (character) => (
          `%${character.charCodeAt(0).toString(16).toUpperCase()}`
        ));
        const canOpenInline = attachmentContentRoute[2] === "content"
          && INLINE_ATTACHMENT_TYPES.has(attachment.contentType);
        response.writeHead(200, {
          "cache-control": "private, no-store",
          "content-disposition": `${canOpenInline ? "inline" : "attachment"}; filename*=UTF-8''${encodedFilename}`,
          "content-length": body.length,
          "content-security-policy": "sandbox; default-src 'none'",
          "content-type": canOpenInline ? attachment.contentType : "application/octet-stream",
        });
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }

      const attachmentRoute = pathname.match(/^\/api\/attachments\/([^/]+)$/);
      if (attachmentRoute) {
        let id;
        try {
          id = decodeURIComponent(attachmentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Attachment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Attachment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method !== "DELETE") return methodNotAllowed(response, ["DELETE"]);
        const attachment = database.getAttachment(id);
        if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
        try {
          await unlink(path.join(resolved.attachmentsDirectory, attachment.id));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        database.deleteAttachment(id);
        const task = database.getTask(attachment.taskId);
        events.emit("attachment.deleted", { attachment, task });
        return sendEmpty(response, 204);
      }

      const taskRoute = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(archive|restore|move))?$/);
      if (taskRoute) {
        let id;
        try {
          id = decodeURIComponent(taskRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        const action = taskRoute[2];
        if (!action && request.method === "GET") {
          if ([...url.searchParams.keys()].length > 0) {
            throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/tasks/:id does not accept query parameters");
          }
          const task = database.getTask(id);
          if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          return sendJson(response, 200, { task });
        }
        if (!action && request.method === "PATCH") {
          const actor = actorFromRequest(request);
          const {
            version,
            changes,
            threadId,
            threadBinding,
            assigneeTarget,
          } = resolveInputThreadBinding(parseTaskPatch(await readJson(request)));
          const current = database.getTask(id);
          if (!current) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          let jiraChanged = false;
          if (current.source !== "jira" && changes.projectId === JIRA_PROJECT_ID) {
            throw new ApiError(
              409,
              "JIRA_PROJECT_MOVE_UNAVAILABLE",
              "本地任务不能移入 Jira 同步项目",
            );
          }
          if (current.source === "jira") {
            if (current.version !== version) {
              throw new ApiError(409, "VERSION_CONFLICT", "Task changed since it was last read", {
                expectedVersion: version,
                actualVersion: current.version,
              });
            }
            if (current.archivedAt !== null) {
              throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be updated");
            }
            if (Object.hasOwn(changes, "projectId")) {
              throw new ApiError(409, "JIRA_PROJECT_MOVE_UNAVAILABLE", "Jira 任务不能移到本地项目");
            }
            if (assigneeTarget !== undefined) {
              throw new ApiError(409, "JIRA_ASSIGNEE_UNAVAILABLE", "请在 Jira 中修改经办人");
            }
            const dueDate = Object.hasOwn(changes, "dueDate") ? changes.dueDate : current.dueDate;
            const recurrence = Object.hasOwn(changes, "recurrence")
              ? changes.recurrence
              : current.recurrence;
            if (recurrence && !dueDate) {
              throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires a due date");
            }
            jiraChanged = await jira.updateTask(current, changes);
          }
          if (assigneeTarget !== undefined) {
            changes.assignee = resolveAssignee(assigneeTarget, actor);
          }
          let task;
          try {
            task = database.updateTask(id, version, changes, threadId, threadBinding, actor);
          } catch (error) {
            if (jiraChanged) {
              try {
                await jira.reconcile();
              } catch {
                throw new ApiError(
                  502,
                  "JIRA_RECONCILE_FAILED",
                  "Jira 已更新，但 Knotline 重新同步失败，请手动同步",
                );
              }
            }
            throw error;
          }
          events.emit("task.updated", { task });
          publishTaskStatusNotification(task, current.status, actor);
          return sendJson(response, 200, { task });
        }
        if (!action && request.method === "DELETE") {
          const current = database.getTask(id);
          if (current?.source === "jira") {
            throw new ApiError(409, "JIRA_DELETE_UNAVAILABLE", "Jira 任务不能从 Knotline 永久删除");
          }
          const { version } = parseArchive(await readJson(request));
          const deleted = database.deleteArchivedTask(id, version);
          for (const attachmentId of deleted.attachmentIds) {
            try {
              await unlink(path.join(resolved.attachmentsDirectory, attachmentId));
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
          }
          events.emit("task.deleted", { task: deleted.task });
          return sendEmpty(response, 204);
        }
        if (action === "move" && request.method === "POST") {
          const move = resolveInputThreadBinding(parseMove(await readJson(request)));
          const current = database.getTask(id);
          if (!current) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          if (current.source === "jira") {
            if (current.version !== move.version) {
              throw new ApiError(409, "VERSION_CONFLICT", "Task changed since it was last read", {
                expectedVersion: move.version,
                actualVersion: current.version,
              });
            }
            if (current.archivedAt !== null) {
              throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be moved");
            }
            await jira.moveTask(current, move.status);
          }
          const actor = actorFromRequest(request);
          const task = database.moveTask(
            id,
            move.version,
            move.status,
            move.sortOrder,
            move.threadId,
            move.threadBinding,
            actor,
          );
          events.emit("task.moved", { task });
          publishTaskStatusNotification(task, current.status, actor);
          return sendJson(response, 200, { task });
        }
        if (action === "archive" && request.method === "POST") {
          const current = database.getTask(id);
          if (current?.source === "jira") {
            throw new ApiError(409, "JIRA_ARCHIVE_UNAVAILABLE", "Jira 任务由同步范围自动管理，不能手动归档");
          }
          const { version, threadId, threadBinding } = resolveInputThreadBinding(
            parseArchive(await readJson(request)),
          );
          const task = database.archiveTask(
            id,
            version,
            threadId,
            threadBinding,
            actorFromRequest(request),
          );
          events.emit("task.archived", { task });
          return sendJson(response, 200, { task });
        }
        if (action === "restore" && request.method === "POST") {
          const current = database.getTask(id);
          if (current?.source === "jira") {
            throw new ApiError(409, "JIRA_RESTORE_UNAVAILABLE", "Jira 任务由同步范围自动管理，不能手动恢复");
          }
          const { version, threadId, threadBinding } = resolveInputThreadBinding(
            parseArchive(await readJson(request)),
          );
          const task = database.restoreTask(
            id,
            version,
            threadId,
            threadBinding,
            actorFromRequest(request),
          );
          events.emit("task.restored", { task });
          return sendJson(response, 200, { task });
        }
        return methodNotAllowed(response, action ? ["POST"] : ["GET", "PATCH", "DELETE"]);
      }

      if (pathname.startsWith("/api/")) {
        throw new ApiError(404, "NOT_FOUND", "API route not found");
      }
      if (await serveStatic(request, response, pathname, resolved.staticDirectory)) return;
      throw new ApiError(404, "NOT_FOUND", "Resource not found");
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      if (error instanceof ApiError) {
        const payload = { error: { code: error.code, message: error.message } };
        if (error.details !== undefined) payload.error.details = error.details;
        sendJson(response, error.status, payload);
        return;
      }
      if (error instanceof CloudProxyError) {
        const payload = { error: { code: error.code, message: error.message } };
        if (error.details !== undefined) payload.error.details = error.details;
        sendJson(response, error.status, payload);
        return;
      }
      console.error(error);
      sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
    }
  });

  let listening = false;
  return {
    database,
    aiChat,
    server,
    options: resolved,
    async listen({ host = "127.0.0.1", port = resolvePort(), fd = null } = {}) {
      if (host !== "127.0.0.1" && host !== "0.0.0.0") {
        throw new Error("Knotline server must bind to 127.0.0.1 or 0.0.0.0");
      }
      if (fd !== null && (!Number.isInteger(fd) || fd < 3 || fd > 255)) {
        throw new Error("Knotline server listen fd must be an inherited file descriptor");
      }
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        if (fd === null) server.listen(port, host);
        else server.listen({ fd });
      });
      listening = true;
      return server.address();
    },
    async close() {
      clearInterval(scheduledTriggerTimer);
      const serverClosed = listening
        ? new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
          })
        : Promise.resolve();
      events.close();
      for (const response of aiEventResponses) response.end();
      aiEventResponses.clear();
      await aiChat.close();
      await projectSummary.close();
      await serverClosed;
      listening = false;
      database.close();
    },
  };
}
