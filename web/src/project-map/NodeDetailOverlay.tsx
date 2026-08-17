import { useEffect, useRef, useState } from "react";
import { getNodeRunTranscript, type NodeRunTranscriptLine } from "../api";
import { useKnotlineI18n } from "../i18n";
import { renderMarkdown } from "./markdown";
import type { ProjectMapNode } from "../types";

interface NodeDetailOverlayProps {
  node: ProjectMapNode;
  nodes: ProjectMapNode[];
  onClose: () => void;
  onSendComment: (agentProfileId: string, message: string) => Promise<void>;
}

interface StoredComment {
  id: string;
  text: string;
  at: string;
  relayed: boolean;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function initials(value: string) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words.slice(0, 2).map((word) => word[0]).join("") : value.slice(0, 2)).toUpperCase();
}

function TypewriterLine({ line, animate }: { line: string; animate: boolean }) {
  const [shown, setShown] = useState(animate ? 0 : line.length);
  useEffect(() => {
    if (!animate) {
      setShown(line.length);
      return;
    }
    setShown(0);
    const timer = setInterval(() => {
      setShown((current) => {
        if (current >= line.length) {
          clearInterval(timer);
          return current;
        }
        return current + 2;
      });
    }, 28);
    return () => clearInterval(timer);
  }, [line, animate]);
  return <p>{line.slice(0, shown)}</p>;
}

function commentsKey(nodeId: string) {
  return `knotline.comments.${nodeId}`;
}

function readComments(nodeId: string): StoredComment[] {
  try {
    const raw = window.localStorage.getItem(commentsKey(nodeId));
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(parsed) ? parsed as StoredComment[] : [];
  } catch {
    return [];
  }
}

function writeComments(nodeId: string, comments: StoredComment[]): void {
  try {
    window.localStorage.setItem(commentsKey(nodeId), JSON.stringify(comments));
  } catch {
    // Private-mode storage failures only lose local history.
  }
}

// Fullscreen reading page in the spirit of a social post: author, content,
// comments below, and a status rail for the producing Agent.
export function NodeDetailOverlay({ node, nodes, onClose, onSendComment }: NodeDetailOverlayProps) {
  const { text } = useKnotlineI18n();
  const details = node.data.details ?? {};
  const contentRef = useRef<HTMLDivElement | null>(null);

  const producerAgentId = stringOf(details.agentProfileId)
    || stringOf((details.artifact as Record<string, unknown> | undefined)?.agentProfileId);
  const agentNode = producerAgentId
    ? nodes.find((candidate) => candidate.entityType === "agent_profile" && candidate.entityId === producerAgentId) ?? null
    : node.entityType === "agent_profile" ? node : null;
  const agentDetails = agentNode?.data.details ?? {};
  const agentBinding = agentDetails.runtimeBinding && typeof agentDetails.runtimeBinding === "object"
    ? agentDetails.runtimeBinding as Record<string, unknown>
    : null;
  const agentStatus = agentNode?.data.status ?? "unknown";
  const agentBusy = ["working", "running"].includes(agentStatus);
  const queueCount = typeof agentDetails.directQueueCount === "number" ? agentDetails.directQueueCount : 0;
  const queueTitles = Array.isArray(agentDetails.directQueueTitles)
    ? agentDetails.directQueueTitles.filter((item): item is string => typeof item === "string")
    : [];

  const transcriptRunId = node.entityType === "node_run"
    ? node.entityId
    : node.entityType === "agent_profile" && typeof agentBinding?.currentNodeRunId === "string"
      ? agentBinding.currentNodeRunId
      : null;
  const [transcript, setTranscript] = useState<NodeRunTranscriptLine[]>([]);
  const [comments, setComments] = useState<StoredComment[]>(() => readComments(node.id));
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [lastPostedId, setLastPostedId] = useState<string | null>(null);
  const [annotateAnchor, setAnnotateAnchor] = useState<{ x: number; y: number } | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => setComments(readComments(node.id)), [node.id]);

  useEffect(() => {
    if (!transcriptRunId) return;
    let cancelled = false;
    const load = async () => {
      const lines = await getNodeRunTranscript(transcriptRunId);
      if (!cancelled) setTranscript(lines);
    };
    void load();
    const timer = setInterval(() => void load(), 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [transcriptRunId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const isRequest = node.entityType === "demand";
  const criteria = Array.isArray(details.acceptanceCriteria)
    ? details.acceptanceCriteria.filter((item): item is string => typeof item === "string")
    : [];
  const content = stringOf(details.content)
    || stringOf((details.artifact as Record<string, unknown> | undefined)?.content)
    || stringOf(details.summary)
    || node.data.subtitle;

  function quoteSelection() {
    const selection = window.getSelection();
    const selected = selection?.toString().trim() ?? "";
    if (!selected || !contentRef.current || !selection || selection.rangeCount === 0) return;
    if (!contentRef.current.contains(selection.getRangeAt(0).commonAncestorContainer)) return;
    const quoted = selected.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
    setDraft((current) => (current ? `${current}\n\n${quoted}\n\n` : `${quoted}\n\n`));
    setAnnotateAnchor(null);
    setTimeout(() => {
      draftRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      draftRef.current?.focus();
    }, 60);
  }

  function handleContentMouseUp() {
    const selection = window.getSelection();
    const selected = selection?.toString().trim() ?? "";
    if (!selected || !selection || selection.rangeCount === 0
      || !contentRef.current?.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      setAnnotateAnchor(null);
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    setAnnotateAnchor({ x: rect.left + rect.width / 2, y: rect.top });
  }

  async function postComment() {
    const message = draft.trim();
    if (!message || posting) return;
    setPosting(true);
    try {
      let relayed = false;
      if (agentNode) {
        await onSendComment(
          agentNode.entityId,
          `关于「${node.data.title}」的读者评论，请阅读并在后续工作中回应：\n\n${message}`,
        );
        relayed = true;
      }
      const id = `${Date.now()}`;
      const next = [...comments, { id, text: message, at: new Date().toISOString(), relayed }];
      setComments(next);
      writeComments(node.id, next);
      setDraft("");
      setLastPostedId(id);
      setTimeout(() => {
        document.getElementById(`knotline-comment-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 80);
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="project-map-detail-page-full" role="dialog" aria-modal="true" aria-label={node.data.title}>
      <header className="project-map-detail-topbar">
        <button type="button" onClick={onClose} className="project-map-detail-back">←</button>
        <span>{node.data.kind}</span>
        <button type="button" onClick={onClose} className="project-map-detail-close" aria-label={text("关闭", "Close")}>×</button>
      </header>
      <div className="project-map-detail-columns">
        <main className="project-map-detail-main">
          <header className="project-map-detail-author">
            <span className="project-map-agent-avatar">{initials(agentNode?.data.title ?? "K")}</span>
            <div>
              <strong>{agentNode?.data.title ?? text("Knotline 项目", "Knotline project")}</strong>
              <small>
                {agentNode
                  ? text("产出了这份内容", "produced this content")
                  : text("项目记录", "project record")}
                {" · "}{node.data.status}
              </small>
            </div>
          </header>
          <h1 className="project-map-detail-title">{node.data.title}</h1>
          <div className="project-map-detail-content" ref={contentRef} onMouseUp={handleContentMouseUp}>
            {isRequest ? (
              <>
                <blockquote>{node.data.subtitle || node.data.title}</blockquote>
                {criteria.length > 0 && (
                  <>
                    <h4>{text("验收标准", "Acceptance criteria")}</h4>
                    <ol>{criteria.map((item, index) => <li key={index}>{item}</li>)}</ol>
                  </>
                )}
              </>
            ) : transcriptRunId !== null ? (
              transcript.length === 0
                ? <p className="project-map-detail-quiet">{text("暂无可读的会话内容。", "No conversation to read yet.")}</p>
                : (
                  <div className="project-map-transcript-lines is-fullscreen">
                    {transcript.map((line, index) => (
                      <article className={`is-${line.role}`} key={`${index}-${line.role}`}>
                        <b>{line.role === "user" ? text("你", "You") : line.role === "tool" ? text("工具", "Tool") : "Agent"}</b>
                        {line.role === "assistant"
                          ? <div className="is-markdown">{renderMarkdown(line.text)}</div>
                          : <p>{line.text}</p>}
                      </article>
                    ))}
                  </div>
                )
            ) : (
              <div className="is-markdown">{renderMarkdown(content)}</div>
            )}
          </div>
          <section className="project-map-detail-comments">
            <header>
              <strong>{text("评论", "Comments")}</strong>
              <button type="button" onClick={quoteSelection}>
                {text("引用选中内容", "Quote selection")}
              </button>
            </header>
            {comments.length === 0 && (
              <p className="project-map-detail-quiet">
                {text("还没有评论。选中正文可以引用批注。", "No comments yet. Select text above to quote it.")}
              </p>
            )}
            {comments.map((comment) => (
              <article key={comment.id} id={`knotline-comment-${comment.id}`} className="project-map-detail-comment">
                <b>{text("你", "You")}</b>
                <div className="is-markdown">{renderMarkdown(comment.text)}</div>
                <small>{new Date(comment.at).toLocaleString()}</small>
                {comment.relayed && agentNode && (
                  <div className="project-map-detail-reply">
                    <b>{agentNode.data.title}</b>
                    <TypewriterLine
                      animate={comment.id === lastPostedId}
                      line={queueCount > 0
                        ? text(
                          `${agentNode.data.title} 目前繁忙中，在处理你的评论之前，它还有 ${queueCount} 件事要干。我会在结束之后通知你。`,
                          `${agentNode.data.title} is busy: ${queueCount} items are ahead of your comment. You will be notified when it finishes.`,
                        )
                        : text(
                          `${agentNode.data.title} 已经读取到你的反馈，正在工作中，请稍等。我会在结束之后通知你。`,
                          `${agentNode.data.title} has read your feedback and is working on it. You will be notified when it finishes.`,
                        )}
                    />
                  </div>
                )}
              </article>
            ))}
            <footer>
              <textarea
                ref={draftRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={3}
                placeholder={agentNode
                  ? text("写下评论，发布后会回传给这个 Agent", "Write a comment; it is relayed to this Agent")
                  : text("写下评论", "Write a comment")}
              />
              <button type="button" className="is-primary" disabled={posting || !draft.trim()} onClick={() => void postComment()}>
                {posting ? text("发布中…", "Posting…") : text("发布评论", "Post comment")}
              </button>
            </footer>
          </section>
        </main>
        {agentNode && (
          <aside className="project-map-detail-rail">
            <section>
              <strong>{text("产出方", "Produced by")}</strong>
              <div className="project-map-detail-rail-agent">
                <span className="project-map-agent-avatar">{initials(agentNode.data.title)}</span>
                <div>
                  <b>{agentNode.data.title}</b>
                  <small>{stringOf(agentDetails.model) || agentNode.data.subtitle}</small>
                </div>
              </div>
            </section>
            <section>
              <strong>{text("当前状态", "Current state")}</strong>
              <p className={`project-map-detail-rail-state is-${agentBusy ? "busy" : agentStatus}`}>
                <i />
                {agentBusy
                  ? text("忙碌 · 正在执行任务", "Busy · executing")
                  : agentStatus === "idle"
                    ? text("空闲 · 可接受新工作", "Active · ready for work")
                    : agentStatus}
              </p>
              {queueCount > 0 && (
                <p className="project-map-detail-quiet">
                  {text(`急要事项：${queueCount} 个诉求排队中`, `Urgent: ${queueCount} requests queued`)}
                </p>
              )}
              {queueTitles.slice(0, 3).map((title, index) => (
                <p className="project-map-detail-rail-queue" key={index}><i>{index + 1}</i>{title}</p>
              ))}
            </section>
            {typeof agentBinding?.sessionId === "string" && (
              <section>
                <strong>{text("会话", "Session")}</strong>
                <p className="project-map-detail-quiet">{agentBinding.sessionId}</p>
              </section>
            )}
          </aside>
        )}
      </div>
      {annotateAnchor && (
        <button
          type="button"
          className="project-map-annotate-float"
          style={{ left: annotateAnchor.x, top: annotateAnchor.y }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={quoteSelection}
        >
          {text("批注", "Annotate")}
        </button>
      )}
    </div>
  );
}
