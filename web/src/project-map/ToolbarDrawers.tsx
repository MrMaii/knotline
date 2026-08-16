import { useState } from "react";
import { useKnotlineI18n } from "../i18n";
import type { ProjectCanvas } from "../types";
import { RootNodeDrawer, type RootNodeKind } from "./AgentDrawer";
import { SkillPicker } from "./NodePalette";

interface NodeDrawerProps {
  creating: boolean;
  workspacePath: string;
  onActivate: (kind: RootNodeKind) => void;
  onCreateSkill: (skillId: string) => Promise<void>;
}

const NODE_ENTRIES: Array<{ kind: RootNodeKind; chinese: string; english: string; hintChinese: string; hintEnglish: string }> = [
  { kind: "agent", chinese: "Agent 节点", english: "Agent node", hintChinese: "连诉求执行 · 连 Agent 组 Team", hintEnglish: "Link a Request to run · link an Agent to form a Team" },
  { kind: "request", chinese: "诉求节点", english: "Request node", hintChinese: "连 Agent 立即执行 · 连积压池排队", hintEnglish: "Link an Agent to run now · link a Backlog to queue" },
  { kind: "backlog", chinese: "积压池节点", english: "Backlog node", hintChinese: "收诉求排队 · 连 Agent 自动分配", hintEnglish: "Queues Requests · linked Agents auto-pull work" },
  { kind: "approval", chinese: "审批池节点", english: "Approval node", hintChinese: "存入计划待批 · 受信 Agent 抽取执行", hintEnglish: "Deposit plans · a trusted Agent pulls approved work" },
  { kind: "scheduled", chinese: "定时触发节点", english: "Schedule node", hintChinese: "连 Agent 或 Team 按频次发 Prompt", hintEnglish: "Sends its Prompt to an Agent or Team on schedule" },
];

export function NodeDrawer({ creating, workspacePath, onActivate, onCreateSkill }: NodeDrawerProps) {
  const { text } = useKnotlineI18n();
  const [open, setOpen] = useState(false);

  return (
    <div className="project-map-toolbar-drawer">
      <button
        type="button"
        className="project-map-toolbar-drawer-trigger is-node"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="project-map-toolbar-drawer-icon">＋</span>
        {text("节点", "Nodes")}
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <section className="project-map-toolbar-drawer-menu is-node" aria-label={text("节点抽屉", "Node drawer")}>
          <header>
            <strong>{text("获取节点", "Get a node")}</strong>
            <small>{text("点击快速创建，或拖到画布定位", "Click to create, or drag onto the canvas")}</small>
          </header>
          <div className="project-map-node-drawer-grid">
            {NODE_ENTRIES.map((entry) => (
              <div key={entry.kind} className={`project-map-node-drawer-entry is-${entry.kind}`}>
                <RootNodeDrawer
                  creating={creating}
                  kind={entry.kind}
                  label={text(entry.chinese, entry.english)}
                  onActivate={() => onActivate(entry.kind)}
                  onConsumed={() => setOpen(false)}
                />
                <small>{text(entry.hintChinese, entry.hintEnglish)}</small>
              </div>
            ))}
            <div className="project-map-node-drawer-entry is-skill">
              <SkillPicker
                workspacePath={workspacePath}
                creating={creating}
                onCreate={async (skillId) => {
                  await onCreateSkill(skillId);
                  setOpen(false);
                }}
              />
              <small>{text("从已安装 Skill 中选择", "Choose from installed Skills")}</small>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

interface CanvasDrawerProps {
  canvases: ProjectCanvas[];
  currentCanvasId: string | null;
  busy: boolean;
  onSelect: (canvasId: string) => void;
  onCreate: () => void;
  onClear: () => void;
}

export function CanvasDrawer({ canvases, currentCanvasId, busy, onSelect, onCreate, onClear }: CanvasDrawerProps) {
  const { text } = useKnotlineI18n();
  const [open, setOpen] = useState(false);
  const current = canvases.find((canvas) => canvas.id === currentCanvasId) ?? null;

  return (
    <div className="project-map-toolbar-drawer">
      <button
        type="button"
        className="project-map-toolbar-drawer-trigger is-canvas"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="project-map-toolbar-drawer-icon">▦</span>
        {text("画布", "Canvas")}
        {current && <small>{current.name}</small>}
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <section className="project-map-toolbar-drawer-menu is-canvas" aria-label={text("画布抽屉", "Canvas drawer")}>
          <header>
            <strong>{text("项目画布", "Project canvases")}</strong>
            <small>{text("同一项目，内容彼此隔离", "Same project, isolated content")}</small>
          </header>
          <div className="project-map-canvas-list">
            {canvases.map((canvas) => (
              <button
                key={canvas.id}
                type="button"
                className={canvas.id === currentCanvasId ? "is-current" : ""}
                onClick={() => {
                  onSelect(canvas.id);
                  setOpen(false);
                }}
              >
                <span>{canvas.id === currentCanvasId ? "●" : "○"}</span>
                <strong>{canvas.name}</strong>
                {canvas.id === currentCanvasId && <small>{text("当前", "Current")}</small>}
              </button>
            ))}
          </div>
          <footer>
            <button
              type="button"
              className="is-primary"
              disabled={busy}
              onClick={() => {
                onCreate();
                setOpen(false);
              }}
            >
              {text("＋ 新建画布", "+ New canvas")}
            </button>
            <button
              type="button"
              className="is-danger"
              disabled={busy || !currentCanvasId}
              onClick={() => {
                onClear();
                setOpen(false);
              }}
            >
              {text("清空当前画布", "Clear current canvas")}
            </button>
          </footer>
        </section>
      )}
    </div>
  );
}
