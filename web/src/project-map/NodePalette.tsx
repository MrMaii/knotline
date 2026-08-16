import { ArrowUp, CaretDown, Clock, MagnifyingGlass, Plus, PuzzlePiece } from "@phosphor-icons/react";
import { useState, type FormEvent, type KeyboardEvent } from "react";
import { listInstalledSkills } from "../api";
import { useKnotlineI18n } from "../i18n";
import type { InstalledSkill } from "../types";

interface SkillPickerProps {
  workspacePath: string;
  creating: boolean;
  onCreate: (skillId: string) => Promise<void>;
}

export function SkillPicker({ workspacePath, creating, onCreate }: SkillPickerProps) {
  const { text } = useKnotlineI18n();
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<InstalledSkill[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const visibleSkills = skills.filter((skill) => (
    `${skill.label} ${skill.id} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase())
  ));

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setLoading(true);
    setError("");
    try {
      setSkills(await listInstalledSkills(workspacePath));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }

  async function choose(skillId: string) {
    try {
      await onCreate(skillId);
      setOpen(false);
      setQuery("");
    } catch {
      // The map-level error remains visible while the picker stays open for another choice.
    }
  }

  return (
    <div className="project-map-skill-picker">
      <button type="button" className="project-map-skill-trigger" disabled={creating} onClick={() => void toggle()}>
        <PuzzlePiece size={16} weight="fill" /> Skill <CaretDown size={13} weight="bold" />
      </button>
      {open && (
        <section className="project-map-skill-menu" aria-label={text("已安装的 Skill", "Installed Skills")}>
          <header>
            <span><PuzzlePiece size={18} weight="fill" /></span>
            <div><strong>{text("已安装的 Skill", "Installed Skills")}</strong><small>{text("选择后生成一个节点", "Choose one to create a node")}</small></div>
          </header>
          <label>
            <MagnifyingGlass size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={text("搜索 Skill", "Search Skills")}
              autoFocus
            />
          </label>
          <div className="project-map-skill-list">
            {loading && <p>{text("正在读取已安装 Skill…", "Loading installed Skills…")}</p>}
            {!loading && error && <p className="is-error">{error}</p>}
            {!loading && !error && visibleSkills.map((skill) => (
              <button key={skill.id} type="button" disabled={creating} onClick={() => void choose(skill.id)}>
                <span><PuzzlePiece size={16} weight="duotone" /></span>
                <div><strong>{skill.label}</strong><small>{skill.description || skill.id}</small></div>
                <em>{skill.scope}</em>
              </button>
            ))}
            {!loading && !error && visibleSkills.length === 0 && (
              <p>{text("没有匹配的已安装 Skill", "No installed Skills match")}</p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

interface RequestComposerProps {
  creating: boolean;
  onCancel: () => void;
  onCreate: (input: { title: string; description: string; acceptanceCriteria: string[] }) => Promise<void>;
}

export function RequestComposer({ creating, onCancel, onCreate }: RequestComposerProps) {
  const { text } = useKnotlineI18n();
  const [prompt, setPrompt] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = prompt.trim();
    if (!value) return;
    const title = value.split(/\r?\n/, 1)[0]?.trim().slice(0, 240) ?? value.slice(0, 240);
    await onCreate({
      title,
      description: value,
      acceptanceCriteria: [],
    });
    setPrompt("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <div className="project-map-request-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !creating) onCancel();
    }}>
      <form
        className="project-map-request-composer"
        role="dialog"
        aria-modal="true"
        aria-label={text("创建诉求", "Create request")}
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !creating) onCancel();
        }}
      >
        <label className="project-map-request-label" htmlFor="project-map-request-prompt">
          {text("创建诉求", "Create request")}
        </label>
        <textarea
          id="project-map-request-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
          rows={3}
          disabled={creating}
          placeholder={text("描述你想要构建的内容", "Describe what you want to build")}
        />
        <div className="project-map-request-controls">
          <span className="project-map-request-add" aria-hidden="true">
            <Plus size={22} weight="regular" />
          </span>
          <button
            type="submit"
            className="project-map-request-send"
            disabled={creating || !prompt.trim()}
            aria-label={creating ? text("正在创建诉求", "Creating request") : text("创建诉求", "Create request")}
          >
            <ArrowUp size={26} weight="bold" />
          </button>
        </div>
      </form>
    </div>
  );
}

interface ScheduledTriggerComposerProps {
  creating: boolean;
  onCancel: () => void;
  onCreate: (input: { prompt: string; intervalMinutes: number; enabled: boolean }) => Promise<void>;
}

export function ScheduledTriggerComposer({ creating, onCancel, onCreate }: ScheduledTriggerComposerProps) {
  const { text } = useKnotlineI18n();
  const [prompt, setPrompt] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [enabled, setEnabled] = useState(true);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || !Number.isInteger(intervalMinutes) || intervalMinutes < 1) return;
    await onCreate({ prompt: value, intervalMinutes, enabled });
  }

  return (
    <div className="project-map-request-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !creating) onCancel();
    }}>
      <form
        className="project-map-scheduled-composer"
        role="dialog"
        aria-modal="true"
        aria-label={text("创建定时触发", "Create scheduled trigger")}
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !creating) onCancel();
        }}
      >
        <header>
          <span><Clock size={22} weight="duotone" /></span>
          <div>
            <strong>{text("创建定时触发", "Create scheduled trigger")}</strong>
            <small>{text("连接到 Agent 或 Team 后定时输入 Prompt", "Connect to an Agent or Team to send this Prompt on schedule")}</small>
          </div>
        </header>
        <label>
          <span>Prompt</span>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={5}
            autoFocus
            disabled={creating}
            placeholder={text("输入每次触发时要交给 Agent 的内容", "Enter the Prompt sent on every trigger")}
          />
        </label>
        <div className="project-map-scheduled-settings">
          <label>
            <span>{text("触发频次", "Frequency")}</span>
            <span className="project-map-scheduled-interval">
              <input
                type="number"
                min={1}
                step={1}
                value={intervalMinutes}
                disabled={creating}
                onChange={(event) => setIntervalMinutes(Number(event.target.value))}
              />
              {text("分钟一次", "minutes")}
            </span>
          </label>
          <label className="project-map-scheduled-enable">
            <span>{text("创建后启用", "Enable after creation")}</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              className={enabled ? "is-on" : ""}
              disabled={creating}
              onClick={() => setEnabled((current) => !current)}
            ><i /></button>
          </label>
        </div>
        <footer>
          <button type="button" disabled={creating} onClick={onCancel}>{text("取消", "Cancel")}</button>
          <button type="submit" className="is-primary" disabled={creating || !prompt.trim() || intervalMinutes < 1}>
            {creating ? text("创建中…", "Creating…") : text("生成节点", "Create node")}
          </button>
        </footer>
      </form>
    </div>
  );
}
