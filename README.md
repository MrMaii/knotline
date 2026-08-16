# Knotline

Knotline is a project operating map plugin for the DeepSeek Harness sidebar.

The product has one surface: Map. Demands, agents, project knowledge, execution, delivery, and review all live on the same canvas. There is no task list, board, dashboard, timeline, workflow editor, or separate operations console.

## The workflow

1. Select a project that already exists in the DeepSeek Harness workspace.
2. Create only six root node types: **Request**, **Agent**, **Skill**, **Backlog**, **Approval Pool**, and **Scheduled Trigger**. Every Agent owns a resumable DSH conversation.
3. Drag Request from the top drawer onto the canvas to open the blurred composer. Submitting creates an island node and does not execute it.
4. Connect Request to Agent. Automatic classification derives an Answer for questions, Review Feedback then Plan for complex work, or a live Task Bench for Debug in the selected workspace.
5. Capability routing creates a visible delegation edge when another Agent is a better match. Connecting two Agents derives a Team while retaining both member conversations and working methods.
6. Connect Requests and Agents to a Backlog to queue and assign work. Connect an Approval Pool to a trusted Agent to gate execution behind approved plans. Connect a Scheduled Trigger to an Agent or Team to send its Prompt on a persistent Host-owned interval.
7. Completion continues through a Pre-review Artifact, independent review, and Delivery.

Task, NodeRun, Session, Workstream, Knowledge, Review, and Notification records remain implementation primitives. They do not appear as user-created node types.

## Run

```powershell
npm install
npm run build
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add (Resolve-Path .).Path
npx @deepseek-ai/dsh@0.1.0-rc.6 web
```

Open the URL printed by DSH and select **Map** in the sidebar. The Map renders inside the DSH plugin layer. Knotline has no standalone page.

## Verify

```powershell
npm run check
npm run pack:check
```

See the Chinese [product requirements document](docs/PRD.md), [docs/architecture.md](docs/architecture.md) for the runtime path, and [docs/development.md](docs/development.md) for local development. 中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## License and provenance

Knotline is licensed under the [Apache License 2.0](LICENSE). It descends from the Dashi Taskboard codebase; [PROVENANCE.md](PROVENANCE.md) records what was carried forward and [NOTICE](NOTICE) carries the required attribution. Bundled third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Knotline is an independent community project and is not affiliated with, sponsored by, or endorsed by DeepSeek or the upstream Dashi Taskboard authors. Product names are used only to describe interoperability.
