import { useCallback, useEffect, useState } from "react";
import {
  createProject,
  listProjects,
  resolveKnotlineUrl,
  setApiText,
  setCurrentUserActor,
} from "./api";
import {
  getKnotlineI18n,
  resolveKnotlineLanguage,
  KnotlineLanguageProvider,
} from "./i18n";
import { NotificationCenter } from "./project-map/NotificationCenter";
import { ProjectMapView } from "./project-map/ProjectMapView";
import { GlobalModelPicker } from "./GlobalModelPicker";
import knotlineMarkDark from "./assets/knotline-mark-dark.png";
import knotlineMarkLight from "./assets/knotline-mark-light.png";
import type { ActorIdentity, Project } from "./types";

type ConnectionState = "connecting" | "live" | "reconnecting";

interface AppProps {
  language?: string;
  user?: ActorIdentity;
  workspaces: DshWorkspace[];
  workspacesLoading: boolean;
  onClose?: () => void;
}

export interface DshWorkspace {
  id: string;
  title: string;
  path: string;
}

const MAP_EVENT_NAMES = [
  "project.created",
  "task.created",
  "task.updated",
  "task.moved",
  "task.relation.updated",
  "graph.node.updated",
  "graph.edge.updated",
  "graph.command.completed",
  "workstream.updated",
  "workstream.scope_changed",
  "review.requested",
  "review.completed",
  "delivery.created",
  "knowledge.updated",
  "node_run.queued",
  "node_run.updated",
  "agent.runtime.updated",
  "notification.created",
  "notification.updated",
] as const;

function workspaceProjectId(workspaceId: string): string {
  return `dsh-${workspaceId.toLowerCase()}`;
}

export function App({ language: languageInput, user, workspaces, workspacesLoading, onClose }: AppProps) {
  const language = resolveKnotlineLanguage(languageInput ?? navigator.language);
  const { text } = getKnotlineI18n(language);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState("");
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [mapRevision, setMapRevision] = useState(0);
  const [notificationRevision, setNotificationRevision] = useState(0);
  const [focus, setFocus] = useState<{ projectId: string; nodeId: string; requestId: number } | null>(null);
  const [bindingWorkspace, setBindingWorkspace] = useState(false);

  useEffect(() => setApiText(text), [text]);

  useEffect(() => {
    setCurrentUserActor(user);
  }, [user]);

  const refreshProjects = useCallback(async (signal?: AbortSignal) => {
    try {
      const nextProjects = (await listProjects(signal)).filter((project) => project.source === "local");
      if (signal?.aborted) return;
      setProjects(nextProjects);
      setError("");
    } catch (nextError) {
      if (!signal?.aborted) setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      if (!signal?.aborted) setLoadingProjects(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshProjects(controller.signal);
    return () => controller.abort();
  }, [refreshProjects]);

  useEffect(() => {
    if (selectedWorkspaceId && !workspaces.some((workspace) => workspace.id === selectedWorkspaceId)) {
      setSelectedWorkspaceId("");
      setSelectedProjectId("");
      setFocus(null);
    }
  }, [selectedWorkspaceId, workspaces]);

  useEffect(() => {
    const source = new EventSource(resolveKnotlineUrl("/api/events"));
    // Bursts of SSE events coalesce into one map refetch so concurrent agents
    // cannot trigger a refresh storm.
    let mapRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleMapRefresh = () => {
      if (mapRefreshTimer !== null) return;
      mapRefreshTimer = setTimeout(() => {
        mapRefreshTimer = null;
        setMapRevision((value) => value + 1);
      }, 250);
    };
    const handleEvent = (event: Event) => {
      const message = event as MessageEvent<string>;
      let projectId: string | undefined;
      try {
        const payload = JSON.parse(message.data) as { projectId?: string; project?: { id?: string } };
        projectId = payload.projectId ?? payload.project?.id;
      } catch {}
      if (event.type === "project.created") void refreshProjects();
      if (event.type.startsWith("notification.")) setNotificationRevision((value) => value + 1);
      if (!projectId || projectId === selectedProjectId) scheduleMapRefresh();
    };
    MAP_EVENT_NAMES.forEach((name) => source.addEventListener(name, handleEvent));
    source.onopen = () => setConnection("live");
    source.onerror = () => setConnection("reconnecting");
    return () => {
      if (mapRefreshTimer !== null) clearTimeout(mapRefreshTimer);
      MAP_EVENT_NAMES.forEach((name) => source.removeEventListener(name, handleEvent));
      source.close();
    };
  }, [refreshProjects, selectedProjectId]);

  async function selectWorkspace(workspaceId: string) {
    setSelectedWorkspaceId(workspaceId);
    setSelectedProjectId("");
    setFocus(null);
    if (!workspaceId) return;
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return;
    const projectId = workspaceProjectId(workspace.id);
    setBindingWorkspace(true);
    try {
      let project = projects.find((candidate) => candidate.id === projectId);
      if (!project) {
        const createdProject = await createProject({
          id: projectId,
          name: workspace.title,
          workspacePath: workspace.path,
        });
        project = createdProject;
        setProjects((current) => current.some((candidate) => candidate.id === createdProject.id)
          ? current
          : [...current, createdProject]);
      }
      setSelectedProjectId(project.id);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBindingWorkspace(false);
    }
  }

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;

  return (
    <KnotlineLanguageProvider language={language}>
      <div className="map-app">
        <header className="map-app-header">
          <div className="map-app-brand">
            <span className="map-app-mark" aria-hidden="true">
              <img className="map-app-mark-light" src={knotlineMarkLight} alt="" />
              <img className="map-app-mark-dark" src={knotlineMarkDark} alt="" />
            </span>
            <div><strong>{text("结绳", "Knotline")}</strong><small>{text("Knotline", "结绳")}</small></div>
          </div>
          {selectedProject && (
            <div className="map-app-project">
              <span className="map-app-project-name">
                {workspaces.find((workspace) => workspace.id === selectedWorkspaceId)?.title ?? selectedProject.name}
              </span>
              <button
                type="button"
                className="map-app-project-switch"
                disabled={bindingWorkspace}
                onClick={() => {
                  setPendingWorkspaceId(selectedWorkspaceId);
                  setSelectedWorkspaceId("");
                  setSelectedProjectId("");
                }}
              >
                {text("切换工作区", "Switch workspace")}
              </button>
            </div>
          )}
          <div className="map-app-actions">
            <GlobalModelPicker />
            <span className={`map-app-connection is-${connection}`} title={connection} />
            <NotificationCenter
              projectId={selectedProjectId || null}
              revision={notificationRevision}
              onOpenNode={(projectId, nodeId) => {
                if (projectId !== selectedProjectId) return;
                setFocus((current) => ({ projectId, nodeId, requestId: (current?.requestId ?? 0) + 1 }));
              }}
            />
            {onClose && (
              <button type="button" className="map-app-close" onClick={onClose}>
                {text("返回聊天", "Back to chat")}
              </button>
            )}
          </div>
        </header>
        {error && <div className="map-app-error" role="alert">{error}</div>}
        <main className="map-app-main">
          {loadingProjects || workspacesLoading ? (
            <div className="map-app-empty">{text("正在读取 DeepSeek 工作区…", "Reading DeepSeek workspaces…")}</div>
          ) : workspaces.length === 0 ? (
            <div className="map-app-empty">
              <strong>{text("先在 DeepSeek Harness 创建工作区项目", "Create a workspace project in DeepSeek Harness first")}</strong>
              <span>{text("Knotline 只使用已有工作区，不在插件内创建项目。", "Knotline only uses existing workspaces; projects are not created inside the plugin.")}</span>
            </div>
          ) : bindingWorkspace ? (
            <div className="map-app-empty">{text("正在连接项目地图…", "Connecting the project map…")}</div>
          ) : selectedProject ? (
            <ProjectMapView
              key={selectedProject.id}
              projectId={selectedProject.id}
              workspacePath={selectedProject.workspacePath ?? ""}
              revision={mapRevision}
              focusNodeId={focus?.projectId === selectedProject.id ? focus.nodeId : null}
              focusRequest={focus?.requestId}
            />
          ) : (
            <div className="map-app-workspace-picker">
              <header>
                <span className="map-app-mark is-large" aria-hidden="true">
                  <img className="map-app-mark-light" src={knotlineMarkLight} alt="" />
                  <img className="map-app-mark-dark" src={knotlineMarkDark} alt="" />
                </span>
                <h1>{text("选择一个工作区，开始结绳", "Choose a workspace to start Knotline")}</h1>
                <p>{text("结绳只使用已有的 DeepSeek 工作区。诉求、Agent 和交付都会记录在你选中的项目里。", "Knotline uses existing DeepSeek workspaces. Requests, agents, and deliveries are recorded in the project you choose.")}</p>
              </header>
              <div className="map-app-workspace-grid">
                {workspaces.map((workspace, index) => (
                  <button
                    type="button"
                    key={workspace.id}
                    className={pendingWorkspaceId === workspace.id ? "is-selected" : ""}
                    style={{ animationDelay: `${Math.min(index * 60, 420)}ms` }}
                    onClick={() => setPendingWorkspaceId(workspace.id)}
                    onDoubleClick={() => void selectWorkspace(workspace.id)}
                  >
                    <strong>{workspace.title}</strong>
                    <small>{workspace.path}</small>
                    <i aria-hidden="true" />
                  </button>
                ))}
              </div>
              <footer>
                <button
                  type="button"
                  className="map-app-workspace-confirm"
                  disabled={!pendingWorkspaceId || bindingWorkspace}
                  onClick={() => void selectWorkspace(pendingWorkspaceId)}
                >
                  {bindingWorkspace ? text("正在进入…", "Entering…") : text("进入结绳", "Enter Knotline")}
                  <span aria-hidden="true">→</span>
                </button>
              </footer>
            </div>
          )}
        </main>
      </div>
    </KnotlineLanguageProvider>
  );
}
