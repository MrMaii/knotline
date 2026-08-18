import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  assignNodeToCanvas,
  clearProjectCanvas,
  createApprovalPool,
  controlNodeRun,
  createBacklogPool,
  createDemand,
  createGraphCommand,
  createProjectCanvas,
  createProjectAgent,
  createProjectSkill,
  createScheduledTrigger,
  duplicateContextDocument,
  getProjectMap,
  listProjectCanvases,
  renameProjectAgent,
  resolveGraphAction,
  saveGraphNodeLayout,
  sendAgentRuntimeMessage,
  setScheduledTriggerEnabled,
  updateNotification,
} from "../api";
import { useKnotlineI18n } from "../i18n";
import type {
  GraphActionResolution,
  GraphComposeResolution,
  GraphDirectResolution,
  GraphRelationCandidate,
  ProjectCanvas,
  ProjectMapConnectionHandles,
  ProjectMapEdge,
  ProjectMapNode,
  ProjectMapSnapshot,
} from "../types";
import type { RootNodeKind } from "./AgentDrawer";
import { RequestComposer, ScheduledTriggerComposer } from "./NodePalette";
import { MapInspector } from "./MapInspector";
import { NodeDetailOverlay } from "./NodeDetailOverlay";
import { ProjectMapCanvas } from "./ProjectMapCanvas";
import { RelationComposer } from "./RelationComposer";
import { CanvasDrawer, NodeDrawer } from "./ToolbarDrawers";
import "./project-map.css";

interface ProjectMapViewProps {
  projectId: string;
  workspacePath: string;
  revision: number;
  focusNodeId?: string | null | undefined;
  focusRequest?: number | undefined;
}

const FIRST_RUN_GUIDE_KEY = "knotline.firstRunGuideDismissed";

function firstRunGuideDismissed(): boolean {
  try {
    return window.localStorage.getItem(FIRST_RUN_GUIDE_KEY) === "1";
  } catch {
    return true;
  }
}

function dismissFirstRunGuide(): void {
  try {
    window.localStorage.setItem(FIRST_RUN_GUIDE_KEY, "1");
  } catch {
    // Private-mode storage failures just skip persistence.
  }
}

// crypto.randomUUID is unavailable in non-secure contexts (plain HTTP off localhost).
function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isSameDirectAction(first: GraphActionResolution, second: GraphActionResolution) {
  return first.mode === "direct"
    && second.mode === "direct"
    && first.action.actionType === second.action.actionType
    && JSON.stringify(first.action.input) === JSON.stringify(second.action.input);
}

const SIMPLE_WORKFLOW_ENTITY_TYPES = new Set<ProjectMapNode["entityType"]>([
  "agent_profile",
  "skill",
  "scheduled_trigger",
  "backlog_pool",
  "approval_pool",
  "notification",
]);

function reverseWorkflowEdge(edge: ProjectMapEdge): ProjectMapEdge {
  const { sourceHandle, targetHandle, ...rest } = edge;
  return {
    ...rest,
    source: edge.target,
    target: edge.source,
    ...(targetHandle !== undefined ? { sourceHandle: targetHandle } : {}),
    ...(sourceHandle !== undefined ? { targetHandle: sourceHandle } : {}),
  };
}

function simpleWorkflowMap(snapshot: ProjectMapSnapshot): ProjectMapSnapshot {
  const pooledDemandIds = new Set(snapshot.edges
    .filter((edge) => edge.relationType === "queued_in" && edge.target.startsWith("backlog_pool:"))
    .map((edge) => edge.source));
  const nodes = snapshot.nodes.filter((node) => (
    SIMPLE_WORKFLOW_ENTITY_TYPES.has(node.entityType)
    || (node.entityType === "demand" && !pooledDemandIds.has(node.id))
    || (node.entityType === "knowledge_asset" && node.data.kind === "Context Document")
    || (node.entityType === "request_artifact" && ["Answer", "Work Report"].includes(node.data.kind))
  ));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const visibleNodeIds = new Set(nodesById.keys());
  const storedPairs = new Set(snapshot.edges
    .filter((edge) => !edge.projected)
    .map((edge) => `${edge.source}|${edge.target}`));
  const edgeKeys = new Set<string>();
  const edges = snapshot.edges.flatMap((edge) => {
    if (!visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target)) return [];
    if (edge.projected && storedPairs.has(`${edge.source}|${edge.target}`)) return [];
    const target = nodesById.get(edge.target);
    const source = nodesById.get(edge.source);
    if (target?.entityType === "request_artifact" && source?.entityType !== "agent_profile") return [];
    const projected = edge.relationType === "executor_for" || edge.relationType === "approval_reads"
      ? reverseWorkflowEdge(edge)
      : edge;
    const edgeKey = `${projected.source}|${projected.target}|${projected.relationType}`;
    if (edgeKeys.has(edgeKey)) return [];
    edgeKeys.add(edgeKey);
    return [projected];
  });
  const agentByRun = new Map(snapshot.edges
    .filter((edge) => edge.relationType === "working_on" && edge.source.startsWith("agent_profile:"))
    .map((edge) => [edge.target, edge.source]));
  for (const edge of snapshot.edges) {
    if (!edge.target.startsWith("notification:") || !visibleNodeIds.has(edge.target)) continue;
    const agentId = agentByRun.get(edge.source);
    if (!agentId || !visibleNodeIds.has(agentId)) continue;
    const edgeKey = `${agentId}|${edge.target}|completed`;
    if (edgeKeys.has(edgeKey)) continue;
    edgeKeys.add(edgeKey);
    edges.push({
      id: `simple:${agentId}:${edge.target}`,
      source: agentId,
      target: edge.target,
      relationType: "completed",
      label: "Completed",
      projected: true,
    });
  }
  return { ...snapshot, nodes, edges };
}

export function ProjectMapView({ projectId, workspacePath, revision, focusNodeId, focusRequest }: ProjectMapViewProps) {
  const { text } = useKnotlineI18n();
  const [map, setMap] = useState<ProjectMapSnapshot | null>(null);
  const [canvases, setCanvases] = useState<ProjectCanvas[]>([]);
  const [canvasId, setCanvasId] = useState<string | null>(null);
  const [canvasBusy, setCanvasBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshRequest, setRefreshRequest] = useState(0);
  const [creatingNode, setCreatingNode] = useState(false);
  const [requestPosition, setRequestPosition] = useState<{ x: number; y: number } | null>(null);
  const [scheduledPosition, setScheduledPosition] = useState<{ x: number; y: number } | null>(null);
  const [resolution, setResolution] = useState<GraphComposeResolution | null>(null);
  const [relationHandles, setRelationHandles] = useState<ProjectMapConnectionHandles | null>(null);
  const [submittingRelation, setSubmittingRelation] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [decidingReview, setDecidingReview] = useState(false);
  const [controllingRun, setControllingRun] = useState(false);
  const [showExecutionDetails, setShowExecutionDetails] = useState(false);
  const [showFirstRunGuide, setShowFirstRunGuide] = useState(() => !firstRunGuideDismissed());
  const [detailNodeId, setDetailNodeId] = useState<string | null>(null);
  const detailNode = map?.nodes.find((node) => node.id === detailNodeId) ?? null;
  const closeFirstRunGuide = () => {
    dismissFirstRunGuide();
    setShowFirstRunGuide(false);
  };
  const selectedNode = map?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const displayedMap = useMemo(() => (
    map && !showExecutionDetails ? simpleWorkflowMap(map) : map
  ), [map, showExecutionDetails]);

  useEffect(() => setShowExecutionDetails(false), [projectId]);
  useEffect(() => {
    if (!focusNodeId || !map || showExecutionDetails) return;
    if (!displayedMap?.nodes.some((node) => node.id === focusNodeId)) setShowExecutionDetails(true);
  }, [displayedMap, focusNodeId, map, showExecutionDetails]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const nextCanvases = await listProjectCanvases(projectId);
      const firstCanvas = nextCanvases[0];
      if (!firstCanvas) throw new Error("This project has no available canvas.");
      const selectedCanvasId = nextCanvases.some((canvas) => canvas.id === canvasId)
        ? canvasId as string
        : firstCanvas.id;
      const snapshot = await getProjectMap(projectId, selectedCanvasId, signal);
      if (!signal?.aborted) {
        setCanvases(nextCanvases);
        setCanvasId(selectedCanvasId);
        setMap(snapshot);
        setError("");
      }
    } catch (nextError) {
      if (!signal?.aborted) setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [canvasId, projectId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshRequest, revision]);

  async function moveNode(node: ProjectMapNode, position: { x: number; y: number }) {
    setMap((current) => current ? {
      ...current,
      nodes: current.nodes.map((candidate) => (
        candidate.id === node.id ? { ...candidate, ...position } : candidate
      )),
    } : current);
    try {
      const saved = await saveGraphNodeLayout(node, position);
      setMap((current) => current ? {
        ...current,
        nodes: current.nodes.map((candidate) => (
          candidate.id === saved.id ? { ...candidate, ...saved, data: candidate.data } : candidate
        )),
      } : current);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof ApiError && nextError.code === "VERSION_CONFLICT"
        ? text("节点已在其他位置移动，地图已重新同步。", "This node moved elsewhere. The map has been synced.")
        : nextError instanceof Error ? nextError.message : String(nextError));
      setRefreshRequest((current) => current + 1);
    }
  }

  async function placeCreatedNode(
    snapshot: ProjectMapSnapshot,
    entityType: ProjectMapNode["entityType"],
    entityId: string,
    position: { x: number; y: number },
  ) {
    const node = snapshot.nodes.find((candidate) => (
      candidate.entityType === entityType && candidate.entityId === entityId
    ));
    if (!node) return snapshot;
    const saved = await saveGraphNodeLayout(node, {
      x: position.x - node.width / 2,
      y: position.y - node.height / 2,
    });
    setSelectedNodeId(node.id);
    return {
      ...snapshot,
      nodes: snapshot.nodes.map((candidate) => candidate.id === saved.id
        ? { ...candidate, ...saved, data: candidate.data }
        : candidate),
    };
  }

  async function createIslandDemand(input: { title: string; description: string; acceptanceCriteria: string[] }) {
    if (!requestPosition || !canvasId) return;
    setCreatingNode(true);
    try {
      const demand = await createDemand(projectId, input);
      await assignNodeToCanvas(projectId, canvasId, `demand:${demand.id}`);
      const snapshot = await placeCreatedNode(
        await getProjectMap(projectId, canvasId),
        "demand",
        demand.id,
        requestPosition,
      );
      setMap(snapshot);
      setRequestPosition(null);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setCreatingNode(false);
    }
  }

  async function createAgentAt(position: { x: number; y: number }) {
    if (!canvasId) return;
    setCreatingNode(true);
    try {
      const agentCount = map?.nodes.filter((node) => (
        node.entityType === "agent_profile" && node.data.kind !== "Team"
      )).length ?? 0;
      const agent = await createProjectAgent(projectId, {
        name: `Agent ${agentCount + 1}`,
        role: "executor",
        skillId: null,
      });
      await assignNodeToCanvas(projectId, canvasId, `agent_profile:${agent.id}`);
      const snapshot = await placeCreatedNode(
        await getProjectMap(projectId, canvasId),
        "agent_profile",
        agent.id,
        position,
      );
      setMap(snapshot);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setCreatingNode(false);
    }
  }

  async function createBacklogAt(position: { x: number; y: number }) {
    if (!canvasId) return;
    setCreatingNode(true);
    try {
      const count = map?.nodes.filter((node) => node.entityType === "backlog_pool").length ?? 0;
      const backlog = await createBacklogPool(projectId, count === 0 ? text("积压池", "Backlog") : text(`积压池 ${count + 1}`, `Backlog ${count + 1}`));
      await assignNodeToCanvas(projectId, canvasId, `backlog_pool:${backlog.id}`);
      const snapshot = await placeCreatedNode(
        await getProjectMap(projectId, canvasId),
        "backlog_pool",
        backlog.id,
        position,
      );
      setMap(snapshot);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setCreatingNode(false);
    }
  }

  async function createApprovalPoolAt(position: { x: number; y: number }) {
    if (!canvasId) return;
    setCreatingNode(true);
    try {
      const count = map?.nodes.filter((node) => node.entityType === "approval_pool").length ?? 0;
      const approvalPool = await createApprovalPool(
        projectId,
        count === 0 ? text("审批池", "Approval Pool") : text(`审批池 ${count + 1}`, `Approval Pool ${count + 1}`),
      );
      await assignNodeToCanvas(projectId, canvasId, `approval_pool:${approvalPool.id}`);
      const snapshot = await placeCreatedNode(
        await getProjectMap(projectId, canvasId),
        "approval_pool",
        approvalPool.id,
        position,
      );
      setMap(snapshot);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setCreatingNode(false);
    }
  }

  async function createSkill(skillId: string) {
    if (!canvasId) return;
    setCreatingNode(true);
    try {
      const skillNode = await createProjectSkill(projectId, skillId);
      await assignNodeToCanvas(projectId, canvasId, `skill:${skillNode.id}`);
      const snapshot = await getProjectMap(projectId, canvasId);
      setMap(snapshot);
      setSelectedNodeId(`skill:${skillNode.id}`);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      throw nextError;
    } finally {
      setCreatingNode(false);
    }
  }

  async function duplicateNode(node: ProjectMapNode) {
    if (!canvasId || node.entityType !== "knowledge_asset" || node.data.kind !== "Context Document") return;
    try {
      const asset = await duplicateContextDocument(node.entityId);
      await assignNodeToCanvas(projectId, canvasId, `knowledge_asset:${asset.id}`);
      setMap(await getProjectMap(projectId, canvasId));
      setSelectedNodeId(`knowledge_asset:${asset.id}`);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  async function dismissNotification() {
    if (!selectedNode || selectedNode.entityType !== "notification") return;
    try {
      await updateNotification(selectedNode.entityId, { read: true, handled: true });
      setSelectedNodeId(null);
      setRefreshRequest((current) => current + 1);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  async function createScheduledAt(input: { prompt: string; intervalMinutes: number; enabled: boolean }) {
    if (!scheduledPosition || !canvasId) return;
    setCreatingNode(true);
    try {
      const trigger = await createScheduledTrigger(projectId, input);
      await assignNodeToCanvas(projectId, canvasId, `scheduled_trigger:${trigger.id}`);
      const snapshot = await placeCreatedNode(
        await getProjectMap(projectId, canvasId),
        "scheduled_trigger",
        trigger.id,
        scheduledPosition,
      );
      setMap(snapshot);
      setScheduledPosition(null);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setCreatingNode(false);
    }
  }

  function createRoot(kind: RootNodeKind, position: { x: number; y: number }) {
    if (kind === "request") {
      setRequestPosition(position);
      return;
    }
    if (kind === "scheduled") {
      setScheduledPosition(position);
      return;
    }
    if (kind === "agent") void createAgentAt(position);
    else if (kind === "backlog") void createBacklogAt(position);
    else void createApprovalPoolAt(position);
  }

  function activateRoot(kind: RootNodeKind) {
    const positions: Record<RootNodeKind, { x: number; y: number }> = {
      agent: { x: 700, y: 180 },
      request: { x: 280, y: 180 },
      backlog: { x: 280, y: 500 },
      approval: { x: 700, y: 500 },
      scheduled: { x: 1080, y: 180 },
    };
    const base = positions[kind];
    const existing = map?.nodes ?? [];
    const position = Array.from({ length: 80 }, (_, index) => ({
      x: base.x + (index % 4) * 320,
      y: base.y + Math.floor(index / 4) * 220,
    })).find((candidate) => !existing.some((node) => (
      candidate.x + 150 > node.x - 24
      && candidate.x - 150 < node.x + node.width + 24
      && candidate.y + 100 > node.y - 24
      && candidate.y - 100 < node.y + node.height + 24
    ))) ?? base;
    createRoot(kind, position);
  }

  async function createCanvas() {
    setCanvasBusy(true);
    try {
      const canvas = await createProjectCanvas(projectId);
      setCanvases((current) => [...current, canvas]);
      setCanvasId(canvas.id);
      setSelectedNodeId(null);
      setMap(await getProjectMap(projectId, canvas.id));
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setCanvasBusy(false);
    }
  }

  async function clearCanvas() {
    const canvas = canvases.find((candidate) => candidate.id === canvasId);
    if (!canvas || !canvasId) return;
    const confirmed = window.confirm(text(
      `清空「${canvas.name}」？节点会从这个画布移除，但项目里的任务和 Agent 数据会保留。`,
      `Clear “${canvas.name}”? Nodes will be removed from this canvas, while project tasks and Agent data stay intact.`,
    ));
    if (!confirmed) return;
    setCanvasBusy(true);
    try {
      await clearProjectCanvas(projectId, canvasId);
      setSelectedNodeId(null);
      setMap(await getProjectMap(projectId, canvasId));
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setCanvasBusy(false);
    }
  }

  const renameAgent = useCallback(async (node: ProjectMapNode, name: string) => {
    try {
      const agent = await renameProjectAgent(node.entityId, name);
      setMap((current) => current ? {
        ...current,
        nodes: current.nodes.map((candidate) => candidate.id === node.id
          ? { ...candidate, data: { ...candidate.data, title: agent.name, entityVersion: agent.version } }
          : candidate),
      } : current);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, []);

  const toggleScheduledTrigger = useCallback(async (node: ProjectMapNode, enabled: boolean) => {
    try {
      const trigger = await setScheduledTriggerEnabled(node.entityId, enabled);
      setMap((current) => current ? {
        ...current,
        nodes: current.nodes.map((candidate) => candidate.id === node.id
          ? {
              ...candidate,
              data: {
                ...candidate.data,
                status: trigger.enabled ? "enabled" : "paused",
                entityVersion: trigger.version,
                details: { ...candidate.data.details, ...trigger },
              },
            }
          : candidate),
      } : current);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, []);

  async function executeDirectAction(
    nextResolution: GraphDirectResolution,
    handles?: ProjectMapConnectionHandles,
  ) {
    setSubmittingRelation(true);
    try {
      await createGraphCommand(projectId, {
        sourceNodeId: nextResolution.source.id,
        targetNodeId: nextResolution.target.id,
        actionType: nextResolution.action.actionType,
        idempotencyKey: newIdempotencyKey(),
        input: { ...nextResolution.action.input, ...handles },
      });
      setRefreshRequest((current) => current + 1);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSubmittingRelation(false);
    }
  }

  async function connectNodes(
    source: ProjectMapNode,
    target: ProjectMapNode,
    handles?: ProjectMapConnectionHandles,
  ) {
    try {
      const nextResolution = await resolveGraphAction(projectId, source.id, target.id);
      await applyResolvedConnection(nextResolution, handles);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  async function applyResolvedConnection(
    nextResolution: GraphActionResolution,
    handles?: ProjectMapConnectionHandles,
  ) {
    if (nextResolution.mode === "direct") {
      await executeDirectAction(nextResolution, handles);
      return;
    }
    if (nextResolution.mode === "compose") {
      setResolution(nextResolution);
      setRelationHandles(handles ?? null);
      setError("");
      return;
    }
    setError(nextResolution.message);
  }

  async function resolveConnectionIntent(
    first: ProjectMapNode,
    second: ProjectMapNode,
    handles: ProjectMapConnectionHandles,
  ): Promise<"handled" | "choose"> {
    try {
      const [forward, reverse] = await Promise.all([
        resolveGraphAction(projectId, first.id, second.id),
        resolveGraphAction(projectId, second.id, first.id),
      ]);
      const forwardSupported = forward.mode !== "unsupported";
      const reverseSupported = reverse.mode !== "unsupported";

      if (forwardSupported && !reverseSupported) {
        await applyResolvedConnection(forward, handles);
        return "handled";
      }
      if (!forwardSupported && reverseSupported) {
        await applyResolvedConnection(reverse, {
          sourceHandle: handles.targetHandle,
          targetHandle: handles.sourceHandle,
        });
        return "handled";
      }
      if (forwardSupported && reverseSupported && isSameDirectAction(forward, reverse)) {
        await applyResolvedConnection(forward, handles);
        return "handled";
      }
      if (forwardSupported && reverseSupported) return "choose";

      const unsupported = forward.mode === "unsupported"
        ? forward
        : reverse.mode === "unsupported" ? reverse : null;
      if (unsupported) setError(unsupported.message);
      return "handled";
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      return "handled";
    }
  }

  async function decideReview(decision: "approved" | "rejected", comment: string) {
    if (!selectedNode || !["review_gate", "knowledge_proposal"].includes(selectedNode.entityType)) return;
    const details = selectedNode.data.details ?? {};
    const executionReview = details.purpose === "execution";
    const targetNodeId = selectedNode.entityType === "knowledge_proposal"
      ? typeof details.assetId === "string" ? `knowledge_asset:${details.assetId}` : null
      : selectedNode.id;
    if (!targetNodeId) return;
    setDecidingReview(true);
    try {
      await createGraphCommand(projectId, {
        sourceNodeId: selectedNode.id,
        targetNodeId,
        actionType: selectedNode.entityType === "knowledge_proposal"
          ? "decide_knowledge_proposal"
          : executionReview ? "decide_execution_review" : "decide_review",
        idempotencyKey: newIdempotencyKey(),
        input: { decision, comment },
      });
      setRefreshRequest((current) => current + 1);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setDecidingReview(false);
    }
  }

  async function messageAgent(mode: "followup" | "steer" | "inject", message: string) {
    if (!selectedNode || !["agent_profile", "node_run"].includes(selectedNode.entityType)) return;
    const agentProfileId = selectedNode.entityType === "agent_profile"
      ? selectedNode.entityId
      : typeof selectedNode.data.details?.agentProfileId === "string"
        ? selectedNode.data.details.agentProfileId
        : null;
    if (!agentProfileId) return;
    try {
      await sendAgentRuntimeMessage(agentProfileId, mode, message);
      setRefreshRequest((current) => current + 1);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  async function controlTaskBench(action: "pause" | "resume") {
    if (!selectedNode || selectedNode.entityType !== "node_run") return;
    setControllingRun(true);
    try {
      await controlNodeRun(selectedNode.entityId, action);
      setRefreshRequest((current) => current + 1);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setControllingRun(false);
    }
  }

  async function applyRelation(candidate: GraphRelationCandidate, customLabel: string) {
    if (!resolution) return;
    setSubmittingRelation(true);
    const relationType = candidate.id === "custom" ? customLabel : candidate.relationType;
    try {
      await createGraphCommand(projectId, {
        sourceNodeId: resolution.source.id,
        targetNodeId: resolution.target.id,
        actionType: candidate.actionType,
        idempotencyKey: newIdempotencyKey(),
        input: {
          relationType,
          label: candidate.id === "custom" ? customLabel : candidate.labelEn,
          ...(candidate.taskRelationType ? { taskRelationType: candidate.taskRelationType } : {}),
          ...candidate.input,
          ...relationHandles,
        },
      });
      setResolution(null);
      setRelationHandles(null);
      setRefreshRequest((current) => current + 1);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSubmittingRelation(false);
    }
  }

  return (
    <section className="project-map-view" aria-label={text("项目运行地图", "Project operating map")}>
      {showFirstRunGuide && (
        <div
          className="project-map-request-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeFirstRunGuide();
          }}
        >
          <div
            className="project-map-first-run-guide"
            role="dialog"
            aria-modal="true"
            aria-label={text("三步跑通第一个工作流", "Your first workflow in three steps")}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeFirstRunGuide();
            }}
          >
            <strong>{text("三步跑通第一个工作流", "Your first workflow in three steps")}</strong>
            <ol>
              <li><b>1</b>{text("从右上「节点」抽屉拖出一个 Agent", "Drag an Agent from the Nodes drawer")}</li>
              <li><b>2</b>{text("再拖出一个诉求，写下你想要什么", "Drag a Request and describe what you want")}</li>
              <li><b>3</b>{text("把诉求连向 Agent —— 连线即执行", "Connect the Request to the Agent — the line runs it")}</li>
            </ol>
            <small>{text("回答、计划、审核和交付会自动长在同一张地图上", "Answers, plans, reviews, and deliveries grow on this map by themselves")}</small>
            <button type="button" className="is-primary" autoFocus onClick={closeFirstRunGuide}>
              {text("知道了，开始使用", "Got it, start mapping")}
            </button>
          </div>
        </div>
      )}
      <header className="project-map-toolbar">
        <div>
          <strong>{map?.canvas.name ?? text("项目画布", "Project canvas")}</strong>
          <span>{map && displayedMap ? text(
            showExecutionDetails
              ? `${map.nodes.length} 个节点 · ${map.edges.length} 条关系`
              : `主工作流 ${displayedMap.nodes.length} 个节点 · 已收起 ${map.nodes.length - displayedMap.nodes.length} 个执行细节`,
            showExecutionDetails
              ? `${map.nodes.length} nodes · ${map.edges.length} relations`
              : `${displayedMap.nodes.length} workflow nodes · ${map.nodes.length - displayedMap.nodes.length} execution details hidden`,
          ) : text("正在读取项目状态", "Reading project state")}</span>
        </div>
        <div className="project-map-toolbar-actions">
          <NodeDrawer
            creating={creatingNode}
            workspacePath={workspacePath}
            onActivate={activateRoot}
            onCreateSkill={createSkill}
          />
          <CanvasDrawer
            canvases={canvases}
            currentCanvasId={canvasId}
            busy={canvasBusy}
            onSelect={(nextCanvasId) => {
              setShowExecutionDetails(false);
              setSelectedNodeId(null);
              setCanvasId(nextCanvasId);
            }}
            onCreate={() => void createCanvas()}
            onClear={() => void clearCanvas()}
          />
          <button
            type="button"
            className={`project-map-detail-toggle${showExecutionDetails ? " is-active" : ""}`}
            aria-pressed={showExecutionDetails}
            onClick={() => {
              setSelectedNodeId(null);
              setShowExecutionDetails((current) => !current);
            }}
          >
            {showExecutionDetails
              ? text("收起执行详情", "Hide execution details")
              : text("显示执行详情", "Show execution details")}
          </button>
          <button type="button" onClick={() => setRefreshRequest((current) => current + 1)} disabled={loading}>
            {loading ? text("同步中…", "Syncing…") : text("刷新", "Refresh")}
          </button>
        </div>
      </header>
      {error && <div className="project-map-error" role="alert">{error}</div>}
      {displayedMap ? (
        <ProjectMapCanvas
          nodes={displayedMap.nodes}
          edges={displayedMap.edges}
          onMoveNode={(node, position) => void moveNode(node, position)}
          onConnectNodes={(source, target, handles) => void connectNodes(source, target, handles)}
          onConnectIntent={resolveConnectionIntent}
          onDuplicateNode={duplicateNode}
          onCreateRoot={createRoot}
          onRenameAgent={renameAgent}
          onToggleScheduledTrigger={toggleScheduledTrigger}
          onSelectNode={(nodeId) => {
            const node = nodeId ? map?.nodes.find((candidate) => candidate.id === nodeId) ?? null : null;
            // Requests and report-like nodes read better as a detail page than a sidebar.
            if (node && ["demand", "request_artifact", "delivery"].includes(node.entityType)) {
              setDetailNodeId(nodeId);
              return;
            }
            setSelectedNodeId(nodeId);
          }}
          onOpenDetail={(record) => setDetailNodeId(record.id)}
          focusNodeId={focusNodeId}
          focusRequest={focusRequest}
        />
      ) : (
        <div className="project-map-loading">{loading ? text("正在加载地图…", "Loading map…") : error}</div>
      )}
      {resolution && (
        <RelationComposer
          resolution={resolution}
          submitting={submittingRelation}
          onCancel={() => {
            setResolution(null);
            setRelationHandles(null);
          }}
          onConfirm={applyRelation}
        />
      )}
      {requestPosition && (
        <RequestComposer
          creating={creatingNode}
          onCancel={() => setRequestPosition(null)}
          onCreate={createIslandDemand}
        />
      )}
      {scheduledPosition && (
        <ScheduledTriggerComposer
          creating={creatingNode}
          onCancel={() => setScheduledPosition(null)}
          onCreate={createScheduledAt}
        />
      )}
      {selectedNode && (
        <MapInspector
          node={selectedNode}
          deciding={decidingReview}
          controllingRun={controllingRun}
          onClose={() => setSelectedNodeId(null)}
          onReview={decideReview}
          onAgentMessage={messageAgent}
          onRunControl={controlTaskBench}
          onDismissNotification={dismissNotification}
        />
      )}
      {detailNode && map && (
        <NodeDetailOverlay
          node={detailNode}
          nodes={map.nodes}
          onClose={() => setDetailNodeId(null)}
          onSendComment={async (agentProfileId, message) => {
            await sendAgentRuntimeMessage(agentProfileId, "followup", message);
          }}
        />
      )}
    </section>
  );
}
