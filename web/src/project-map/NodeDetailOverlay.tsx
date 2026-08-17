import { useEffect, useState } from "react";
import { getNodeRunTranscript, type NodeRunTranscriptLine } from "../api";
import { useKnotlineI18n } from "../i18n";
import { renderMarkdown } from "./markdown";
import type { ProjectMapNode } from "../types";

interface NodeDetailOverlayProps {
  node: ProjectMapNode;
  onClose: () => void;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Fullscreen reading surface: requests show their original words, reports read
// like a post, and agents expose the live conversation behind their run.
export function NodeDetailOverlay({ node, onClose }: NodeDetailOverlayProps) {
  const { text } = useKnotlineI18n();
  const details = node.data.details ?? {};
  const runtimeBinding = details.runtimeBinding && typeof details.runtimeBinding === "object"
    ? details.runtimeBinding as Record<string, unknown>
    : null;
  const transcriptRunId = node.entityType === "node_run"
    ? node.entityId
    : node.entityType === "agent_profile" && typeof runtimeBinding?.currentNodeRunId === "string"
      ? runtimeBinding.currentNodeRunId
      : null;
  const [transcript, setTranscript] = useState<NodeRunTranscriptLine[]>([]);

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
  const artifactContent = stringOf(details.content)
    || stringOf((details.artifact as Record<string, unknown> | undefined)?.content)
    || stringOf(details.summary)
    || node.data.subtitle;

  return (
    <div
      className="project-map-detail-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <article className="project-map-detail-page" role="dialog" aria-modal="true" aria-label={node.data.title}>
        <header>
          <div>
            <span>{node.data.kind}</span>
            <strong>{node.data.title}</strong>
            <small>{node.data.status}{typeof details.classification === "string" ? ` · ${details.classification}` : ""}</small>
          </div>
          <button type="button" onClick={onClose} aria-label={text("关闭", "Close")}>×</button>
        </header>
        {isRequest && (
          <section className="project-map-detail-body">
            <h4>{text("诉求原话", "Original request")}</h4>
            <blockquote>{node.data.subtitle || node.data.title}</blockquote>
            {criteria.length > 0 && (
              <>
                <h4>{text("验收标准", "Acceptance criteria")}</h4>
                <ol>{criteria.map((item, index) => <li key={index}>{item}</li>)}</ol>
              </>
            )}
          </section>
        )}
        {!isRequest && transcriptRunId === null && (
          <section className="project-map-detail-body is-markdown">
            {renderMarkdown(artifactContent)}
          </section>
        )}
        {transcriptRunId !== null && (
          <section className="project-map-detail-body">
            <h4>{text("Agent 正在输出", "Agent live output")}</h4>
            {transcript.length === 0
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
              )}
            <p className="project-map-detail-quiet">{text("这里是只读视图；要对话请在节点检查器中发送消息。", "Read-only view; message the Agent from the node inspector.")}</p>
          </section>
        )}
      </article>
    </div>
  );
}
