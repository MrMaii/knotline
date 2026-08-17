<div align="center">

<img src="docs/assets/knotline-banner.svg" alt="运筹 Knotline — plan, execute, and review real agent work on one operating map" width="100%" />

<br/><br/>

[![License](https://img.shields.io/badge/license-Apache--2.0-6172f3)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-2e90fa)](package.json)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.1.0--rc.6-12b76a)](docs/compatibility.md)

**English** · [简体中文](README.zh-CN.md)

<br/>

Knotline (**运筹**) is a project operating map for the DeepSeek Harness sidebar.<br/>
Requests, agents, execution, review, and delivery live on one canvas — **a line is a command: it runs real agent work.**

</div>

<img src="docs/assets/divider.svg" width="100%" alt="" />

## One line runs one real execution

<div align="center">
<img src="docs/assets/demo-workflow.svg" width="92%" alt="A request connects to an agent, is classified, executes for real, and the answer grows on the map" />
</div>

Drag a Request onto the canvas and connect it to an Agent. Classification derives an Answer for questions, Review Feedback then a Plan for complex work, or a live Task Bench for Debug — then a **real, resumable DSH conversation** does the work. There is no fake execution: status only advances through structured lifecycle tools.

<img src="docs/assets/divider.svg" width="100%" alt="" />

## Everything a chat gives you, on the map

<table>
<tr>
<td width="50%" valign="top">
<img src="docs/assets/demo-transcript.svg" width="100%" alt="Live transcript" />
</td>
<td width="50%" valign="top">
<img src="docs/assets/demo-governance.svg" width="100%" alt="Governance flow" />
</td>
</tr>
<tr>
<td valign="top">

**Chat-grade visibility.** Running Task Benches embed a live transcript (you / agent / tools); finished work carries the **agent's full reply**, delivery summary, and validation evidence — nothing is lost.

</td>
<td valign="top">

**Governed by design.** Execution flows through a pre-review artifact and an **independent reviewer** — self-approval is rejected by the backend. Approval pools let a trusted agent execute only approved plans.

</td>
</tr>
</table>

<img src="docs/assets/divider.svg" width="100%" alt="" />

## Six root nodes; everything else grows by itself

<div align="center">
<img src="docs/assets/demo-nodes.svg" width="100%" alt="Request, Agent, Skill, Backlog, Approval Pool, Scheduled Trigger" />
</div>

- **Agent + Agent** forms a Team that keeps both conversations and holds an internal discussion before assignments;
- **Backlog pools** queue work that idle agents pull automatically;
- **Scheduled Triggers** run on a Host-owned timer that survives restarts;
- **Skills** dragged onto an Agent or Team bind capabilities for every later run.

## Reports read like posts

Click a Work Report, Answer, or Plan to open a **fullscreen detail page**: the producing agent leads, the body renders Markdown (tables included), and a status rail shows whether that agent is busy and what is queued. **Select any passage to raise a floating annotate button**; comments are relayed to the producing agent, whose status reply types out beneath your comment.

## Quick start

```powershell
npm install
npm run build
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add (Resolve-Path .).Path
npx @deepseek-ai/dsh@0.1.0-rc.6 web
```

Open the URL printed by DSH and pick **运筹 / Knotline** in the sidebar: choose a workspace on the fullscreen picker and hit "Enter Knotline" at the bottom right. A three-step guide greets first-time users.

### Verify

```powershell
npm run check     # lint + types + 55 tests + both bundles
npm run pack:check
```

See the Chinese [product requirements document](docs/PRD.md), [docs/architecture.md](docs/architecture.md) for the runtime path, and [docs/development.md](docs/development.md) for local development.

<img src="docs/assets/divider.svg" width="100%" alt="" />

<div align="center">
<img src="docs/assets/knotline-wordmark.svg" width="300" alt="运筹 Knotline" />
</div>

Knotline is licensed under the [Apache License 2.0](LICENSE). It descends from the Dashi Taskboard codebase; [PROVENANCE.md](PROVENANCE.md) records what was carried forward, [NOTICE](NOTICE) carries the required attribution, and bundled third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Knotline is an independent community project, not affiliated with, sponsored by, or endorsed by DeepSeek or the upstream Dashi Taskboard authors. Product names are used only to describe interoperability.
