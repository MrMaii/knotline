import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  type Connection,
  MiniMap,
  MarkerType,
  ReactFlow,
  type Edge,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useKnotlineI18n } from "../i18n";
import type {
  ProjectMapConnectionHandles,
  ProjectMapEdge,
  ProjectMapHandle,
  ProjectMapNode,
} from "../types";
import { ROOT_NODE_DRAG_TYPE, type RootNodeKind } from "./AgentDrawer";
import { ProjectMapNodeCard, type ProjectMapCanvasNode } from "./nodes/ProjectMapNodeCard";

const NODE_TYPES = { projectMap: ProjectMapNodeCard } satisfies NodeTypes;
const DIRECTION_GESTURE_THRESHOLD = 24;

interface PendingConnection {
  first: ProjectMapNode;
  firstHandle: ProjectMapHandle | null;
  second: ProjectMapNode;
  secondHandle: ProjectMapHandle | null;
  anchor: { x: number; y: number };
}

interface ProjectMapCanvasProps {
  nodes: ProjectMapNode[];
  edges: ProjectMapEdge[];
  onMoveNode: (node: ProjectMapNode, position: { x: number; y: number }) => void;
  onConnectNodes: (
    source: ProjectMapNode,
    target: ProjectMapNode,
    handles?: ProjectMapConnectionHandles,
  ) => void;
  onConnectIntent: (
    first: ProjectMapNode,
    second: ProjectMapNode,
    handles: ProjectMapConnectionHandles,
  ) => Promise<"handled" | "choose">;
  onDuplicateNode: (node: ProjectMapNode) => Promise<void>;
  onCreateRoot: (kind: RootNodeKind, position: { x: number; y: number }) => void;
  onRenameAgent: (node: ProjectMapNode, name: string) => Promise<void>;
  onToggleScheduledTrigger: (node: ProjectMapNode, enabled: boolean) => Promise<void>;
  onSelectNode: (nodeId: string | null) => void;
  focusNodeId?: string | null | undefined;
  focusRequest?: number | undefined;
}

function toCanvasNode(
  node: ProjectMapNode,
  onRenameAgent: ProjectMapCanvasProps["onRenameAgent"],
  onToggleScheduledTrigger: ProjectMapCanvasProps["onToggleScheduledTrigger"],
): ProjectMapCanvasNode {
  return {
    id: node.id,
    type: "projectMap",
    position: { x: node.x, y: node.y },
    width: node.width,
    height: node.height,
    zIndex: node.zIndex,
    data: { record: node, onRenameAgent, onToggleScheduledTrigger },
  };
}

function toCanvasEdge(edge: ProjectMapEdge): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle !== undefined ? { sourceHandle: edge.sourceHandle } : {}),
    ...(edge.targetHandle !== undefined ? { targetHandle: edge.targetHandle } : {}),
    label: edge.label,
    type: "smoothstep",
    className: `project-map-edge is-${edge.relationType}`,
  };
}

function findDirectDropTarget(
  source: ProjectMapCanvasNode,
  candidates: ProjectMapCanvasNode[],
): ProjectMapCanvasNode | undefined {
  const sourceCenter = {
    x: source.position.x + source.data.record.width / 2,
    y: source.position.y + source.data.record.height / 2,
  };
  return candidates.find((candidate) => {
    const target = candidate.data.record;
    const directDrop = (
      source.data.record.entityType === "demand" && target.entityType === "backlog_pool"
    ) || (
      source.data.record.entityType === "agent_profile"
      && target.entityType === "agent_profile"
      && source.data.record.id !== target.id
      && source.data.record.data.kind !== "Team"
      && target.data.kind !== "Team"
    ) || (
      source.data.record.entityType === "skill" && target.entityType === "agent_profile"
    ) || (
      source.data.record.entityType === "knowledge_asset"
      && source.data.record.data.kind === "Context Document"
      && target.entityType === "agent_profile"
    );
    return directDrop
      && sourceCenter.x >= candidate.position.x
      && sourceCenter.x <= candidate.position.x + target.width
      && sourceCenter.y >= candidate.position.y
      && sourceCenter.y <= candidate.position.y + target.height;
  });
}

function orientConnection(pending: PendingConnection, direction: "up" | "down") {
  const firstCenterY = pending.first.y + pending.first.height / 2;
  const secondCenterY = pending.second.y + pending.second.height / 2;
  if (Math.abs(firstCenterY - secondCenterY) < DIRECTION_GESTURE_THRESHOLD) {
    return direction === "down"
      ? { source: pending.first, target: pending.second }
      : { source: pending.second, target: pending.first };
  }
  const upper = firstCenterY < secondCenterY ? pending.first : pending.second;
  const lower = upper.id === pending.first.id ? pending.second : pending.first;
  return direction === "down"
    ? { source: upper, target: lower }
    : { source: lower, target: upper };
}

export function ProjectMapCanvas({
  nodes,
  edges,
  onMoveNode,
  onConnectNodes,
  onConnectIntent,
  onDuplicateNode,
  onCreateRoot,
  onRenameAgent,
  onToggleScheduledTrigger,
  onSelectNode,
  focusNodeId,
  focusRequest,
}: ProjectMapCanvasProps) {
  const { text } = useKnotlineI18n();
  const projectedNodes = useMemo(
    () => nodes.map((node) => toCanvasNode(node, onRenameAgent, onToggleScheduledTrigger)),
    [nodes, onRenameAgent, onToggleScheduledTrigger],
  );
  const [canvasNodes, setCanvasNodes] = useState(projectedNodes);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [pendingConnection, setPendingConnection] = useState<PendingConnection | null>(null);
  const [contextMenu, setContextMenu] = useState<{ node: ProjectMapNode; x: number; y: number } | null>(null);
  const flowRef = useRef<ReactFlowInstance<ProjectMapCanvasNode, Edge> | null>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const canvasEdges = useMemo(() => edges.map(toCanvasEdge), [edges]);
  const renderedNodes = useMemo(() => canvasNodes.map((node) => node.id === dropTargetId
    ? { ...node, className: "is-node-drop-target" }
    : node), [canvasNodes, dropTargetId]);
  useEffect(() => setCanvasNodes(projectedNodes), [projectedNodes]);
  useEffect(() => {
    if (!focusNodeId) return;
    const node = canvasNodes.find((candidate) => candidate.id === focusNodeId);
    if (node && flowRef.current) {
      void flowRef.current.fitView({ nodes: [node], padding: 0.8, maxZoom: 1.2, duration: 350 });
      onSelectNode(node.id);
    }
  }, [canvasNodes, focusNodeId, focusRequest, onSelectNode]);

  const applyConnectionDirection = useCallback((direction: "up" | "down") => {
    if (!pendingConnection) return;
    const { source, target } = orientConnection(pendingConnection, direction);
    const sourceIsFirst = source.id === pendingConnection.first.id;
    setPendingConnection(null);
    onConnectNodes(source, target, {
      sourceHandle: sourceIsFirst ? pendingConnection.firstHandle : pendingConnection.secondHandle,
      targetHandle: sourceIsFirst ? pendingConnection.secondHandle : pendingConnection.firstHandle,
    });
  }, [onConnectNodes, pendingConnection]);

  useEffect(() => {
    if (!pendingConnection) return;
    const handlePointerMove = (event: PointerEvent) => {
      const deltaY = event.clientY - pendingConnection.anchor.y;
      if (Math.abs(deltaY) < DIRECTION_GESTURE_THRESHOLD) return;
      applyConnectionDirection(deltaY < 0 ? "up" : "down");
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPendingConnection(null);
      if (event.key === "ArrowUp") applyConnectionDirection("up");
      if (event.key === "ArrowDown") applyConnectionDirection("down");
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [applyConnectionDirection, pendingConnection]);

  return (
    <div
      className="project-map-canvas"
      onContextMenu={(event) => event.preventDefault()}
      onPointerMove={(event) => { pointerRef.current = { x: event.clientX, y: event.clientY }; }}
    >
      <ReactFlow<ProjectMapCanvasNode, Edge>
        nodes={renderedNodes}
        edges={canvasEdges}
        nodeTypes={NODE_TYPES}
        onInit={(instance) => { flowRef.current = instance; }}
        onNodesChange={(changes: NodeChange<ProjectMapCanvasNode>[]) => {
          setCanvasNodes((current) => applyNodeChanges(changes, current));
        }}
        onNodeDrag={(_, canvasNode) => {
          setDropTargetId(findDirectDropTarget(canvasNode, canvasNodes)?.id ?? null);
        }}
        onNodeDragStop={(_, canvasNode) => {
          const source = canvasNode.data.record;
          const directTarget = findDirectDropTarget(canvasNode, canvasNodes)?.data.record;
          setDropTargetId(null);

          if (directTarget) {
            setCanvasNodes(projectedNodes);
            onConnectNodes(source, directTarget);
            return;
          }
          onMoveNode(canvasNode.data.record, canvasNode.position);
        }}
        onConnect={(connection: Connection) => {
          if (!connection.source || !connection.target || connection.source === connection.target) return;
          const first = canvasNodes.find((candidate) => candidate.id === connection.source)?.data.record;
          const second = canvasNodes.find((candidate) => candidate.id === connection.target)?.data.record;
          const firstHandle = connection.sourceHandle === "left" || connection.sourceHandle === "right"
            ? connection.sourceHandle
            : null;
          const secondHandle = connection.targetHandle === "left" || connection.targetHandle === "right"
            ? connection.targetHandle
            : null;
          if (first && second) {
            const pending: PendingConnection = {
              first,
              firstHandle,
              second,
              secondHandle,
              anchor: pointerRef.current,
            };
            void onConnectIntent(first, second, {
              sourceHandle: firstHandle,
              targetHandle: secondHandle,
            }).then((result) => {
              if (result === "choose") setPendingConnection(pending);
            });
          }
        }}
        onNodeClick={(_, node) => {
          setContextMenu(null);
          onSelectNode(node.id);
        }}
        onNodeContextMenu={(event, node) => {
          event.preventDefault();
          const record = node.data.record;
          if (record.entityType !== "knowledge_asset" || record.data.kind !== "Context Document") return;
          setContextMenu({ node: record, x: event.clientX, y: event.clientY });
        }}
        onPaneClick={() => {
          setContextMenu(null);
          onSelectNode(null);
        }}
        onDragOver={(event: DragEvent) => {
          if (!event.dataTransfer.types.includes(ROOT_NODE_DRAG_TYPE)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event: DragEvent) => {
          const kind = event.dataTransfer.getData(ROOT_NODE_DRAG_TYPE) as RootNodeKind;
          if (!flowRef.current || !["agent", "request", "backlog", "approval", "scheduled"].includes(kind)) return;
          event.preventDefault();
          onCreateRoot(kind, flowRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
        }}
        nodesDraggable
        nodesConnectable
        connectionMode={ConnectionMode.Loose}
        connectionRadius={28}
        connectOnClick={false}
        defaultEdgeOptions={{ markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 } }}
        connectionLineStyle={{ stroke: "#6172f3", strokeWidth: 2 }}
        elementsSelectable
        defaultViewport={{ x: 24, y: 24, zoom: 0.9 }}
        minZoom={0.2}
        maxZoom={1.8}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>
      {nodes.length === 0 && (
        <div className="project-map-empty-guide" role="note">
          <strong>{text("三步跑通第一个工作流", "Your first workflow in three steps")}</strong>
          <ol>
            <li><b>1</b>{text("从右上「节点」抽屉拖出一个 Agent", "Drag an Agent from the Nodes drawer")}</li>
            <li><b>2</b>{text("再拖出一个诉求，写下你想要什么", "Drag a Request and describe what you want")}</li>
            <li><b>3</b>{text("把诉求连向 Agent —— 连线即执行", "Connect the Request to the Agent — the line runs it")}</li>
          </ol>
          <small>{text("回答、计划、审核和交付会自动长在同一张地图上", "Answers, plans, reviews, and deliveries grow on this map by themselves")}</small>
        </div>
      )}
      {pendingConnection && (() => {
        const upward = orientConnection(pendingConnection, "up");
        const downward = orientConnection(pendingConnection, "down");
        return (
          <div
            className="project-map-direction-picker"
            style={{ left: pendingConnection.anchor.x, top: pendingConnection.anchor.y }}
            role="group"
            aria-label={text("选择连接方向", "Choose connection direction")}
          >
            <button type="button" onClick={() => applyConnectionDirection("up")}>
              <b>↑</b><span>{text(`发给 ${upward.target.data.title}`, `Send to ${upward.target.data.title}`)}</span>
            </button>
            <small>{text("移动鼠标选择流向", "Move the pointer to choose the direction")}</small>
            <button type="button" onClick={() => applyConnectionDirection("down")}>
              <b>↓</b><span>{text(`发给 ${downward.target.data.title}`, `Send to ${downward.target.data.title}`)}</span>
            </button>
          </div>
        );
      })()}
      {contextMenu && (
        <div className="project-map-node-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button
            type="button"
            onClick={() => {
              const node = contextMenu.node;
              setContextMenu(null);
              void onDuplicateNode(node);
            }}
          >{text("复制公共记忆", "Duplicate public context")}</button>
        </div>
      )}
    </div>
  );
}
