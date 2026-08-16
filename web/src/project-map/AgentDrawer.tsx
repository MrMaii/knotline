import { useState, type DragEvent } from "react";
import { useKnotlineI18n } from "../i18n";

export const ROOT_NODE_DRAG_TYPE = "application/x-knotline-root-node";
export type RootNodeKind = "agent" | "request" | "backlog" | "approval" | "scheduled";

interface RootNodeDrawerProps {
  creating: boolean;
  kind: RootNodeKind;
  label: string;
  onActivate?: () => void;
  onConsumed?: () => void;
}

export function RootNodeDrawer({ creating, kind, label, onActivate, onConsumed }: RootNodeDrawerProps) {
  const { text } = useKnotlineI18n();
  const [dragging, setDragging] = useState(false);

  function startDrag(event: DragEvent<HTMLButtonElement>) {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(ROOT_NODE_DRAG_TYPE, kind);
    setDragging(true);
  }

  return (
    <div className={`project-map-root-drawer is-${kind}${dragging ? " is-dragging" : ""}`}>
      <button
        type="button"
        className="project-map-root-drawer-trigger"
        draggable={!creating}
        disabled={creating}
        aria-label={text(`向下拖出${label}卡片`, `Drag down to create a ${label} card`)}
        title={text("按住并向下拖到地图", "Hold and drag down onto the map")}
        onClick={() => {
          onActivate?.();
          onConsumed?.();
        }}
        onDragStart={startDrag}
        onDragEnd={() => {
          setDragging(false);
          onConsumed?.();
        }}
      >
        {label}
      </button>
      <div className="project-map-root-drawer-preview" aria-hidden="true">
        <span>{label}</span>
        <small>{text("拖到地图后创建", "Drop on the map to create")}</small>
      </div>
    </div>
  );
}
