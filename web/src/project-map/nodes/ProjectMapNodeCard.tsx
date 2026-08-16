import { memo, useEffect, useState, type ReactNode } from "react";
import {
  Brain,
  BellRinging,
  Bug,
  ChatCenteredText,
  CheckCircle,
  Clock,
  ClipboardText,
  FileText,
  ListChecks,
  Pulse,
  PuzzlePiece,
  SealCheck,
  Stack,
  Tray,
  UsersThree,
} from "@phosphor-icons/react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useKnotlineI18n } from "../../i18n";
import type { ProjectMapNode as ProjectMapNodeRecord } from "../../types";

export type ProjectMapCanvasNode = Node<{
  record: ProjectMapNodeRecord;
  onRenameAgent: (node: ProjectMapNodeRecord, name: string) => Promise<void>;
  onToggleScheduledTrigger: (node: ProjectMapNodeRecord, enabled: boolean) => Promise<void>;
}>;

const ACTIVE_STATUSES = new Set(["working", "running", "queued", "generating", "in_progress"]);

function initials(value: string) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words.slice(0, 2).map((word) => word[0]).join("") : value.slice(0, 2)).toUpperCase();
}

function textValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function nodeVariant(record: ProjectMapNodeRecord) {
  if (record.entityType === "agent_profile") return record.data.kind === "Team" ? "team" : "agent";
  if (record.entityType === "skill") return "skill";
  if (record.entityType === "scheduled_trigger") return "scheduled";
  if (record.entityType === "demand") {
    const classification = textValue(record.data.details?.classification, "general");
    return `request-${classification === "unclassified" ? "intake" : classification}`;
  }
  if (record.entityType === "backlog_pool") return "backlog";
  if (record.entityType === "approval_pool") return "approval";
  if (record.entityType === "knowledge_asset" && record.data.kind === "Context Document") return "context-document";
  if (record.entityType === "node_run") return "run";
  if (record.entityType === "notification") return "notification";
  if (record.entityType === "request_artifact" && record.data.kind === "Answer") return "answer";
  if (record.entityType === "request_artifact" && record.data.kind === "Approval Proposal") return "approval-item";
  if (["request_artifact", "review_gate", "delivery"].includes(record.entityType)) return "artifact";
  return "document";
}

function NodeHandles() {
  const { text } = useKnotlineI18n();
  return (
    <>
      <Handle
        id="left"
        type="source"
        position={Position.Left}
        className="project-map-node-handle is-target"
        aria-label={text("从左侧连线", "Connect from left side")}
      />
      <Handle
        id="right"
        type="source"
        position={Position.Right}
        className="project-map-node-handle is-source"
        aria-label={text("从节点连线", "Connect from node")}
      />
    </>
  );
}

export const ProjectMapNodeCard = memo(function ProjectMapNodeCard({ data, selected }: NodeProps<ProjectMapCanvasNode>) {
  const { text } = useKnotlineI18n();
  const { record, onRenameAgent, onToggleScheduledTrigger } = data;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(record.data.title);
  const variant = nodeVariant(record);
  const status = record.data.status.replaceAll("_", " ");
  const active = ACTIVE_STATUSES.has(record.data.status) || record.data.status === "enabled";
  const agentRunning = record.data.status === "working";
  const details = record.data.details ?? {};

  useEffect(() => setName(record.data.title), [record.data.title]);

  function commitName() {
    if (!editing) return;
    setEditing(false);
    const nextName = name.trim();
    if (!nextName || nextName === record.data.title) {
      setName(record.data.title);
      return;
    }
    void onRenameAgent(record, nextName);
  }

  const title: ReactNode = editing ? (
    <input
      className="project-map-node-name-input nodrag nopan"
      value={name}
      maxLength={120}
      autoFocus
      aria-label={text("Agent 名称", "Agent name")}
      onChange={(event) => setName(event.target.value)}
      onBlur={commitName}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commitName();
        }
        if (event.key === "Escape") {
          setName(record.data.title);
          setEditing(false);
        }
      }}
    />
  ) : <strong className="project-map-node-title">{record.data.title}</strong>;

  let content: ReactNode;

  if (variant === "agent") {
    const directQueueCount = typeof details.directQueueCount === "number" ? details.directQueueCount : 0;
    const queueSeverity = directQueueCount >= 6 ? "danger" : directQueueCount >= 3 ? "warning" : "healthy";
    const directQueueTitles = stringList(details.directQueueTitles);
    content = (
      <>
        <div className="project-map-agent-identity">
          <span className="project-map-agent-avatar">{initials(record.data.title)}</span>
          <div>
            <span className="project-map-node-kicker">Agent</span>
            {title}
            <small>{record.data.skillId ?? record.data.subtitle}</small>
          </div>
          <i className={`project-map-status is-${record.data.status}`} aria-label={record.data.status} />
        </div>
        <div
          className={`project-map-agent-backlog is-${queueSeverity}`}
          title={directQueueTitles.join("\n") || text("暂无直连诉求等待", "No direct requests waiting")}
          aria-label={text(`${directQueueCount} 个直连诉求排队中`, `${directQueueCount} direct requests queued`)}
        >
          <span><ListChecks size={13} weight="bold" /> {text("直连队列", "Direct queue")}</span>
          <b>{directQueueCount}</b>
        </div>
        {agentRunning ? (
          <div className="project-map-agent-activity">
            <span><Pulse size={13} weight="bold" /> {text("正在运行", "Running now")}</span>
            <span>{text("实时", "Live")}</span>
            <div><i /></div>
            <small>{record.data.subtitle}</small>
          </div>
        ) : (
          <footer className="project-map-agent-resting">
            <span>{record.data.live ? text("就绪", "Ready") : record.data.role ?? "Agent"}</span>
            <span>{status}</span>
          </footer>
        )}
      </>
    );
  } else if (variant === "team") {
    const members = Array.isArray(details.teamMembers)
      ? details.teamMembers.filter((member): member is Record<string, unknown> => Boolean(member) && typeof member === "object")
      : [];
    content = (
      <>
        <header className="project-map-node-eyebrow"><span><UsersThree size={15} weight="fill" /> Team</span><span>{status}</span></header>
        {title}
        <div className="project-map-team-members">
          {(members.length ? members : record.data.subtitle.split("+").map((member) => ({ name: member.trim() })))
            .slice(0, 4)
            .map((member, index) => {
              const memberName = textValue(member.name, `A${index + 1}`);
              return <span key={`${memberName}-${index}`} title={memberName}>{initials(memberName)}</span>;
            })}
        </div>
        <div className="project-map-team-protocol"><Stack size={14} weight="bold" /><span>{record.data.skillId ?? text("共享协作协议", "Shared protocol")}</span><b>{text(`${members.length || 2} 名成员`, `${members.length || 2} members`)}</b></div>
      </>
    );
  } else if (variant.startsWith("request-")) {
    const classification = variant.slice("request-".length);
    const criteria = stringList(details.acceptanceCriteria);
    const RequestIcon = classification === "debug"
      ? Bug
      : classification === "complex"
        ? ListChecks
        : classification === "context"
          ? Brain
          : ChatCenteredText;
    content = (
      <>
        <header className="project-map-node-eyebrow">
          <span><RequestIcon size={15} weight="bold" /> {text("诉求", "Request")} · {classification}</span>
          <i className={`project-map-status is-${record.data.status}`} aria-label={record.data.status} />
        </header>
        {title}
        {classification === "complex" ? (
          <div className="project-map-criteria">
            {(criteria.length ? criteria : [record.data.subtitle]).slice(0, 2).map((criterion, index) => (
              <span key={`${criterion}-${index}`}><b>{index + 1}</b>{criterion}</span>
            ))}
          </div>
        ) : classification === "debug" ? (
          <div className="project-map-debug-console">
            <span><b>&gt;</b>{record.data.subtitle}</span>
            <span><b>&gt;</b>{text(`状态：${status}`, `Status: ${status}`)}</span>
          </div>
        ) : classification === "context" ? (
          <div className="project-map-context-request"><Brain size={17} weight="duotone" /><span>{record.data.subtitle}</span></div>
        ) : <p className="project-map-node-copy">{record.data.subtitle}</p>}
        <footer className="project-map-request-footer"><span>{status}</span><span>{text(`${criteria.length} 项验收`, `${criteria.length} checks`)}</span></footer>
      </>
    );
  } else if (variant === "backlog") {
    const queuedRequests = stringList(details.queuedRequests);
    const processedRequests = stringList(details.processedRequests);
    const workers = stringList(details.workers);
    content = (
      <>
        <header className="project-map-backlog-heading">
          <span><Tray size={18} weight="duotone" /> {text("积压池", "Backlog Pool")}</span>
          <b>{text(`${queuedRequests.length} 排队 · ${processedRequests.length} 已处理`, `${queuedRequests.length} queued · ${processedRequests.length} processed`)}</b>
        </header>
        {title}
        <div className="project-map-backlog-queue">
          {(queuedRequests.length
            ? queuedRequests
            : processedRequests.length
              ? [text(`已处理 ${processedRequests.length} 个诉求`, `${processedRequests.length} requests processed`)]
              : [text("等待接收诉求", "Ready for incoming requests")])
            .slice(0, 3).map((item, index) => (
            <span key={`${item}-${index}`}><i>{index + 1}</i>{item}</span>
          ))}
        </div>
        <footer><span>{text(`${workers.length} 个 Agent 已连接`, `${workers.length} Agents attached`)}</span><span>{status}</span></footer>
      </>
    );
  } else if (variant === "approval") {
    const pendingApprovals = stringList(details.pendingApprovals);
    const routedApprovals = stringList(details.routedApprovals);
    const readers = stringList(details.readers);
    const writers = stringList(details.writers);
    content = (
      <>
        <header className="project-map-approval-heading">
          <span><SealCheck size={19} weight="duotone" /> {text("审批池", "Approval Pool")}</span>
          <b>{text(`${pendingApprovals.length} 待审批 · ${routedApprovals.length} 已流转`, `${pendingApprovals.length} pending · ${routedApprovals.length} routed`)}</b>
        </header>
        {title}
        <div className="project-map-approval-modes">
          <span><b>{writers.length}</b> {text("存入", "Deposit")}</span>
          <i />
          <span><b>{readers.length}</b> {text("抽取", "Pull")}</span>
        </div>
        <div className="project-map-approval-stack">
          {(pendingApprovals.length
            ? pendingApprovals
            : routedApprovals.length
              ? [text(`已流转 ${routedApprovals.length} 份计划`, `${routedApprovals.length} proposals routed`)]
              : [text("等待审批提案", "Waiting for approval proposals")])
            .slice(0, 2).map((item) => (
            <span key={item}><SealCheck size={13} weight="fill" />{item}</span>
          ))}
        </div>
        <footer><span>{text("受信执行闸门", "Trusted execution gate")}</span><span>{status}</span></footer>
      </>
    );
  } else if (variant === "approval-item") {
    content = (
      <>
        <header className="project-map-node-eyebrow">
          <span><SealCheck size={16} weight="fill" /> {text("审批提案", "Approval Proposal")}</span>
          <span>{status}</span>
        </header>
        {title}
        <p className="project-map-node-copy">{record.data.subtitle}</p>
        <footer className="project-map-approval-item-footer"><span>{text("已存入待审批", "Stored for approval")}</span><SealCheck size={17} weight="duotone" /></footer>
      </>
    );
  } else if (variant === "skill") {
    content = (
      <>
        <header className="project-map-node-eyebrow">
          <span><PuzzlePiece size={16} weight="fill" /> {text("已安装 Skill", "Installed Skill")}</span>
          <b>{textValue(details.scope, "system")}</b>
        </header>
        <div className="project-map-skill-identity">
          <span><PuzzlePiece size={22} weight="duotone" /></span>
          <div>{title}<small>/{textValue(details.skillId, record.data.skillId ?? "skill")}</small></div>
        </div>
        <p className="project-map-node-copy">{record.data.subtitle}</p>
        <footer className="project-map-skill-footer"><span>{text("拖到 Agent 或 Team 上", "Drag into Agent or Team")}</span><PuzzlePiece size={15} weight="fill" /></footer>
      </>
    );
  } else if (variant === "scheduled") {
    const enabled = details.enabled === true;
    const intervalMinutes = typeof details.intervalMinutes === "number" ? details.intervalMinutes : 0;
    const targetCount = typeof details.targetCount === "number" ? details.targetCount : 0;
    const nextTriggerAt = textValue(details.nextTriggerAt);
    const lastRunSummary = textValue(details.lastRunSummary);
    const nextLabel = nextTriggerAt
      ? new Date(nextTriggerAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : text("等待连接", "Waiting for connection");
    content = (
      <>
        <header className="project-map-scheduled-heading">
          <span><Clock size={17} weight="duotone" /> {text("定时触发", "Scheduled Trigger")}</span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={enabled ? text("暂停定时触发", "Pause scheduled trigger") : text("启用定时触发", "Enable scheduled trigger")}
            className={`project-map-scheduled-switch nodrag nopan${enabled ? " is-on" : ""}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              void onToggleScheduledTrigger(record, !enabled);
            }}
          ><i /></button>
        </header>
        {title}
        <p className="project-map-node-copy">{lastRunSummary || record.data.subtitle}</p>
        <div className="project-map-scheduled-meter">
          <span><b>{intervalMinutes}</b> {text("分钟", "min")}</span>
          <i />
          <span>{text(`${targetCount} 个目标`, `${targetCount} target${targetCount === 1 ? "" : "s"}`)}</span>
        </div>
        <footer>
          <span>{enabled ? text(`下次 ${nextLabel}`, `Next ${nextLabel}`) : text("已暂停", "Paused")}</span>
          <span>{targetCount ? text("已连接", "Connected") : text("连接 Agent 或 Team", "Connect Agent or Team")}</span>
        </footer>
      </>
    );
  } else if (variant === "context-document") {
    const bindings = Array.isArray(details.bindings) ? details.bindings : [];
    const contextCopy = textValue(
      details.currentVersionData && typeof details.currentVersionData === "object"
        ? (details.currentVersionData as Record<string, unknown>).content
        : "",
      record.data.subtitle,
    );
    content = (
      <>
        <header className="project-map-context-heading">
          <span><Brain size={18} weight="duotone" /> {text("公共记忆", "Public Context")}</span>
          <b>v{String(details.currentVersion ?? 1)}</b>
        </header>
        {title}
        <p className="project-map-node-copy">{contextCopy}</p>
        <footer className="project-map-context-footer"><span>{text("可复用记忆", "Reusable memory")}</span><span>{text(`${bindings.length} 个 Agent`, `${bindings.length} Agent${bindings.length === 1 ? "" : "s"}`)}</span></footer>
      </>
    );
  } else if (variant === "run") {
    content = (
      <>
        <header className="project-map-node-eyebrow"><span><Pulse size={15} weight="bold" /> {text("任务台", "Task Bench")}</span><span>{status}</span></header>
        {title}
        <p className="project-map-node-copy">{textValue(details.agentName, record.data.subtitle)}</p>
        <div className="project-map-run-track"><i className={active ? "is-active" : ""} /></div>
        <footer><span>{active ? text("处理中", "Processing") : text("运行记录", "Run record")}</span><span>{status}</span></footer>
      </>
    );
  } else if (variant === "answer") {
    content = (
      <>
        <header className="project-map-node-eyebrow"><span><ChatCenteredText size={15} weight="fill" /> {text("Agent 回答", "Agent Answer")}</span><CheckCircle size={16} weight="fill" /></header>
        {title}
        <blockquote>{record.data.subtitle}</blockquote>
        <footer><span>{text("Agent 结果", "Agent result")}</span><span>{status}</span></footer>
      </>
    );
  } else if (variant === "notification") {
    content = (
      <>
        <header className="project-map-notification-heading">
          <span><BellRinging size={17} weight="fill" /> {text("完成通知", "Completion notice")}</span>
          <b>{text("未读", "Unread")}</b>
        </header>
        {title}
        <p className="project-map-node-copy">{record.data.subtitle}</p>
        <footer className="project-map-notification-footer"><span>{text("点击阅读实施报告", "Click to read the report")}</span><CheckCircle size={16} weight="duotone" /></footer>
      </>
    );
  } else {
    const embeddedArtifact = details.artifact && typeof details.artifact === "object"
      ? details.artifact as Record<string, unknown>
      : null;
    const artifactCopy = textValue(embeddedArtifact?.summary, textValue(embeddedArtifact?.content, record.data.subtitle));
    const ArtifactIcon = variant === "artifact" ? ClipboardText : FileText;
    content = (
      <>
        <header className="project-map-node-eyebrow"><span><ArtifactIcon size={15} weight="duotone" /> {record.data.kind}</span><span>{status}</span></header>
        {title}
        <p className="project-map-node-copy">{artifactCopy}</p>
        <footer className="project-map-artifact-footer"><span>{variant === "artifact" ? text("审核检查点", "Review checkpoint") : text("参考", "Reference")}</span><CheckCircle size={16} weight="fill" /></footer>
      </>
    );
  }

  return (
    <article
      className={`project-map-node is-${variant}${active ? " is-active" : " is-inactive"}${selected ? " is-selected" : ""}`}
      data-node-variant={variant}
      onDoubleClick={(event) => {
        if (record.entityType !== "agent_profile") return;
        event.stopPropagation();
        setEditing(true);
      }}
    >
      <NodeHandles />
      {content}
    </article>
  );
});
