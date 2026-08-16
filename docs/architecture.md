# Architecture

Knotline exposes one product surface: a Project Map plugin in the DeepSeek Harness sidebar.

## Operation path

```text
DSH sidebar.footer.action
  → shell.overlay
  → src/client/index.tsx reads ctx.workspaces.list and mounts web/src/App.tsx directly
  → the user selects an existing DSH Workspace project
  → web/src/project-map/ProjectMapView.tsx exposes Request, Agent, Skill, Backlog, Approval Pool, and Scheduled Trigger creation
  → React Flow connections resolve Request → Agent/Backlog, Agent → Agent/Backlog, Skill → Agent/Team, Scheduled Trigger → Agent/Team, or Artifact → Agent graph commands
  → server/graph-service.mjs + governance/knowledge/orchestration services
  → src/host/index.ts creates or resumes a real DSH Agent
  → database mutation + SSE
  → the same plugin Map refreshes with the observable result
```

## One workflow

```text
Request → classify → Agent / Backlog / Team → derived output + Task Bench → Pre-review Artifact → Delivery/Rework
```

- `ProjectMapView` owns the five root drawers (Request, Agent, Backlog, Approval Pool, Scheduled Trigger) plus the Skill picker, the Request/Scheduled Trigger composers, and connection resolution. Tasks, Workstreams, and Sessions remain internal records; NodeRuns appear only through Task Bench projections.
- The top Agent drawer creates a resumable DSH conversation at its canvas drop position; double-click rename updates the same Agent profile.
- Request creation uses a modal only after the drawer item lands on the canvas. No Agent work starts before a connection is made.
- Agent-to-Agent connection creates one Team Agent, two persistent member links, and derived Plan and Working Protocol documents.
- Before a Team assignment starts, both member conversations receive and record an internal discussion turn. The Team coordinator then receives their updated conversation surfaces and working settings before execution.
- Request-to-Agent connection classifies question, complex, or Debug work and derives Answer, Review Feedback/Plan, or Task Bench nodes from real execution state.
- Backlog connections persist worker and queue relations; an available connected Agent receives queued work, and completion schedules the next eligible Request.
- Scheduled Trigger connections persist `scheduled_for`; the Host-owned timer creates a standalone NodeRun at each due time and sends the stored Prompt into the connected Agent or Team conversation. The Map page is not the clock owner.
- Execution completion creates a Pre-review Artifact; connecting it to another Agent starts a real review NodeRun in that Agent's conversation.
- `graph-service.mjs` is the command boundary for map relationships and governed transitions.
- `AgentOrchestrator` in `src/host/index.ts` owns DSH Sessions and NodeRuns.
- `database.mjs` stores the shared Task, Agent, Knowledge, Review, Delivery, Notification, node, and edge records.
- `/api/events` invalidates the map and notification center after changes.

Task records are retained because Workstreams and NodeRuns use them internally. They do not have a separate UI.

## Product boundary

The client bundle contains only the sidebar launcher and the directly mounted Map application. The former task list, board, dashboard, timeline, workflow editor, AI chat, task detail, operations console, standalone page, and iframe bridge are not built or routed.

The Host exposes `/knotline/map/api/*` for the plugin plus a single `/knotline/api/health` probe. `/knotline/map/` is intentionally unavailable as a page.
