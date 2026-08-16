import { useState } from "react";
import { useKnotlineI18n } from "../i18n";
import type { ProjectMapNode } from "../types";

interface MapInspectorProps {
  node: ProjectMapNode;
  deciding: boolean;
  controllingRun: boolean;
  onClose: () => void;
  onReview: (decision: "approved" | "rejected", comment: string) => Promise<void>;
  onAgentMessage: (mode: "followup" | "steer" | "inject", message: string) => Promise<void>;
  onRunControl: (action: "pause" | "resume") => Promise<void>;
  onDismissNotification: () => Promise<void>;
}

function DetailList({ label, value }: { label: string; value: unknown }) {
  if (!Array.isArray(value) || value.length === 0) return null;
  return (
    <section>
      <strong>{label}</strong>
      <ul>{value.map((item, index) => <li key={`${label}-${index}`}>{String(item)}</li>)}</ul>
    </section>
  );
}

function TextSection({ label, value }: { label: string; value: unknown }) {
  if (typeof value !== "string" || !value.trim()) return null;
  return (
    <section>
      <strong>{label}</strong>
      <p className="project-map-document-content">{value}</p>
    </section>
  );
}

function runResultOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

export function MapInspector({
  node,
  deciding,
  controllingRun,
  onClose,
  onReview,
  onAgentMessage,
  onRunControl,
  onDismissNotification,
}: MapInspectorProps) {
  const { text } = useKnotlineI18n();
  const [comment, setComment] = useState("");
  const [agentMessage, setAgentMessage] = useState("");
  const [sendingAgentMessage, setSendingAgentMessage] = useState(false);
  const details = node.data.details ?? {};
  const reviewPending = ["review_gate", "knowledge_proposal"].includes(node.entityType)
    && node.data.status === "pending";
  const reviewerAssigned = node.entityType === "knowledge_proposal"
    || typeof details.reviewerAgentId === "string" && details.reviewerAgentId.length > 0;
  const runtimeBinding = details.runtimeBinding && typeof details.runtimeBinding === "object"
    ? details.runtimeBinding as Record<string, unknown>
    : null;
  const teamMembers = Array.isArray(details.teamMembers)
    ? details.teamMembers as Array<Record<string, unknown>>
    : [];
  const contextDocuments = Array.isArray(details.contextDocuments)
    ? details.contextDocuments as Array<Record<string, unknown>>
    : [];
  const notificationContext = node.entityType === "notification" ? runResultOf(details.context) : null;
  const runResult = runResultOf(
    node.entityType === "node_run" ? details.result : node.entityType === "notification" ? details.runResult : null,
  );

  async function sendAgentMessage(mode: "followup" | "steer" | "inject") {
    if (!agentMessage.trim()) return;
    setSendingAgentMessage(true);
    try {
      await onAgentMessage(mode, agentMessage.trim());
      setAgentMessage("");
    } finally {
      setSendingAgentMessage(false);
    }
  }
  return (
    <aside className="project-map-inspector">
      <header>
        <div><span>{node.data.kind}</span><strong>{node.data.title}</strong></div>
        <button type="button" onClick={onClose} aria-label={text("关闭", "Close")}>×</button>
      </header>
      <dl>
        <div><dt>{text("状态", "Status")}</dt><dd>{node.data.status}</dd></div>
        <div><dt>{text("标识", "Identity")}</dt><dd>{node.entityId}</dd></div>
        {node.data.skillId && <div><dt>Skill</dt><dd>{node.data.skillId}</dd></div>}
        {node.entityType === "skill" && typeof details.scope === "string" && <div><dt>{text("范围", "Scope")}</dt><dd>{details.scope}</dd></div>}
        {typeof details.model === "string" && <div><dt>{text("模型", "Model")}</dt><dd>{details.model}</dd></div>}
        {typeof runtimeBinding?.sessionId === "string" && <div><dt>DSH Session</dt><dd>{runtimeBinding.sessionId}</dd></div>}
        {typeof runtimeBinding?.currentNodeRunId === "string" && <div><dt>{text("当前节点", "Current node")}</dt><dd>{runtimeBinding.currentNodeRunId}</dd></div>}
        {typeof details.goal === "string" && <div><dt>{text("目标", "Goal")}</dt><dd>{details.goal}</dd></div>}
        {typeof details.classification === "string" && <div><dt>{text("分类", "Classification")}</dt><dd>{details.classification}</dd></div>}
        {typeof details.agentName === "string" && <div><dt>Agent</dt><dd>{details.agentName}</dd></div>}
        {typeof details.intervalMinutes === "number" && <div><dt>{text("触发频次", "Frequency")}</dt><dd>{details.intervalMinutes} min</dd></div>}
        {typeof details.nextTriggerAt === "string" && <div><dt>{text("下次触发", "Next trigger")}</dt><dd>{new Date(details.nextTriggerAt).toLocaleString()}</dd></div>}
      </dl>
      {typeof details.content === "string" && details.content && (
        <section><strong>{text("内容", "Content")}</strong><p className="project-map-document-content">{details.content}</p></section>
      )}
      {node.entityType === "notification" && typeof details.reason === "string" && (
        <section><strong>{text("为什么通知你", "Why you were notified")}</strong><p className="project-map-document-content">{details.reason}</p></section>
      )}
      {node.entityType === "notification" && typeof details.impact === "string" && (
        <section><strong>{text("结果影响", "Impact")}</strong><p className="project-map-document-content">{details.impact}</p></section>
      )}
      <TextSection
        label={text("交付摘要", "Delivery summary")}
        value={node.entityType === "delivery" ? details.summary : node.entityType === "node_run" ? runResult?.summary : undefined}
      />
      <TextSection
        label={text("验证证据", "Validation evidence")}
        value={runResult?.evidence ?? notificationContext?.evidence ?? (node.entityType === "delivery" ? details.evidence : undefined)}
      />
      <TextSection label={text("Agent 完整回复", "Agent full reply")} value={runResult?.finalMessage} />
      {node.entityType === "scheduled_trigger" && (
        <TextSection label={text("最近一次完整回复", "Latest full reply")} value={details.lastRunFinalMessage} />
      )}
      {node.entityType === "skill" && typeof details.description === "string" && details.description && (
        <section><strong>{text("说明", "Description")}</strong><p className="project-map-document-content">{details.description}</p></section>
      )}
      {node.entityType === "scheduled_trigger" && typeof details.prompt === "string" && details.prompt && (
        <section><strong>Prompt</strong><p className="project-map-document-content">{details.prompt}</p></section>
      )}
      {node.entityType === "scheduled_trigger" && typeof details.lastRunSummary === "string" && details.lastRunSummary && (
        <section><strong>{text("最近一次结果", "Latest result")}</strong><p className="project-map-document-content">{details.lastRunSummary}</p></section>
      )}
      {node.entityType === "scheduled_trigger" && typeof details.lastRunEvidence === "string" && details.lastRunEvidence && (
        <section><strong>{text("结果证据", "Result evidence")}</strong><p className="project-map-document-content">{details.lastRunEvidence}</p></section>
      )}
      {typeof details.instruction === "string" && (
        <section><strong>{text("运行指令", "Run instruction")}</strong><p className="project-map-document-content">{details.instruction}</p></section>
      )}
      <DetailList label={text("范围", "Scope")} value={details.scope} />
      <DetailList label={text("排除项", "Exclusions")} value={details.exclusions} />
      <DetailList label={text("风险", "Risks")} value={details.risks} />
      <DetailList label={text("依赖", "Dependencies")} value={details.dependencies} />
      <DetailList label={text("验收标准", "Acceptance criteria")} value={details.acceptanceCriteria} />
      <DetailList label={text("交付物", "Deliverables")} value={details.deliverables} />
      <DetailList label={text("执行 Agent", "Worker Agents")} value={details.workers} />
      <DetailList label={text("积压队列", "Queued Requests")} value={details.queuedRequests} />
      <DetailList label={text("已处理事项", "Processed Requests")} value={details.processedRequests} />
      <DetailList label={text("待审批方案", "Pending Approvals")} value={details.pendingApprovals} />
      <DetailList label={text("已流转方案", "Routed Approvals")} value={details.routedApprovals} />
      {teamMembers.length > 0 && (
        <section>
          <strong>{text("Team 成员", "Team members")}</strong>
          <ul>{teamMembers.map((member) => {
            const memberBinding = member.runtimeBinding && typeof member.runtimeBinding === "object"
              ? member.runtimeBinding as Record<string, unknown>
              : null;
            return (
              <li key={String(member.id)}>
                {String(member.name)} · {String(member.skillId ?? member.role ?? "Agent")}
                {typeof memberBinding?.sessionId === "string" ? ` · ${memberBinding.sessionId}` : ""}
              </li>
            );
          })}</ul>
        </section>
      )}
      {node.entityType === "agent_profile" && (
        <section className="project-map-context-pool">
          <strong>{text("上下文池", "Context Pool")}</strong>
          {contextDocuments.length > 0 ? (
            <ul>{contextDocuments.map((document) => (
              <li key={String(document.id)}>
                <b>{String(document.title)}</b>
                <span>v{String(document.boundVersion ?? 1)} · {String(document.status ?? "current")}</span>
              </li>
            ))}</ul>
          ) : <p>{text("暂无公用上下文", "No public context yet")}</p>}
        </section>
      )}
      {(["agent_profile", "node_run"].includes(node.entityType)) && (runtimeBinding || node.entityType === "node_run") && (
        <section className="project-map-agent-actions">
          <strong>{text("运行控制", "Runtime control")}</strong>
          {node.entityType === "node_run" && ["running", "waiting_input"].includes(node.data.status) && (
            <button
              type="button"
              disabled={controllingRun}
              onClick={() => void onRunControl(node.data.status === "running" ? "pause" : "resume")}
            >
              {node.data.status === "running" ? text("暂停任务台", "Pause Task Bench") : text("继续任务台", "Resume Task Bench")}
            </button>
          )}
          <textarea
            value={agentMessage}
            onChange={(event) => setAgentMessage(event.target.value)}
            rows={3}
            placeholder={text("给 Agent 的结构化消息", "Structured message to the Agent")}
          />
          <div>
            <button type="button" disabled={sendingAgentMessage || !agentMessage.trim()} onClick={() => void sendAgentMessage("followup")}>
              {text("追加节点", "Follow up")}
            </button>
            <button type="button" disabled={sendingAgentMessage || !agentMessage.trim()} onClick={() => void sendAgentMessage("steer")}>
              {text("插队", "Steer")}
            </button>
            <button type="button" disabled={sendingAgentMessage || !agentMessage.trim()} onClick={() => void sendAgentMessage("inject")}>
              {text("注入下一步", "Inject")}
            </button>
          </div>
        </section>
      )}
      {reviewPending && (
        <section className="project-map-review-actions">
          <strong>{text("审核决定", "Review decision")}</strong>
          {!reviewerAssigned && <p>{text("先把独立 Reviewer 拖到 Workstream。", "Drag an independent Reviewer onto the Workstream first.")}</p>}
          <textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            rows={3}
            placeholder={text("审核意见", "Review comment")}
          />
          <div>
            <button type="button" disabled={!reviewerAssigned || deciding} onClick={() => void onReview("rejected", comment)}>
              {text("驳回", "Reject")}
            </button>
            <button type="button" disabled={!reviewerAssigned || deciding} onClick={() => void onReview("approved", comment)}>
              {text("批准", "Approve")}
            </button>
          </div>
        </section>
      )}
      {node.entityType === "notification" && (
        <section className="project-map-notification-actions">
          <button type="button" onClick={() => void onDismissNotification()}>
            {text("阅读完成，关闭通知", "Read and close notification")}
          </button>
        </section>
      )}
    </aside>
  );
}
