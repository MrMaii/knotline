import { randomUUID } from "node:crypto";

import { ApiError } from "./database.mjs";
import { classifyDemand } from "./governance-service.mjs";
import { resolveRelation } from "./relation-resolver.mjs";

const NODE_WIDTH = 260;
const NODE_HEIGHT = 132;
const LAYOUT_COLUMNS = 5;
const LAYOUT_COLUMN_STEP = 360;
const LAYOUT_ROW_STEP = 250;
const LAYOUT_CLEARANCE = 24;
const DIRECT_QUEUE_LIMIT = 5;

function nodeId(entityType, entityId) {
  return `${entityType}:${entityId}`;
}

function defaultPosition(index, group) {
  if (group === "project") return { x: 40, y: 40 };
  const column = index % 4;
  const row = Math.floor(index / 4);
  const y = {
    profile: 40,
    skill: 240,
    scheduled: 240,
    demand: 240,
    workstream: 460,
    review: 680,
    change: 900,
    backlog: 240,
    approval: 240,
    artifact: 680,
    notification: 900,
    knowledge: 900,
    delivery: 1120,
    task: 1120,
    run: 460,
    agent: 1560,
  }[group] ?? 240;
  return { x: (group === "profile" ? 350 : 40) + column * 310, y: y + row * 190 };
}

function nodeDimensions(input) {
  if (input.entityType === "agent_profile") {
    return input.data.kind === "Team" ? { width: 300, height: 188 } : { width: 252, height: 180 };
  }
  if (input.entityType === "demand") {
    const classification = input.data.details?.classification;
    if (classification === "complex") return { width: 284, height: 208 };
    if (classification === "debug") return { width: 284, height: 190 };
    return { width: 268, height: 160 };
  }
  if (input.entityType === "backlog_pool") return { width: 320, height: 216 };
  if (input.entityType === "approval_pool") return { width: 326, height: 224 };
  if (input.entityType === "skill") return { width: 268, height: 158 };
  if (input.entityType === "scheduled_trigger") return { width: 292, height: 190 };
  if (input.entityType === "node_run") return { width: 276, height: 168 };
  if (input.entityType === "review_gate") return { width: 284, height: 188 };
  if (["request_artifact", "delivery"].includes(input.entityType)) return { width: 284, height: 178 };
  if (input.entityType === "notification") return { width: 292, height: 176 };
  if (["background_material", "knowledge_asset", "knowledge_proposal"].includes(input.entityType)) {
    return { width: 276, height: 168 };
  }
  return { width: NODE_WIDTH, height: NODE_HEIGHT };
}

function positionedNode(layouts, input, fallback) {
  const layout = layouts.get(`${input.entityType}:${input.entityId}`);
  const dimensions = nodeDimensions(input);
  return {
    id: nodeId(input.entityType, input.entityId),
    projectId: input.projectId,
    entityType: input.entityType,
    entityId: input.entityId,
    x: layout?.x ?? fallback.x,
    y: layout?.y ?? fallback.y,
    width: dimensions.width,
    height: dimensions.height,
    collapsed: layout?.collapsed ?? false,
    layer: layout?.layer ?? input.layer,
    zIndex: layout?.zIndex ?? input.zIndex,
    version: layout?.version ?? 0,
    data: input.data,
  };
}

function overlaps(left, right) {
  return left.x < right.x + right.width + LAYOUT_CLEARANCE
    && left.x + left.width + LAYOUT_CLEARANCE > right.x
    && left.y < right.y + right.height + LAYOUT_CLEARANCE
    && left.y + left.height + LAYOUT_CLEARANCE > right.y;
}

function packDefaultNodes(nodes) {
  const occupied = nodes.filter((node) => node.version > 0);
  return nodes.map((node, index) => {
    if (node.version > 0) return node;
    let slot = index;
    let candidate;
    do {
      candidate = {
        x: 40 + (slot % LAYOUT_COLUMNS) * LAYOUT_COLUMN_STEP,
        y: 40 + Math.floor(slot / LAYOUT_COLUMNS) * LAYOUT_ROW_STEP,
        width: node.width,
        height: node.height,
      };
      slot += 1;
    } while (occupied.some((placed) => overlaps(candidate, placed)));
    occupied.push(candidate);
    return { ...node, x: candidate.x, y: candidate.y };
  });
}

function layoutCanvasNodes(nodes, edges) {
  const positioned = new Map(nodes.filter((node) => node.version > 0).map((node) => [node.id, node]));
  const occupied = [...positioned.values()];
  const pending = new Map(nodes
    .filter((node) => node.version === 0)
    .sort((left, right) => {
      const rank = (node) => {
        if (node.entityType === "request_artifact" && ["Answer", "Work Report"].includes(node.data.kind)) return 0;
        if (["node_run", "review_gate", "change_request", "delivery"].includes(node.entityType)) return 2;
        return 1;
      };
      return rank(left) - rank(right);
    })
    .map((node) => [node.id, node]));
  const incomingEdges = new Map();
  const childSlots = new Map();

  for (const edge of edges) {
    const incoming = incomingEdges.get(edge.target) ?? [];
    incoming.push(edge);
    incomingEdges.set(edge.target, incoming);
  }

  const place = (node, anchor = null) => {
    let slot = anchor ? childSlots.get(anchor.id) ?? 0 : 0;
    let candidate;
    do {
      if (anchor) {
        const horizontalOffsets = [0, -1, 1, -2, 2];
        const column = horizontalOffsets[slot % horizontalOffsets.length];
        const row = Math.floor(slot / horizontalOffsets.length);
        candidate = {
          x: anchor.x + column * LAYOUT_COLUMN_STEP,
          y: anchor.y + anchor.height + 72 + row * LAYOUT_ROW_STEP,
          width: node.width,
          height: node.height,
        };
      } else {
        candidate = {
          x: 40 + (slot % LAYOUT_COLUMNS) * LAYOUT_COLUMN_STEP,
          y: 40 + Math.floor(slot / LAYOUT_COLUMNS) * LAYOUT_ROW_STEP,
          width: node.width,
          height: node.height,
        };
      }
      slot += 1;
    } while (occupied.some((other) => overlaps(candidate, other)));
    if (anchor) childSlots.set(anchor.id, slot);
    const placed = { ...node, x: candidate.x, y: candidate.y };
    positioned.set(node.id, placed);
    occupied.push(placed);
    pending.delete(node.id);
  };

  while (pending.size > 0) {
    let progressed = false;
    for (const node of pending.values()) {
      const parents = (incomingEdges.get(node.id) ?? [])
        .map((edge) => positioned.get(edge.source))
        .filter(Boolean);
      const parent = parents.find((candidate) => candidate.version === 0) ?? parents[0];
      if (!parent) continue;
      place(node, parent);
      progressed = true;
    }
    if (!progressed) place(pending.values().next().value);
  }

  return nodes.map((node) => positioned.get(node.id));
}

function connectionPairKey(sourceNodeId, targetNodeId) {
  return [sourceNodeId, targetNodeId].sort().join("\u0000");
}

function connectionHandlesByPair(commands) {
  const handles = new Map();
  for (const command of commands) {
    const key = connectionPairKey(command.sourceNodeId, command.targetNodeId);
    const sourceHandle = ["left", "right"].includes(command.input?.sourceHandle)
      ? command.input.sourceHandle
      : null;
    const targetHandle = ["left", "right"].includes(command.input?.targetHandle)
      ? command.input.targetHandle
      : null;
    if (!sourceHandle || !targetHandle) {
      handles.delete(key);
      continue;
    }
    handles.set(key, {
      sourceNodeId: command.sourceNodeId,
      sourceHandle,
      targetHandle,
    });
  }
  return handles;
}

function applyConnectionHandles(edge, handlesByPair) {
  const handles = handlesByPair.get(connectionPairKey(edge.source, edge.target));
  if (!handles) return edge;
  const sameDirection = edge.source === handles.sourceNodeId;
  return {
    ...edge,
    sourceHandle: sameDirection ? handles.sourceHandle : handles.targetHandle,
    targetHandle: sameDirection ? handles.targetHandle : handles.sourceHandle,
  };
}

const KNOWLEDGE_SECTION_TYPES = [
  { entityType: "decision", kind: "Decision", pattern: /\bdecisions?\b|决策/i },
  { entityType: "rule", kind: "Rule", pattern: /\brules?\b|规则/i },
  { entityType: "risk", kind: "Risk", pattern: /\brisks?\b|风险/i },
  { entityType: "open_question", kind: "Open Question", pattern: /open questions?|开放问题/i },
  { entityType: "candidate_workstream", kind: "Candidate Workstream", pattern: /candidate workstreams?|候选\s*workstreams?|候选板块/i },
];

function knowledgeItemNodes(layouts, asset, projectId) {
  const content = asset.currentVersionData?.content ?? "";
  const items = [];
  let section = null;
  for (const line of content.split(/\r?\n/)) {
    if (/^#{1,4}\s+/.test(line)) {
      section = KNOWLEDGE_SECTION_TYPES.find((candidate) => candidate.pattern.test(line)) ?? null;
      continue;
    }
    if (!section || !line.trim()) continue;
    const match = line.match(/^\s*[-*]\s+(.+)/);
    const entries = (match ? [match[1]] : line.trim().split(/\s+·\s+/)).filter(Boolean);
    for (const content of entries) {
      const index = items.filter((item) => item.entityType === section.entityType).length;
      if (index >= 12) break;
      const entityId = `${asset.id}:${section.entityType}:${index}`;
      items.push(positionedNode(layouts, {
        projectId,
        entityType: section.entityType,
        entityId,
        layer: section.entityType === "candidate_workstream" ? "work" : "knowledge",
        zIndex: index + 1,
        data: {
          title: content.replace(/\*\*/g, "").slice(0, 240),
          subtitle: `${asset.title} v${asset.currentVersion}`,
          status: ["risk", "open_question", "candidate_workstream"].includes(section.entityType) ? "open" : "recorded",
          kind: section.kind,
          entityVersion: asset.currentVersion,
          details: { assetId: asset.id, knowledgeVersion: asset.currentVersion, content },
        },
      }, defaultPosition(index + 1, "knowledge")));
    }
  }
  return items;
}

export function createGraphService(database, options = {}) {
  const runtimeProvider = options.runtimeProvider ?? (async () => []);
  const governance = options.governance ?? null;
  const orchestration = options.orchestration ?? null;
  const knowledge = options.knowledge ?? null;
  const messageAgent = options.messageAgent ?? null;

  async function buildProjectMap(projectId) {
    const project = database.getProject(projectId);
    if (!project) return null;
    const layouts = new Map(database.listGraphNodes(projectId).map((layout) => (
      [`${layout.entityType}:${layout.entityId}`, layout]
    )));
    const runtimeSessions = await runtimeProvider();
    const governed = governance?.projectState(projectId) ?? {
      agents: [],
      demands: [],
      workstreams: [],
      reviewGates: [],
      changeRequests: [],
      teamMemberships: [],
      backlogPools: [],
      approvalPools: [],
      requestArtifacts: [],
    };
    const orchestrated = orchestration?.projectState(projectId) ?? { bindings: [], nodeRuns: [] };
    const known = knowledge?.projectState(projectId) ?? {
      assets: [],
      bindings: [],
      proposals: [],
      deliveries: [],
    };
    const mapItems = database.listMapItems(projectId);
    const skillNodes = database.listSkillNodes(projectId);
    const scheduledTriggers = database.listScheduledTriggers(projectId);
    const mapNotifications = database.listNotifications(projectId).filter((notification) => (
      !notification.read && notification.context?.showOnMap === true
    ));
    const storedGraphEdges = database.listGraphEdges(projectId);
    const storedConnectionHandles = connectionHandlesByPair(database.listGraphCommands(projectId));
    const knowledgeItems = known.assets.flatMap((asset) => knowledgeItemNodes(layouts, asset, projectId));
    const boundSessionIds = new Set();
    for (const binding of orchestrated.bindings) {
      if (binding.sessionId) boundSessionIds.add(binding.sessionId);
    }
    const sessions = runtimeSessions.filter((session) => boundSessionIds.has(session.id));
    const teamMembersByTeam = new Map();
    for (const membership of governed.teamMemberships) {
      const member = governed.agents.find((agent) => agent.id === membership.memberAgentId);
      if (!member) continue;
      const members = teamMembersByTeam.get(membership.teamAgentId) ?? [];
      members.push(member);
      teamMembersByTeam.set(membership.teamAgentId, members);
    }
    const nodes = packDefaultNodes([
      ...governed.agents.map((agent, index) => {
        const teamMembers = (teamMembersByTeam.get(agent.id) ?? []).map((member) => ({
          ...member,
          runtimeBinding: orchestrated.bindings.find((binding) => binding.agentProfileId === member.id) ?? null,
        }));
        const runtimeBinding = orchestrated.bindings.find((binding) => binding.agentProfileId === agent.id) ?? null;
        const runtimeSession = runtimeBinding?.sessionId
          ? sessions.find((session) => session.id === runtimeBinding.sessionId) ?? null
          : null;
        const agentNodeId = nodeId("agent_profile", agent.id);
        const directDemands = storedGraphEdges
          .filter((edge) => (
            edge.targetNodeId === agentNodeId
            && edge.relationType === "direct_for"
            && edge.state === "active"
          ))
          .map((edge) => governed.demands.find((demand) => nodeId("demand", demand.id) === edge.sourceNodeId))
          .filter(Boolean);
        const activeDemandIds = new Set(orchestrated.nodeRuns
          .filter((run) => (
            run.agentProfileId === agent.id
            && ["queued", "running", "waiting_input", "changes_requested"].includes(run.status)
          ))
          .map((run) => governed.workstreams.find((workstream) => workstream.id === run.workstreamId)?.demandId)
          .filter(Boolean));
        const directQueue = directDemands.filter((demand) => (
          demand.status === "new" || activeDemandIds.has(demand.id)
        ));
        return positionedNode(layouts, {
          projectId,
          entityType: "agent_profile",
          entityId: agent.id,
          layer: "organization",
          zIndex: index + 1,
          data: {
            title: agent.name,
            subtitle: teamMembers.length > 0
              ? teamMembers.map((member) => member.name).join(" + ")
              : agent.skillId ?? "DSH Conversation",
            status: agent.status,
            kind: teamMembers.length > 0 ? "Team" : "Agent",
            entityVersion: agent.version,
            role: agent.role,
            skillId: agent.skillId,
            live: runtimeSession?.live ?? false,
            details: {
              ...agent,
              runtimeBinding,
              teamMembers,
              directQueueCount: directQueue.length,
              directQueueTitles: directQueue.map((demand) => demand.title),
              knowledgeBindings: known.bindings.filter((binding) => binding.agentProfileId === agent.id),
              contextDocuments: known.bindings
                .filter((binding) => binding.agentProfileId === agent.id)
                .map((binding) => {
                  const asset = known.assets.find((candidate) => candidate.id === binding.assetId);
                  return asset?.kind === "context_document"
                    ? {
                        id: asset.id,
                        title: asset.title,
                        boundVersion: binding.boundVersion,
                        status: binding.status,
                        content: asset.currentVersionData?.content ?? "",
                      }
                    : null;
                })
                .filter(Boolean),
            },
          },
        }, defaultPosition(index, "profile"));
      }),
      ...skillNodes.map((skillNode, index) => positionedNode(layouts, {
        projectId,
        entityType: "skill",
        entityId: skillNode.id,
        layer: "organization",
        zIndex: governed.agents.length + index + 1,
        data: {
          title: skillNode.label,
          subtitle: skillNode.description || skillNode.skillId,
          status: "installed",
          kind: "Skill",
          entityVersion: skillNode.version,
          skillId: skillNode.skillId,
          details: skillNode,
        },
      }, defaultPosition(index, "skill"))),
      ...scheduledTriggers.map((trigger, index) => {
        const latestRun = orchestrated.nodeRuns
          .filter((run) => (
            run.instruction.startsWith(`${trigger.prompt}\n`)
            && run.instruction.includes("Scheduled trigger fired at:")
          ))
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
        return positionedNode(layouts, {
          projectId,
          entityType: "scheduled_trigger",
          entityId: trigger.id,
          layer: "work",
          zIndex: skillNodes.length + index + 1,
          data: {
            title: trigger.prompt.split(/\r?\n/, 1)[0].slice(0, 120),
            subtitle: trigger.prompt,
            status: trigger.enabled ? "enabled" : "paused",
            kind: "Scheduled Trigger",
            entityVersion: trigger.version,
            details: {
              ...trigger,
              targetCount: storedGraphEdges.filter((edge) => (
                edge.sourceNodeId === nodeId("scheduled_trigger", trigger.id)
                && edge.relationType === "scheduled_for"
                && edge.state === "active"
              )).length,
              lastRunStatus: latestRun?.status ?? null,
              lastRunSummary: latestRun?.result?.summary ?? null,
              lastRunEvidence: latestRun?.result?.evidence ?? null,
              lastRunAt: latestRun?.completedAt ?? latestRun?.startedAt ?? null,
            },
          },
        }, defaultPosition(index, "scheduled"));
      }),
      ...known.assets.map((asset, index) => positionedNode(layouts, {
        projectId,
        entityType: "knowledge_asset",
        entityId: asset.id,
        layer: "knowledge",
        zIndex: index + 1,
        data: {
          title: asset.title,
          subtitle: asset.kind === "context_document"
            ? asset.currentVersionData?.content ?? "Reusable Agent context"
            : `Version ${asset.currentVersion}`,
          status: "current",
          kind: asset.kind === "context_document" ? "Context Document" : "Knowledge Asset",
          entityVersion: asset.version,
          details: {
            ...asset,
            content: asset.currentVersionData?.content ?? "",
            bindings: known.bindings.filter((binding) => binding.assetId === asset.id),
          },
        },
      }, defaultPosition(index, "knowledge"))),
      ...knowledgeItems,
      ...governed.demands.map((demand, index) => positionedNode(layouts, {
        projectId,
        entityType: "demand",
        entityId: demand.id,
        layer: "work",
        zIndex: governed.agents.length + index + 1,
        data: {
          title: demand.title,
          subtitle: demand.description || "Request",
          status: demand.status,
          kind: demand.classification === "unclassified" ? "Request" : `Request · ${demand.classification}`,
          entityVersion: demand.version,
          details: { classification: demand.classification, acceptanceCriteria: demand.acceptanceCriteria },
        },
      }, defaultPosition(index, "demand"))),
      ...governed.backlogPools.map((pool, index) => {
        const poolNodeId = nodeId("backlog_pool", pool.id);
        const workers = storedGraphEdges
          .filter((edge) => edge.targetNodeId === poolNodeId && edge.relationType === "executor_for" && edge.state === "active")
          .map((edge) => governed.agents.find((agent) => nodeId("agent_profile", agent.id) === edge.sourceNodeId))
          .filter(Boolean);
        const queuedRequests = storedGraphEdges
          .filter((edge) => edge.targetNodeId === poolNodeId && edge.relationType === "queued_in" && edge.state === "active")
          .map((edge) => governed.demands.find((demand) => nodeId("demand", demand.id) === edge.sourceNodeId))
          .filter(Boolean);
        const waitingRequests = queuedRequests.filter((demand) => demand.status === "new");
        const processedRequests = queuedRequests.filter((demand) => demand.status !== "new");
        return positionedNode(layouts, {
          projectId,
          entityType: "backlog_pool",
          entityId: pool.id,
          layer: "work",
          zIndex: governed.agents.length + governed.demands.length + index + 1,
          data: {
            title: pool.title,
            subtitle: `${waitingRequests.length} queued · ${processedRequests.length} processed · ${workers.length} Agents`,
            status: pool.status,
            kind: "Backlog",
            entityVersion: pool.version,
            details: {
              ...pool,
              workers: workers.map((agent) => agent.name),
              queuedRequests: waitingRequests.map((demand) => demand.title),
              processedRequests: processedRequests.map((demand) => demand.title),
            },
          },
        }, defaultPosition(index, "backlog"));
      }),
      ...governed.approvalPools.map((pool, index) => {
        const poolNodeId = nodeId("approval_pool", pool.id);
        const readerEdges = storedGraphEdges.filter((edge) => (
          edge.targetNodeId === poolNodeId
          && edge.relationType === "approval_reads"
          && edge.state === "active"
        ));
        const writerEdges = storedGraphEdges.filter((edge) => (
          edge.targetNodeId === poolNodeId
          && edge.relationType === "approval_writes"
          && edge.state === "active"
        ));
        const approvalItems = storedGraphEdges
          .filter((edge) => edge.targetNodeId === poolNodeId && edge.relationType === "stored_for_approval")
          .map((edge) => ({
            edge,
            artifact: edge.sourceNodeId.startsWith("request_artifact:")
              ? governed.requestArtifacts.find((artifact) => nodeId("request_artifact", artifact.id) === edge.sourceNodeId)
              : null,
          }))
          .filter((item) => item.artifact);
        const pendingApprovals = approvalItems.filter((item) => item.edge.state === "active");
        const routedApprovals = approvalItems.filter((item) => item.edge.state !== "active");
        const agentName = (edge) => governed.agents.find((agent) => (
          nodeId("agent_profile", agent.id) === edge.sourceNodeId
        ))?.name;
        return positionedNode(layouts, {
          projectId,
          entityType: "approval_pool",
          entityId: pool.id,
          layer: "governance",
          zIndex: governed.agents.length + governed.demands.length + governed.backlogPools.length + index + 1,
          data: {
            title: pool.title,
            subtitle: `${pendingApprovals.length} pending · ${routedApprovals.length} routed · ${readerEdges.length} readers · ${writerEdges.length} writers`,
            status: pool.status,
            kind: "Approval Pool",
            entityVersion: pool.version,
            details: {
              ...pool,
              readers: readerEdges.map(agentName).filter(Boolean),
              writers: writerEdges.map(agentName).filter(Boolean),
              pendingApprovals: pendingApprovals.map((item) => item.artifact.title),
              routedApprovals: routedApprovals.map((item) => item.artifact.title),
            },
          },
        }, defaultPosition(index, "approval"));
      }),
      ...orchestrated.nodeRuns.map((run, index) => {
        const agent = governed.agents.find((candidate) => candidate.id === run.agentProfileId);
        const workstream = run.workstreamId
          ? governed.workstreams.find((candidate) => candidate.id === run.workstreamId)
          : null;
        return positionedNode(layouts, {
          projectId,
          entityType: "node_run",
          entityId: run.id,
          layer: "runtime",
          zIndex: index + 1,
          data: {
            title: workstream?.title ?? run.instruction.split(/\r?\n/, 1)[0],
            subtitle: `${agent?.name ?? "Agent"} · ${run.status.replaceAll("_", " ")}`,
            status: run.status,
            kind: "Task Bench",
            entityVersion: run.version,
            live: ["queued", "running", "waiting_input", "changes_requested"].includes(run.status),
            details: { ...run, agentName: agent?.name ?? null, workstreamTitle: workstream?.title ?? null },
          },
        }, defaultPosition(index, "run"));
      }),
      ...governed.requestArtifacts.filter((artifact) => artifact.status !== "generating").map((artifact, index) => {
        const approvalEdge = storedGraphEdges.find((edge) => (
          edge.sourceNodeId === nodeId("request_artifact", artifact.id)
          && edge.relationType === "stored_for_approval"
          && edge.state === "active"
        ));
        const producerIsTeam = teamMembersByTeam.has(artifact.agentProfileId);
        return positionedNode(layouts, {
          projectId,
          entityType: "request_artifact",
          entityId: artifact.id,
          layer: "work",
          zIndex: index + 1,
          data: {
            title: artifact.title,
            subtitle: artifact.content || "Agent is generating this document",
            status: approvalEdge ? "in_approval" : artifact.status,
            kind: artifact.kind === "answer"
              ? "Answer"
              : artifact.kind === "review_feedback"
                ? "Review Feedback"
                : approvalEdge
                  ? "Approval Proposal"
                  : producerIsTeam ? "Feature Module Report" : "Work Report",
            entityVersion: artifact.version,
            details: { ...artifact, approvalPoolNodeId: approvalEdge?.targetNodeId ?? null },
          },
        }, defaultPosition(index, "artifact"));
      }),
      ...mapItems.map((item, index) => positionedNode(layouts, {
        projectId,
        entityType: item.kind,
        entityId: item.id,
        layer: "work",
        zIndex: index + 1,
        data: {
          title: item.title,
          subtitle: item.content,
          status: item.status,
          kind: item.kind === "background_material"
            ? "Background Material"
            : `${item.kind[0].toUpperCase()}${item.kind.slice(1)}`,
          entityVersion: item.version,
          details: item,
        },
      }, defaultPosition(index, "demand"))),
      ...governed.reviewGates.map((gate, index) => {
        const workstream = governed.workstreams.find((candidate) => candidate.id === gate.workstreamId);
        const executionRun = gate.nodeRunId
          ? orchestrated.nodeRuns.find((candidate) => candidate.id === gate.nodeRunId)
          : null;
        const artifact = executionRun?.result ?? null;
        return positionedNode(layouts, {
          projectId,
          entityType: "review_gate",
          entityId: gate.id,
          layer: "governance",
          zIndex: governed.agents.length + governed.demands.length + governed.workstreams.length + index + 1,
          data: {
            title: gate.purpose === "execution"
              ? `${workstream?.title ?? "Delivery"} · Pre-review Artifact`
              : "Workstream Review",
            subtitle: gate.purpose === "execution"
              ? String(artifact?.summary ?? (gate.reviewerAgentId ? "Agent reviewing" : "Drag to another Agent"))
              : gate.reviewerAgentId ? "Reviewer assigned" : "Reviewer required",
            status: gate.status,
            kind: gate.purpose === "execution" ? "Pre-review Artifact" : "Review Gate",
            entityVersion: gate.version,
            details: { ...gate, artifact },
          },
        }, defaultPosition(index, "review"));
      }),
      ...governed.changeRequests.map((change, index) => positionedNode(layouts, {
        projectId,
        entityType: "change_request",
        entityId: change.id,
        layer: "governance",
        zIndex: governed.agents.length + governed.demands.length + governed.workstreams.length
          + governed.reviewGates.length + index + 1,
        data: {
          title: change.title,
          subtitle: change.description || "Approved scope remains unchanged",
          status: change.status,
          kind: "Change Request",
          entityVersion: change.version,
          details: change,
        },
      }, defaultPosition(index, "change"))),
      ...known.deliveries.map((delivery, index) => positionedNode(layouts, {
        projectId,
        entityType: "delivery",
        entityId: delivery.id,
        layer: "work",
        zIndex: index + 1,
        data: {
          title: "Approved Delivery",
          subtitle: delivery.summary,
          status: "approved",
          kind: "Delivery",
          entityVersion: null,
          details: delivery,
        },
      }, defaultPosition(index, "delivery"))),
      ...known.proposals.map((proposal, index) => positionedNode(layouts, {
        projectId,
        entityType: "knowledge_proposal",
        entityId: proposal.id,
        layer: "governance",
        zIndex: index + 1,
        data: {
          title: proposal.title,
          subtitle: proposal.content,
          status: proposal.status,
          kind: "Knowledge Update Proposal",
          entityVersion: proposal.version,
          details: proposal,
        },
        }, defaultPosition(index, "review"))),
      ...mapNotifications.map((notification, index) => positionedNode(layouts, {
        projectId,
        entityType: "notification",
        entityId: notification.id,
        layer: "governance",
        zIndex: index + 1,
        data: {
          title: notification.title,
          subtitle: notification.body,
          status: "unread",
          kind: "Notification",
          entityVersion: null,
          details: { ...notification, content: notification.body },
        },
      }, defaultPosition(index, "notification"))),
    ]);
    const teamEdges = governed.teamMemberships.map((membership) => ({
      id: `team-member:${membership.memberAgentId}:${membership.teamAgentId}`,
      source: nodeId("agent_profile", membership.memberAgentId),
      target: nodeId("agent_profile", membership.teamAgentId),
      relationType: "member_of",
      label: "Member",
      projected: true,
    })).concat(mapItems.flatMap((item) => {
      if (!item.createdBy.startsWith("team:")) return [];
      const teamAgentId = item.createdBy.slice("team:".length);
      return [{
        id: `team-document:${teamAgentId}:${item.id}`,
        source: nodeId("agent_profile", teamAgentId),
        target: nodeId(item.kind, item.id),
        relationType: "produces",
        label: item.title.includes("Plan") ? "Plan" : "Protocol",
        projected: true,
      }];
    }));
    const skillEdges = governed.agents.flatMap((agent) => {
      if (!agent.skillId) return [];
      const skillNode = skillNodes.find((candidate) => candidate.skillId === agent.skillId);
      if (!skillNode) return [];
      return [{
        id: `skill-binding:${skillNode.id}:${agent.id}`,
        source: nodeId("skill", skillNode.id),
        target: nodeId("agent_profile", agent.id),
        relationType: "skill_for",
        label: "Skill",
        projected: true,
      }];
    });
    const workstreamEdges = governed.workstreams.flatMap((workstream) => (
      workstream.demandId && workstream.leaderAgentId ? [{
        id: `demand-agent:${workstream.demandId}:${workstream.leaderAgentId}`,
        source: nodeId("demand", workstream.demandId),
        target: nodeId("agent_profile", workstream.leaderAgentId),
        relationType: "assigned_to",
        label: "Assigned",
        projected: true,
      }] : []
    ));
    const taskBenchEdges = orchestrated.nodeRuns.flatMap((run) => {
      const workstream = run.workstreamId
        ? governed.workstreams.find((candidate) => candidate.id === run.workstreamId)
        : null;
      return [
        {
          id: `agent-run:${run.agentProfileId}:${run.id}`,
          source: nodeId("agent_profile", run.agentProfileId),
          target: nodeId("node_run", run.id),
          relationType: "working_on",
          label: "Runs",
          projected: true,
        },
        ...(workstream?.demandId ? [{
          id: `demand-run:${workstream.demandId}:${run.id}`,
          source: nodeId("demand", workstream.demandId),
          target: nodeId("node_run", run.id),
          relationType: "runs_as",
          label: "Task Bench",
          projected: true,
        }] : []),
      ];
    });
    const requestArtifactEdges = governed.requestArtifacts.flatMap((artifact) => {
      const plan = artifact.kind === "review_feedback"
        ? governed.requestArtifacts.find((candidate) => (
            candidate.nodeRunId === artifact.nodeRunId && candidate.kind === "plan"
          ))
        : null;
      return [{
        id: `demand-artifact:${artifact.demandId}:${artifact.id}`,
        source: nodeId("demand", artifact.demandId),
        target: nodeId("request_artifact", artifact.id),
        relationType: "produces",
        label: artifact.kind === "answer" ? "Answers" : artifact.kind === "plan" ? "Plans" : "Reviews",
        projected: true,
      },
      {
        id: `agent-artifact:${artifact.agentProfileId}:${artifact.id}`,
        source: nodeId("agent_profile", artifact.agentProfileId),
        target: nodeId("request_artifact", artifact.id),
        relationType: "produces",
        label: "Produces",
        projected: true,
      },
      ...(plan ? [{
        id: `feedback-plan:${artifact.id}:${plan.id}`,
        source: nodeId("request_artifact", artifact.id),
        target: nodeId("request_artifact", plan.id),
        relationType: "followed_by",
        label: "Then plan",
        projected: true,
      }] : []),
      ];
    });
    const reviewEdges = governed.reviewGates.flatMap((gate) => {
      const executionRun = gate.nodeRunId
        ? orchestrated.nodeRuns.find((candidate) => candidate.id === gate.nodeRunId)
        : null;
      return [
        ...(executionRun ? [{
          id: `agent-artifact:${executionRun.agentProfileId}:${gate.id}`,
          source: nodeId("agent_profile", executionRun.agentProfileId),
          target: nodeId("review_gate", gate.id),
          relationType: "produces",
          label: "Produces",
          projected: true,
        }] : []),
        ...(gate.reviewerAgentId ? [{
          id: `artifact-reviewer:${gate.id}:${gate.reviewerAgentId}`,
          source: nodeId("review_gate", gate.id),
          target: nodeId("agent_profile", gate.reviewerAgentId),
          relationType: "reviewed_by",
          label: "Reviewing",
          projected: true,
        }] : []),
      ];
    });
    const changeEdges = governed.changeRequests.map((change) => ({
      id: `demand-change:${change.demandId}:${change.id}`,
      source: nodeId("demand", change.demandId),
      target: nodeId("change_request", change.id),
      relationType: "requests_change",
      label: "Change",
      projected: true,
    }));
    const deliveryEdges = known.deliveries.flatMap((delivery) => {
      const gate = governed.reviewGates.find((candidate) => candidate.nodeRunId === delivery.nodeRunId);
      return gate ? [{
        id: `artifact-delivery:${gate.id}:${delivery.id}`,
        source: nodeId("review_gate", gate.id),
        target: nodeId("delivery", delivery.id),
        relationType: "approved_as",
        label: "Approved",
        projected: true,
      }] : [];
    });
    const knowledgeEdges = known.bindings.map((binding) => ({
      id: `knowledge-binding:${binding.assetId}:${binding.agentProfileId}`,
      source: nodeId("knowledge_asset", binding.assetId),
      target: nodeId("agent_profile", binding.agentProfileId),
      relationType: "knowledge_binding",
      label: binding.status === "stale" ? `Stale v${binding.boundVersion}` : `v${binding.boundVersion}`,
      projected: true,
    })).concat(knowledgeItems.map((item) => ({
      id: `knowledge-item:${item.entityId}`,
      source: nodeId("knowledge_asset", item.data.details.assetId),
      target: item.id,
      relationType: "contains",
      label: item.data.kind,
      projected: true,
    }))).concat(known.proposals.flatMap((proposal) => [
      ...(proposal.deliveryId ? [{
        id: `delivery-proposal:${proposal.deliveryId}:${proposal.id}`,
        source: nodeId("delivery", proposal.deliveryId),
        target: nodeId("knowledge_proposal", proposal.id),
        relationType: "proposes_update",
        label: "Knowledge update",
        projected: true,
      }] : []),
      {
        id: `proposal-knowledge:${proposal.id}:${proposal.assetId}`,
        source: nodeId("knowledge_proposal", proposal.id),
        target: nodeId("knowledge_asset", proposal.assetId),
        relationType: "updates",
        label: "Updates",
        projected: true,
      },
    ]));
    const notificationEdges = mapNotifications.flatMap((notification) => (
      notification.graphNodeId ? [{
        id: `notification-source:${notification.id}`,
        source: notification.graphNodeId,
        target: nodeId("notification", notification.id),
        relationType: "notifies",
        label: "Completed",
        projected: true,
      }] : []
    ));
    const visibleNodeIds = new Set(nodes.map((node) => node.id));
    const projectedEdges = [
      ...teamEdges,
      ...skillEdges,
      ...workstreamEdges,
      ...taskBenchEdges,
      ...requestArtifactEdges,
      ...reviewEdges,
      ...changeEdges,
      ...deliveryEdges,
      ...knowledgeEdges,
      ...notificationEdges,
    ].filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
    const storedEdges = storedGraphEdges
      .filter((edge) => edge.state === "active" && visibleNodeIds.has(edge.sourceNodeId) && visibleNodeIds.has(edge.targetNodeId))
      .map((edge) => ({
        id: edge.id,
        source: edge.sourceNodeId,
        target: edge.targetNodeId,
        relationType: edge.relationType,
        label: edge.metadata.label ?? edge.relationType.replaceAll("_", " "),
        projected: false,
        version: edge.version,
      }));
    return {
      project,
      nodes,
      edges: [
        ...projectedEdges,
        ...storedEdges,
      ].map((edge) => applyConnectionHandles(edge, storedConnectionHandles)),
      generatedAt: new Date().toISOString(),
    };
  }

  function reconcileCanvasNodes(projectId, map) {
    const canvases = database.listProjectCanvases(projectId);
    const memberships = database.listCanvasNodes(projectId);
    const membershipsByNode = new Map();
    for (const membership of memberships) {
      if (!membership.visible) continue;
      const canvasIds = membershipsByNode.get(membership.nodeId) ?? new Set();
      canvasIds.add(membership.canvasId);
      membershipsByNode.set(membership.nodeId, canvasIds);
    }
    const missingNodeIds = new Set(
      map.nodes.map((node) => node.id).filter((id) => !membershipsByNode.has(id)),
    );
    let progressed = true;
    while (progressed && missingNodeIds.size > 0) {
      progressed = false;
      for (const nodeIdValue of [...missingNodeIds]) {
        const connectedCanvasIds = new Set();
        for (const edge of map.edges) {
          const neighborId = edge.source === nodeIdValue
            ? edge.target
            : edge.target === nodeIdValue ? edge.source : null;
          if (!neighborId) continue;
          for (const canvasId of membershipsByNode.get(neighborId) ?? []) connectedCanvasIds.add(canvasId);
        }
        if (connectedCanvasIds.size === 0) continue;
        for (const canvasId of connectedCanvasIds) database.assignCanvasNode(projectId, canvasId, nodeIdValue);
        membershipsByNode.set(nodeIdValue, connectedCanvasIds);
        missingNodeIds.delete(nodeIdValue);
        progressed = true;
      }
    }
    const defaultCanvasId = canvases[0].id;
    for (const nodeIdValue of missingNodeIds) {
      database.assignCanvasNode(projectId, defaultCanvasId, nodeIdValue);
    }
    return canvases;
  }

  async function getProjectMap(projectId, canvasId = null) {
    const map = await buildProjectMap(projectId);
    if (!map) return null;
    const canvases = reconcileCanvasNodes(projectId, map);
    const canvas = canvasId === null
      ? canvases[0]
      : canvases.find((candidate) => candidate.id === canvasId);
    if (!canvas) {
      throw new ApiError(404, "CANVAS_NOT_FOUND", `Canvas '${canvasId}' does not exist in project '${projectId}'`);
    }
    const visibleNodeIds = new Set(database.listCanvasNodes(projectId)
      .filter((membership) => membership.canvasId === canvas.id && membership.visible)
      .map((membership) => membership.nodeId));
    const visibleNodes = map.nodes.filter((node) => visibleNodeIds.has(node.id));
    const visibleEdges = map.edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
    return {
      ...map,
      canvas,
      nodes: layoutCanvasNodes(visibleNodes, visibleEdges),
      edges: visibleEdges,
    };
  }

  async function assignNodeToCanvas(projectId, canvasId, nodeIdValue) {
    const map = await buildProjectMap(projectId);
    if (!map) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    if (!map.nodes.some((node) => node.id === nodeIdValue)) {
      throw new ApiError(404, "GRAPH_NODE_NOT_FOUND", `Graph node '${nodeIdValue}' does not exist`);
    }
    return database.moveCanvasNode(projectId, canvasId, nodeIdValue);
  }

  async function saveNodeLayout(nodeIdValue, input) {
    const map = await buildProjectMap(input.projectId);
    const node = map?.nodes.find((candidate) => candidate.id === nodeIdValue);
    if (!node) return null;
    return database.saveGraphNodeLayout({
      id: node.id,
      projectId: node.projectId,
      entityType: node.entityType,
      entityId: node.entityId,
      layer: node.layer,
      zIndex: node.zIndex,
      version: input.version,
      x: input.x,
      y: input.y,
      width: input.width ?? node.width,
      height: input.height ?? node.height,
    });
  }

  async function resolveAction(projectId, sourceNodeId, targetNodeId) {
    const map = await buildProjectMap(projectId);
    if (!map) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    const source = map.nodes.find((node) => node.id === sourceNodeId);
    const target = map.nodes.find((node) => node.id === targetNodeId);
    if (!source || !target) {
      throw new ApiError(404, "GRAPH_NODE_NOT_FOUND", "The dragged graph node no longer exists");
    }
    return resolveRelation(source, target);
  }

  function ensureStoredEdge(projectId, sourceNodeId, targetNodeId, relationType, label, actor, metadata = {}) {
    const existing = database.listGraphEdges(projectId).find((edge) => (
      edge.sourceNodeId === sourceNodeId
      && edge.targetNodeId === targetNodeId
      && edge.relationType === relationType
    ));
    const nextMetadata = { ...existing?.metadata, label, ...metadata };
    if (existing) {
      return database.updateGraphEdge(existing.id, { state: "active", metadata: nextMetadata });
    }
    return database.createGraphEdge({
      id: randomUUID(),
      projectId,
      sourceNodeId,
      targetNodeId,
      relationType,
      metadata: nextMetadata,
      createdBy: `${actor.type}:${actor.id}`,
    });
  }

  function activeGraphEdges(projectId) {
    return database.listGraphEdges(projectId).filter((edge) => edge.state === "active");
  }

  function pendingDirectDemandEdges(projectId, agentProfileId) {
    const agentNodeId = nodeId("agent_profile", agentProfileId);
    return activeGraphEdges(projectId)
      .filter((edge) => edge.targetNodeId === agentNodeId && edge.relationType === "direct_for")
      .map((edge) => ({
        edge,
        demand: edge.sourceNodeId.startsWith("demand:")
          ? database.getDemand(edge.sourceNodeId.slice("demand:".length))
          : null,
      }))
      .filter((item) => item.demand?.status === "new");
  }

  function releaseDemandFromBacklogs(projectId, demandNodeId) {
    return activeGraphEdges(projectId)
      .filter((edge) => edge.sourceNodeId === demandNodeId && edge.relationType === "queued_in")
      .map((edge) => database.updateGraphEdge(edge.id, { state: "released" }));
  }

  function cacheDirectOverflow(projectId, agentProfileId, backlogEdge, actor) {
    if (backlogEdge?.metadata?.mode !== "cache") return [];
    const overflow = pendingDirectDemandEdges(projectId, agentProfileId).slice(DIRECT_QUEUE_LIMIT);
    return overflow.map(({ edge, demand }) => {
      const queueEdge = ensureStoredEdge(
        projectId,
        nodeId("demand", demand.id),
        backlogEdge.targetNodeId,
        "queued_in",
        "Cached",
        actor,
        { cachedByAgentId: agentProfileId },
      );
      return {
        directEdge: database.updateGraphEdge(edge.id, { state: "cached" }),
        queueEdge,
      };
    });
  }

  function executeDemand(demandId, requestedAgentId, actor, allowDelegation = true) {
    const demand = database.getDemand(demandId);
    if (!demand) throw new ApiError(404, "DEMAND_NOT_FOUND", "Request no longer exists");
    if (classifyDemand(demand) === "context") {
      const agent = database.getAgentProfile(requestedAgentId);
      if (!agent || agent.projectId !== demand.projectId) {
        throw new ApiError(404, "AGENT_NOT_FOUND", "Agent no longer exists");
      }
      const classifiedDemand = database.setDemandClassification(demand.id, "context");
      const assigned = orchestration.createStandaloneRun(
        agent.id,
        `Understand project context: ${demand.title}`,
        [
          `<knotline_context_request demand_id="${demand.id}">`,
          `Request: ${demand.title}`,
          demand.description || demand.title,
          "Call knotline_read_project_context for grounded project files, documents, tasks, and sessions.",
          "Do not create, edit, or delete workspace files. This is a read-only context acquisition run.",
          "Produce a reusable public context document containing concrete project facts, structure, current state, risks, and useful continuation context.",
          "Finish by calling knotline_submit_delivery. Put a concise overview in summary and the complete public memory in evidence.",
          "</knotline_context_request>",
        ].join("\n"),
      );
      return { kind: "context_assignment", demand: classifiedDemand, agent, ...assigned };
    }
    const routed = governance.routeDemandToAgent(
      demandId,
      requestedAgentId,
      allowDelegation ? backlogWorkerAvailable : () => false,
    );
    const planningOnly = activeGraphEdges(demand.projectId).some((edge) => (
      edge.sourceNodeId === nodeId("agent_profile", routed.agent.id)
      && edge.relationType === "approval_writes"
    ));
    const assigned = orchestration.assignAgent(routed.agent.id, routed.workstream.id, { planningOnly });
    const artifacts = database.createRequestArtifacts({
      projectId: routed.demand.projectId,
      demandId: routed.demand.id,
      demandTitle: routed.demand.title,
      agentProfileId: routed.agent.id,
      nodeRunId: assigned.nodeRun.id,
      classification: routed.classification,
    });
    const delegationEdge = routed.delegated
      ? ensureStoredEdge(
          routed.demand.projectId,
          nodeId("agent_profile", routed.requestedAgent.id),
          nodeId("agent_profile", routed.agent.id),
          "delegated_to",
          `Auto-routed ${routed.classification}`,
          actor,
        )
      : null;
    return {
      kind: "demand_assignment",
      ...routed,
      ...assigned,
      artifacts,
      delegationEdge,
    };
  }

  function backlogWorkerAvailable(agentProfileId) {
    const binding = orchestration?.getBindingByProfile(agentProfileId);
    const currentRun = binding?.currentNodeRunId
      ? orchestration?.getNodeRun(binding.currentNodeRunId)
      : null;
    return !currentRun || !["queued", "running", "waiting_input", "changes_requested"].includes(currentRun.status);
  }

  function scheduleBacklog(projectId, agentProfileId, actor) {
    if (!backlogWorkerAvailable(agentProfileId)) return null;
    const workerNodeId = nodeId("agent_profile", agentProfileId);
    const edges = activeGraphEdges(projectId);
    const workerEdges = edges
      .filter((edge) => edge.sourceNodeId === workerNodeId && edge.relationType === "executor_for")
      .map((edge) => edge.metadata.mode === "cache"
        ? database.updateGraphEdge(edge.id, {
            metadata: { ...edge.metadata, mode: "pull", label: "Pull mode" },
          })
        : edge);
    const backlogIds = workerEdges.map((edge) => edge.targetNodeId);
    const queuedDemands = edges
      .filter((edge) => backlogIds.includes(edge.targetNodeId) && edge.relationType === "queued_in")
      .map((edge) => edge.sourceNodeId.startsWith("demand:")
        ? database.getDemand(edge.sourceNodeId.slice("demand:".length))
        : null)
      .filter((demand) => demand?.status === "new");
    return queuedDemands[0]
      ? executeDemand(queuedDemands[0].id, agentProfileId, actor, queuedDemands.length === 1)
      : null;
  }

  function scheduleApprovalPool(projectId, agentProfileId, actor) {
    if (!backlogWorkerAvailable(agentProfileId)) return null;
    const agentNodeId = nodeId("agent_profile", agentProfileId);
    const edges = activeGraphEdges(projectId);
    const approvalPoolIds = edges
      .filter((edge) => edge.sourceNodeId === agentNodeId && edge.relationType === "approval_reads")
      .map((edge) => edge.targetNodeId);
    const approvalEdge = edges.find((edge) => (
      approvalPoolIds.includes(edge.targetNodeId)
      && edge.relationType === "stored_for_approval"
    ));
    if (!approvalEdge?.sourceNodeId.startsWith("request_artifact:")) return null;
    const artifact = database.getRequestArtifact(approvalEdge.sourceNodeId.slice("request_artifact:".length));
    if (!artifact) return null;
    const approvalPool = database.getApprovalPool(approvalEdge.targetNodeId.slice("approval_pool:".length));
    const processingEdge = database.updateGraphEdge(approvalEdge.id, {
      state: "processing",
      metadata: { ...approvalEdge.metadata, label: "Executing approved proposal", readerAgentId: agentProfileId },
    });
    const assigned = orchestration.createStandaloneRun(
      agentProfileId,
      `Execute approved proposal: ${artifact.title}`,
      [
        `<knotline_approval_execution artifact_id="${artifact.id}" pool_id="${approvalPool.id}">`,
        "This proposal has entered the Approval Pool and is approved for autonomous execution.",
        `Proposal: ${artifact.title}`,
        artifact.content,
        "Execute it one item at a time in the current DeepSeek workspace.",
        "Use Knotline node tools for lifecycle changes and submit the node with concrete evidence when finished.",
        "</knotline_approval_execution>",
      ].join("\n\n"),
    );
    return {
      kind: "approval_assignment",
      ...assigned,
      approvalPool,
      approvalArtifact: artifact,
      approvalEdge: processingEdge,
    };
  }

  function storeApprovalArtifacts(projectId, agentProfileId, artifacts, actor) {
    const writerNodeId = nodeId("agent_profile", agentProfileId);
    const writerEdge = activeGraphEdges(projectId).find((edge) => (
      edge.sourceNodeId === writerNodeId && edge.relationType === "approval_writes"
    ));
    const plans = artifacts.filter((artifact) => artifact.kind === "plan" && artifact.status === "ready");
    if (!writerEdge || plans.length === 0) return null;
    const edges = plans.map((artifact) => ensureStoredEdge(
      projectId,
      nodeId("request_artifact", artifact.id),
      writerEdge.targetNodeId,
      "stored_for_approval",
      "Pending approval",
      actor,
      { depositedByAgentId: agentProfileId },
    ));
    const readerAgentIds = activeGraphEdges(projectId)
      .filter((edge) => edge.targetNodeId === writerEdge.targetNodeId && edge.relationType === "approval_reads")
      .map((edge) => edge.sourceNodeId.startsWith("agent_profile:")
        ? edge.sourceNodeId.slice("agent_profile:".length)
        : null)
      .filter(Boolean);
    const assignment = readerAgentIds
      .map((readerAgentId) => scheduleAgentWork(projectId, readerAgentId, actor))
      .find(Boolean) ?? null;
    return {
      approvalPool: database.getApprovalPool(writerEdge.targetNodeId.slice("approval_pool:".length)),
      edges,
      assignment,
    };
  }

  function storeContextResult(projectId, demandId, assetId, actor) {
    return ensureStoredEdge(
      projectId,
      nodeId("demand", demandId),
      nodeId("knowledge_asset", assetId),
      "becomes_context",
      "Public memory",
      actor,
    );
  }

  function scheduleAgentWork(projectId, agentProfileId, actor) {
    if (!backlogWorkerAvailable(agentProfileId)) return null;
    const directDemands = pendingDirectDemandEdges(projectId, agentProfileId);
    const hasManagedPoolConnection = activeGraphEdges(projectId).some((edge) => (
      edge.sourceNodeId === nodeId("agent_profile", agentProfileId)
      && ["executor_for", "approval_reads", "approval_writes"].includes(edge.relationType)
    ));
    return directDemands[0]?.demand
      ? executeDemand(
          directDemands[0].demand.id,
          agentProfileId,
          actor,
          directDemands.length === 1 && !hasManagedPoolConnection,
        )
      : scheduleApprovalPool(projectId, agentProfileId, actor)
        ?? scheduleBacklog(projectId, agentProfileId, actor);
  }

  async function executeCommand(projectId, input, actor) {
    let command = database.createGraphCommand({
      id: randomUUID(),
      projectId,
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
      actionType: input.actionType,
      requestedBy: `${actor.type}:${actor.id}`,
      idempotencyKey: input.idempotencyKey,
      input: input.input,
    });
    if (command.status !== "pending") return command;
    try {
      const map = await buildProjectMap(projectId);
      const source = map?.nodes.find((node) => node.id === input.sourceNodeId);
      const target = map?.nodes.find((node) => node.id === input.targetNodeId);
      if (!source || !target) {
        throw new ApiError(404, "GRAPH_NODE_NOT_FOUND", "The command graph node no longer exists");
      }
      let result;
      if (input.actionType === "create_task_relation") {
        if (source.entityType !== "task" || target.entityType !== "task") {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Task relations require two task nodes");
        }
        if (!["parent", "blocks", "blocked_by", "related"].includes(input.input.taskRelationType)) {
          throw new ApiError(400, "INVALID_FIELD", "Unknown task relation type");
        }
        const task = database.getTask(source.entityId);
        const relation = database.addTaskRelation(
          source.entityId,
          task.version,
          input.input.taskRelationType,
          target.entityId,
          undefined,
          undefined,
          actor,
        );
        result = {
          kind: "task_relation",
          relationType: input.input.relationType,
          taskRelationType: input.input.taskRelationType,
          task: relation.task,
          relatedTask: relation.relatedTask,
        };
      } else if (input.actionType === "decide_task_review") {
        if (source.entityType !== "task" || target.id !== source.id) {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Task review decision requires its Task node");
        }
        const task = database.getTask(source.entityId);
        if (task.status !== "in_review") {
          throw new ApiError(409, "TASK_NOT_IN_REVIEW", "Task review decisions require in_review status");
        }
        const status = input.input.decision === "approved" ? "done" : "in_progress";
        const updatedTask = database.moveTask(
          task.id,
          task.version,
          status,
          undefined,
          undefined,
          undefined,
          actor,
        );
        const comment = String(input.input.comment ?? "").trim();
        if (comment) database.createComment(task.id, { body: comment, actor });
        result = { kind: "task_review_decision", decision: input.input.decision, task: updatedTask };
      } else if (input.actionType === "comment_on_task") {
        if (source.entityType !== "task" || target.id !== source.id) {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Task question requires its Task node");
        }
        const comment = String(input.input.comment ?? "").trim();
        if (!comment) throw new ApiError(400, "INVALID_FIELD", "A review question is required");
        result = { kind: "task_comment", comment: database.createComment(source.entityId, { body: comment, actor }) };
      } else if (input.actionType === "reassign_task_review") {
        if (source.entityType !== "task" || target.id !== source.id) {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Task reassignment requires its Task node");
        }
        const reviewer = database.getAgentProfile(String(input.input.reviewerAgentId ?? ""));
        if (!reviewer || reviewer.projectId !== projectId || reviewer.role !== "reviewer") {
          throw new ApiError(409, "REVIEWER_REQUIRED", "Select a Reviewer Agent from this Project");
        }
        const task = database.getTask(source.entityId);
        result = {
          kind: "task_updated",
          task: database.updateTask(
            task.id,
            task.version,
            { assignee: { type: "agent", id: reviewer.id, name: reviewer.name, avatarUrl: null } },
            undefined,
            undefined,
            actor,
          ),
        };
      } else if (input.actionType === "postpone_task_review") {
        if (source.entityType !== "task" || target.id !== source.id) {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Task postponement requires its Task node");
        }
        const dueAt = String(input.input.dueAt ?? "").trim();
        if (!dueAt) throw new ApiError(400, "INVALID_FIELD", "A postponement time is required");
        const suffix = String(input.input.comment ?? "").trim();
        result = {
          kind: "task_comment",
          comment: database.createComment(source.entityId, {
            body: `Review postponed until ${dueAt}${suffix ? `: ${suffix}` : ""}`,
            actor,
          }),
        };
      } else if (input.actionType === "create_team") {
        if (source.entityType !== "agent_profile" || target.entityType !== "agent_profile") {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Team creation requires two Agent nodes");
        }
        result = { kind: "agent_team_created", ...governance.createTeam(source.entityId, target.entityId) };
      } else if (["execute_demand", "remember_context"].includes(input.actionType)) {
        if (source.entityType !== "demand" || target.entityType !== "agent_profile") {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Demand execution requires Demand and Agent nodes");
        }
        releaseDemandFromBacklogs(projectId, source.id);
        const directEdge = ensureStoredEdge(
          projectId,
          source.id,
          target.id,
          "direct_for",
          "Direct queue",
          actor,
        );
        const cacheBacklogEdge = activeGraphEdges(projectId).find((edge) => (
          edge.sourceNodeId === target.id
          && edge.relationType === "executor_for"
          && edge.metadata.mode === "cache"
        ));
        const cachedEdges = cacheDirectOverflow(projectId, target.entityId, cacheBacklogEdge, actor);
        const nextAssignment = scheduleAgentWork(projectId, target.entityId, actor);
        if (nextAssignment) {
          result = { ...nextAssignment, directEdge, cachedEdges };
        } else {
          const cached = cachedEdges.find((item) => item.directEdge?.id === directEdge.id);
          result = cached
            ? {
                kind: "direct_demand_cached",
                demand: database.getDemand(source.entityId),
                agent: database.getAgentProfile(target.entityId),
                edge: cached.queueEdge,
                cachedEdges,
              }
            : {
                kind: "direct_demand_queued",
                demand: database.getDemand(source.entityId),
                agent: database.getAgentProfile(target.entityId),
                edge: directEdge,
                cachedEdges,
              };
        }
      } else if (input.actionType === "queue_demand") {
        const demandNode = source.entityType === "demand" ? source : target;
        const backlogNode = source.entityType === "backlog_pool" ? source : target;
        if (demandNode.entityType !== "demand" || backlogNode.entityType !== "backlog_pool") {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Backlog queueing requires Request and Backlog nodes");
        }
        const edge = ensureStoredEdge(
          projectId,
          demandNode.id,
          backlogNode.id,
          "queued_in",
          "Queued",
          actor,
        );
        const cachedDirectEdges = activeGraphEdges(projectId)
          .filter((candidate) => candidate.sourceNodeId === demandNode.id && candidate.relationType === "direct_for")
          .map((candidate) => database.updateGraphEdge(candidate.id, { state: "cached" }));
        const workerEdge = activeGraphEdges(projectId).find((candidate) => (
          candidate.targetNodeId === backlogNode.id && candidate.relationType === "executor_for"
        ));
        const workerAgentId = workerEdge?.sourceNodeId.startsWith("agent_profile:")
          ? workerEdge.sourceNodeId.slice("agent_profile:".length)
          : null;
        const workerAgent = workerAgentId ? database.getAgentProfile(workerAgentId) : null;
        const nextAssignment = workerAgent ? scheduleAgentWork(projectId, workerAgent.id, actor) : null;
        result = nextAssignment
          ? { ...nextAssignment, backlog: database.getBacklogPool(backlogNode.entityId), queueEdge: edge, cachedDirectEdges }
          : { kind: "backlog_demand_queued", demand: database.getDemand(demandNode.entityId), backlog: database.getBacklogPool(backlogNode.entityId), edge, cachedDirectEdges };
      } else if (input.actionType === "join_backlog") {
        const agentNode = source.entityType === "agent_profile" ? source : target;
        const backlogNode = source.entityType === "backlog_pool" ? source : target;
        if (agentNode.entityType !== "agent_profile" || backlogNode.entityType !== "backlog_pool") {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Backlog workers require Agent and Backlog nodes");
        }
        const mode = input.input.mode === "cache" ? "cache" : "pull";
        const edge = ensureStoredEdge(
          projectId,
          agentNode.id,
          backlogNode.id,
          "executor_for",
          mode === "cache" ? "Cache mode" : "Pull mode",
          actor,
          { mode },
        );
        const joiningAgent = database.getAgentProfile(agentNode.entityId);
        const cachedEdges = cacheDirectOverflow(projectId, agentNode.entityId, edge, actor);
        const nextAssignment = joiningAgent ? scheduleAgentWork(projectId, joiningAgent.id, actor) : null;
        result = nextAssignment
          ? { ...nextAssignment, backlog: database.getBacklogPool(backlogNode.entityId), workerEdge: edge, cachedEdges }
          : { kind: "backlog_agent_joined", agent: joiningAgent, backlog: database.getBacklogPool(backlogNode.entityId), edge, cachedEdges };
      } else if (input.actionType === "join_approval_pool") {
        const agentNode = source.entityType === "agent_profile" ? source : target;
        const approvalNode = source.entityType === "approval_pool" ? source : target;
        if (agentNode.entityType !== "agent_profile" || approvalNode.entityType !== "approval_pool") {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Approval Pool connections require Agent and Approval Pool nodes");
        }
        const mode = input.input.mode === "deposit" ? "deposit" : "pull";
        const relationType = mode === "deposit" ? "approval_writes" : "approval_reads";
        const opposingType = mode === "deposit" ? "approval_reads" : "approval_writes";
        activeGraphEdges(projectId)
          .filter((candidate) => (
            candidate.sourceNodeId === agentNode.id
            && candidate.targetNodeId === approvalNode.id
            && candidate.relationType === opposingType
          ))
          .forEach((candidate) => database.updateGraphEdge(candidate.id, { state: "replaced" }));
        const edge = ensureStoredEdge(
          projectId,
          agentNode.id,
          approvalNode.id,
          relationType,
          mode === "deposit" ? "Deposit proposals" : "Pull approved proposals",
          actor,
          { mode },
        );
        const joiningAgent = database.getAgentProfile(agentNode.entityId);
        const nextAssignment = mode === "pull" && joiningAgent
          ? scheduleAgentWork(projectId, joiningAgent.id, actor)
          : null;
        result = nextAssignment
          ? { ...nextAssignment, approvalPool: database.getApprovalPool(approvalNode.entityId), approvalWorkerEdge: edge }
          : {
              kind: "approval_pool_agent_joined",
              agent: joiningAgent,
              approvalPool: database.getApprovalPool(approvalNode.entityId),
              edge,
            };
      } else if (input.actionType === "assign_artifact_review") {
        if (source.entityType !== "review_gate" || target.entityType !== "agent_profile") {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Artifact review requires a pre-review artifact and Agent");
        }
        const assigned = governance.assignArtifactReviewer(source.entityId, target.entityId);
        const reviewRun = orchestration.reviewArtifact(target.entityId, source.entityId);
        result = { kind: "artifact_review_assignment", ...assigned, ...reviewRun };
      } else if (input.actionType === "intake_demand") {
        if (source.entityType !== "demand" || target.entityType !== "agent_profile") {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Demand intake requires Demand and Leader nodes");
        }
        result = { kind: "workstream_intake", ...governance.intakeDemand(source.entityId, target.entityId) };
      } else if (input.actionType === "assign_reviewer") {
        if (source.entityType !== "agent_profile" || target.entityType !== "workstream") {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Review assignment requires Reviewer and Workstream nodes");
        }
        result = { kind: "review_assigned", ...governance.assignReviewer(target.entityId, source.entityId) };
      } else if (input.actionType === "decide_review") {
        if (source.entityType !== "review_gate" || target.id !== source.id) {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Review decision requires its Review Gate node");
        }
        const decision = input.input.decision;
        if (!["approved", "rejected"].includes(decision)) {
          throw new ApiError(400, "INVALID_FIELD", "Review decision must be approved or rejected");
        }
        result = {
          kind: "review_decision",
          ...governance.decideReview(source.entityId, decision, String(input.input.comment ?? ""), actor),
        };
      } else if (input.actionType === "create_change_request") {
        if (source.entityType !== "demand" || target.entityType !== "workstream") {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Change Request requires Demand and Workstream nodes");
        }
        result = {
          kind: "change_request",
          ...governance.createChangeRequest(source.entityId, target.entityId),
        };
      } else if (input.actionType === "assign_agent") {
        if (source.entityType !== "agent_profile" || target.entityType !== "workstream") {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Agent assignment requires Agent and Workstream nodes");
        }
        result = { kind: "agent_assignment", ...orchestration.assignAgent(source.entityId, target.entityId) };
      } else if (input.actionType === "bind_skill") {
        if (source.entityType !== "skill" || target.entityType !== "agent_profile") {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Skill binding requires Skill and Agent or Team nodes");
        }
        result = { kind: "skill_binding", ...governance.bindSkill(source.entityId, target.entityId) };
      } else if (input.actionType === "connect_scheduled_trigger") {
        if (source.entityType !== "scheduled_trigger" || target.entityType !== "agent_profile") {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Scheduled Triggers connect to Agent or Team nodes");
        }
        const trigger = database.getScheduledTrigger(source.entityId);
        if (!trigger || trigger.projectId !== projectId) {
          throw new ApiError(404, "SCHEDULED_TRIGGER_NOT_FOUND", "Scheduled Trigger no longer exists");
        }
        const edge = ensureStoredEdge(
          projectId,
          source.id,
          target.id,
          "scheduled_for",
          "Scheduled",
          actor,
        );
        result = {
          kind: "scheduled_trigger_connected",
          trigger: database.armScheduledTrigger(trigger.id),
          agent: database.getAgentProfile(target.entityId),
          edge,
        };
      } else if (input.actionType === "bind_knowledge") {
        if (source.entityType !== "knowledge_asset" || target.entityType !== "agent_profile") {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Knowledge binding requires Knowledge and Agent nodes");
        }
        result = { kind: "knowledge_binding", ...knowledge.bindKnowledge(source.entityId, target.entityId) };
      } else if (input.actionType === "attach_context") {
        if (source.entityType !== "knowledge_asset" || target.entityType !== "agent_profile") {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Context attachment requires Context Document and Agent nodes");
        }
        result = { kind: "context_attached", ...knowledge.attachContext(source.entityId, target.entityId) };
      } else if (input.actionType === "message_agent") {
        if (!["prompt", "question", "constraint", "background_material"].includes(source.entityType)
          || target.entityType !== "agent_profile") {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Agent messages require a Map instruction item and Agent");
        }
        if (!messageAgent) {
          throw new ApiError(503, "AGENT_HOST_UNAVAILABLE", "DeepSeek Harness Agent orchestration is not available");
        }
        const mode = input.input.mode;
        if (!["followup", "steer", "inject"].includes(mode)) {
          throw new ApiError(400, "INVALID_FIELD", "Agent message mode must be followup, steer, or inject");
        }
        const message = String(input.input.message ?? source.data.details?.content ?? source.data.title).trim();
        if (!message) throw new ApiError(400, "INVALID_FIELD", "Agent message cannot be empty");
        const nodeRun = mode === "followup" ? orchestration.queueFollowup(target.entityId, message) : null;
        await messageAgent(target.entityId, mode, message, nodeRun?.id ?? null);
        result = {
          kind: "agent_message",
          mode,
          agentProfileId: target.entityId,
          mapItem: database.markMapItemSent(source.entityId),
          nodeRun,
        };
      } else if (input.actionType === "propose_knowledge_update") {
        if (source.entityType !== "delivery" || target.entityType !== "knowledge_asset") {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Knowledge proposal requires Delivery and Knowledge nodes");
        }
        result = { kind: "knowledge_proposal", ...knowledge.proposeFromDelivery(source.entityId, target.entityId, actor) };
      } else if (input.actionType === "decide_execution_review") {
        if (source.entityType !== "review_gate" || target.id !== source.id) {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Execution review decision requires its Review Gate node");
        }
        const decision = input.input.decision;
        if (!["approved", "rejected"].includes(decision)) {
          throw new ApiError(400, "INVALID_FIELD", "Review decision must be approved or rejected");
        }
        result = knowledge.decideExecutionReview(
          source.entityId,
          decision,
          String(input.input.comment ?? ""),
          actor,
        );
      } else if (input.actionType === "decide_knowledge_proposal") {
        if (source.entityType !== "knowledge_proposal" || target.entityType !== "knowledge_asset") {
          throw new ApiError(409, "INVALID_GRAPH_ACTION", "Knowledge decision requires Proposal and Knowledge nodes");
        }
        const decision = input.input.decision;
        if (!["approved", "rejected"].includes(decision)) {
          throw new ApiError(400, "INVALID_FIELD", "Knowledge decision must be approved or rejected");
        }
        result = knowledge.decideKnowledgeProposal(source.entityId, decision, actor);
      } else if (input.actionType === "create_relation") {
        const relationType = String(input.input.relationType ?? "").trim();
        if (!relationType) throw new ApiError(400, "INVALID_FIELD", "A relation type is required");
        const edge = database.createGraphEdge({
          id: randomUUID(),
          projectId,
          sourceNodeId: source.id,
          targetNodeId: target.id,
          relationType,
          metadata: { label: input.input.label ?? relationType.replaceAll("_", " ") },
          createdBy: `${actor.type}:${actor.id}`,
        });
        result = { kind: "graph_edge", edge };
      } else {
        throw new ApiError(400, "INVALID_FIELD", "Unknown graph command action type");
      }
      command = database.completeGraphCommand(command.id, result);
      return command;
    } catch (error) {
      database.failGraphCommand(command.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  return {
    getProjectMap,
    assignNodeToCanvas,
    saveNodeLayout,
    resolveAction,
    executeCommand,
    scheduleBacklog,
    scheduleAgentWork,
    storeApprovalArtifacts,
    storeContextResult,
    getCommand: (id) => database.getGraphCommand(id),
  };
}
