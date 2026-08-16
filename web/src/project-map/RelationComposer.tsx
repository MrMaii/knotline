import { useEffect, useState } from "react";
import { useKnotlineI18n } from "../i18n";
import type { GraphComposeResolution, GraphRelationCandidate } from "../types";

interface RelationComposerProps {
  resolution: GraphComposeResolution;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: (candidate: GraphRelationCandidate, customLabel: string) => Promise<void>;
}

export function RelationComposer({ resolution, submitting, onCancel, onConfirm }: RelationComposerProps) {
  const { language, text } = useKnotlineI18n();
  const [selectedId, setSelectedId] = useState(resolution.candidates[0]?.id ?? "");
  const [customLabel, setCustomLabel] = useState("");
  useEffect(() => setSelectedId(resolution.candidates[0]?.id ?? ""), [resolution]);
  const selected = resolution.candidates.find((candidate) => candidate.id === selectedId);

  return (
    <aside className="relation-composer" aria-label={text("关系编排器", "Relation composer")}>
      <header>
        <div>
          <strong>{text("选择管理语义", "Choose management meaning")}</strong>
          <span>{resolution.source.title} → {resolution.target.title}</span>
        </div>
        <button type="button" onClick={onCancel} aria-label={text("关闭", "Close")}>×</button>
      </header>
      <div className="relation-composer-options">
        {resolution.candidates.map((candidate) => (
          <label className={selectedId === candidate.id ? "is-selected" : ""} key={candidate.id}>
            <input
              type="radio"
              name="project-map-relation"
              value={candidate.id}
              checked={selectedId === candidate.id}
              onChange={() => setSelectedId(candidate.id)}
            />
            <span>{language === "zh" ? candidate.label : candidate.labelEn}</span>
          </label>
        ))}
      </div>
      {selected?.id === "custom" && (
        <input
          value={customLabel}
          onChange={(event) => setCustomLabel(event.target.value)}
          maxLength={64}
          placeholder={text("关系名称", "Relation name")}
          autoFocus
        />
      )}
      <footer>
        <button type="button" onClick={onCancel}>{text("取消", "Cancel")}</button>
        <button
          type="button"
          disabled={!selected || submitting || (selected.id === "custom" && !customLabel.trim())}
          onClick={() => selected && void onConfirm(selected, customLabel.trim())}
        >
          {submitting ? text("执行中…", "Applying…") : text("创建关系", "Create relation")}
        </button>
      </footer>
    </aside>
  );
}
