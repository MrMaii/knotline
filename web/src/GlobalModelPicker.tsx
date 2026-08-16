import { Brain, CaretDown, CaretLeft, CaretRight, Check } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getGlobalModelDirectory, selectGlobalModel } from "./api";
import { useKnotlineI18n } from "./i18n";
import type { GlobalModelDirectory, ModelCatalogModel, ModelSelection } from "./types";

type ModelPane = "root" | "model" | "effort";

export function GlobalModelPicker() {
  const { text } = useKnotlineI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [directory, setDirectory] = useState<GlobalModelDirectory | null>(null);
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<ModelPane>("root");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function load(signal?: AbortSignal) {
    setLoading(true);
    try {
      setDirectory(await getGlobalModelDirectory(signal));
      setError("");
    } catch (nextError) {
      if (!signal?.aborted) setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setPane("root");
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [open]);

  const currentModel = useMemo(() => directory?.groups
    .find((group) => group.id === directory.current.provider)?.models
    .find((model) => model.id === directory.current.model), [directory]);
  const effectiveEffort = directory?.current.reasoningEffort ?? currentModel?.reasoning?.defaultEffort;
  const currentEffort = useMemo(() => currentModel?.reasoning?.efforts
    .find((effort) => effort.id === effectiveEffort), [currentModel, effectiveEffort]);
  const modelLabel = currentModel?.name ?? directory?.current.model ?? text("模型", "Model");
  const effortLabel = currentEffort?.name ?? (directory?.current.reasoningEffort || "");

  async function choose(selection: ModelSelection) {
    setSaving(true);
    setError("");
    try {
      const selected = await selectGlobalModel(selection);
      setDirectory((current) => current ? { ...current, current: selected } : current);
      setOpen(false);
      setPane("root");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  }

  function chooseModel(provider: string, model: ModelCatalogModel) {
    const reasoningEffort = directory?.current.provider === provider && directory.current.model === model.id
      ? directory.current.reasoningEffort ?? model.reasoning?.defaultEffort
      : model.reasoning?.defaultEffort;
    void choose({
      provider,
      model: model.id,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    });
  }

  return (
    <div className="global-model-picker" ref={rootRef}>
      <button
        type="button"
        className="global-model-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={text(`全局模型：${modelLabel}${effortLabel ? `，${effortLabel}` : ""}`, `Global model: ${modelLabel}${effortLabel ? `, ${effortLabel}` : ""}`)}
        onClick={() => {
          setOpen((value) => !value);
          setPane("root");
          if (!open) void load();
        }}
      >
        <Brain size={16} weight="duotone" />
        <span><strong>{modelLabel}</strong>{effortLabel && <small>{effortLabel}</small>}</span>
        <CaretDown size={13} weight="bold" />
      </button>
      {open && (
        <section className="global-model-menu" role="menu" aria-label={text("选择全局模型", "Select global model")}>
          <header>
            {pane !== "root" ? (
              <button type="button" className="global-model-back" onClick={() => setPane("root")} aria-label={text("返回模型设置", "Back to model settings")}>
                <CaretLeft size={16} weight="bold" />
              </button>
            ) : <span><Brain size={18} weight="duotone" /></span>}
            <div>
              <strong>{pane === "model"
                ? text("选择模型", "Select model")
                : pane === "effort" ? text("选择推理强度", "Select reasoning effort") : text("全局模型", "Global model")}</strong>
              <small>{pane === "root"
                ? text("应用到所有 Map Agent 的下一步", "Applies to every Map Agent's next step")
                : modelLabel}</small>
            </div>
          </header>
          {loading && <p className="global-model-status">{text("正在读取模型…", "Loading models…")}</p>}
          {!loading && error && <p className="global-model-status is-error" role="alert">{error}</p>}
          {!loading && pane === "root" && directory && (
            <div className="global-model-root-options">
              <button type="button" role="menuitem" onClick={() => setPane("model")}>
                <span>{text("模型", "Model")}</span><strong>{modelLabel}</strong><CaretRight size={15} weight="bold" />
              </button>
              {currentModel?.reasoning && (
                <button type="button" role="menuitem" onClick={() => setPane("effort")}>
                  <span>{text("推理强度", "Reasoning effort")}</span><strong>{effortLabel}</strong><CaretRight size={15} weight="bold" />
                </button>
              )}
            </div>
          )}
          {!loading && pane === "model" && directory?.groups.map((group) => (
            <div className="global-model-group" key={group.id}>
              <span>{group.name}</span>
              {group.models.map((model) => {
                const selected = directory.current.provider === group.id && directory.current.model === model.id;
                return (
                  <button key={model.id} type="button" role="menuitem" disabled={saving} onClick={() => chooseModel(group.id, model)}>
                    <span><strong>{model.name}</strong>{model.description && <small>{model.description}</small>}</span>
                    {selected && <Check size={16} weight="bold" />}
                  </button>
                );
              })}
            </div>
          ))}
          {!loading && pane === "effort" && directory && currentModel?.reasoning && (
            <div className="global-model-group is-effort">
              <span>{text("推理强度", "Reasoning effort")}</span>
              {currentModel.reasoning.defaultEffort === undefined && (
                <button type="button" role="menuitem" disabled={saving} onClick={() => void choose({ provider: directory.current.provider, model: directory.current.model })}>
                  <span><strong>{text("供应商默认", "Provider default")}</strong></span>
                  {effectiveEffort === undefined && <Check size={16} weight="bold" />}
                </button>
              )}
              {currentModel.reasoning.efforts.map((effort) => (
                <button key={effort.id} type="button" role="menuitem" disabled={saving} onClick={() => void choose({ provider: directory.current.provider, model: directory.current.model, reasoningEffort: effort.id })}>
                  <span><strong>{effort.name}</strong>{effort.description && <small>{effort.description}</small>}</span>
                  {effectiveEffort === effort.id && <Check size={16} weight="bold" />}
                </button>
              ))}
            </div>
          )}
          {!loading && pane === "model" && directory?.groups.length === 0 && (
            <p className="global-model-status">{text("没有可用模型", "No models available")}</p>
          )}
        </section>
      )}
    </div>
  );
}
