import { useEffect, useState } from "react";
import { actOnNotification, listNotifications, updateNotification } from "../api";
import { useKnotlineI18n } from "../i18n";
import type { ProjectNotification } from "../types";
import "./project-map.css";

interface NotificationCenterProps {
  projectId: string | null;
  revision: number;
  onOpenNode: (projectId: string, nodeId: string) => void;
}

export function NotificationCenter({ projectId, revision, onOpenNode }: NotificationCenterProps) {
  const { text } = useKnotlineI18n();

  function actionLabel(action: string) {
    switch (action) {
      case "ask": return text("提问", "Ask");
      case "reassign": return text("改派", "Reassign");
      case "postpone": return text("延期", "Postpone");
      case "approve": return text("通过", "Approve");
      case "reject": return text("驳回", "Reject");
      default: return action;
    }
  }
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ProjectNotification[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function refresh(signal?: AbortSignal) {
    if (!projectId) {
      setItems([]);
      return;
    }
    try {
      setItems((await listNotifications(signal)).filter((item) => item.projectId === projectId));
      setError("");
    } catch (nextError) {
      if (!signal?.aborted) setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [projectId, revision]);

  async function openItem(notification: ProjectNotification) {
    if (!notification.read) {
      try {
        const updated = await updateNotification(notification.id, { read: true });
        setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
      } catch {}
    }
    onOpenNode(notification.projectId, notification.graphNodeId);
    setOpen(false);
  }

  async function act(notification: ProjectNotification, action: string) {
    const reviewerOptions = Array.isArray(notification.context.reviewerOptions)
      ? notification.context.reviewerOptions as Array<{ id?: string; name?: string }>
      : [];
    let input: { comment?: string; reviewerAgentId?: string; dueAt?: string } = {};
    if (action === "ask") {
      const comment = window.prompt(text("输入追问内容", "Enter the review question"), "");
      if (!comment?.trim()) return;
      input = { comment: comment.trim() };
    }
    if (action === "reassign") {
      const choices = reviewerOptions.map((reviewer) => `${reviewer.name ?? reviewer.id}: ${reviewer.id}`).join("\n");
      const reviewerAgentId = window.prompt(text(
        `输入 Reviewer Agent ID：\n${choices}`,
        `Enter a Reviewer Agent ID:\n${choices}`,
      ), reviewerOptions[0]?.id ?? "");
      if (!reviewerAgentId?.trim()) return;
      input = { reviewerAgentId: reviewerAgentId.trim() };
    }
    if (action === "postpone") {
      const dueAt = window.prompt(text("延期到（日期或时间）", "Postpone until (date or time)"), "");
      if (!dueAt?.trim()) return;
      input = { dueAt: dueAt.trim() };
    }
    if (action === "approve" || action === "reject") {
      const comment = window.prompt(text("审核意见（可选）", "Review comment (optional)"), "") ?? "";
      input = { comment };
    }
    setPendingId(notification.id);
    try {
      const result = await actOnNotification(notification.id, action, input);
      setItems((current) => current.map((item) => item.id === result.notification.id ? result.notification : item));
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPendingId(null);
    }
  }

  const unread = items.filter((item) => !item.read).length;
  return (
    <div className="notification-center">
      <button
        type="button"
        className="icon-button notification-center-trigger"
        aria-label={text("通知中心", "Notification center")}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">⌁</span>
        {unread > 0 && <b>{unread > 99 ? "99+" : unread}</b>}
      </button>
      {open && (
        <aside className="notification-center-panel">
          <header>
            <div><strong>{text("通知中心", "Notification Center")}</strong><span>{items.length}</span></div>
            <button type="button" onClick={() => void refresh()}>{text("刷新", "Refresh")}</button>
          </header>
          {error && <div className="notification-center-error" role="alert">{error}</div>}
          <div className="notification-center-list">
            {items.length === 0 ? <p>{text("没有通知", "No notifications")}</p> : items.map((notification) => (
              <article className={`${notification.read ? "" : "is-unread"}${notification.handled ? " is-handled" : ""}`} key={notification.id}>
                <button type="button" className="notification-center-main" onClick={() => void openItem(notification)}>
                  <span>{notification.eventType}</span>
                  <strong>{notification.title}</strong>
                  <p>{notification.body}</p>
                  <small>{notification.reason}</small>
                  <em>{notification.impact}</em>
                </button>
                <footer>
                  {notification.actions.filter((action) => action !== "open").map((action) => (
                    <button
                      type="button"
                      disabled={pendingId === notification.id || notification.handled}
                      onClick={() => void act(notification, action)}
                      key={action}
                    >
                      {actionLabel(action)}
                    </button>
                  ))}
                </footer>
              </article>
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}
