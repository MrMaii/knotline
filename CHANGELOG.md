# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-08-18

### Security

- Restrict the DSH plugin to loopback peers and to the exact Map routes and methods used by the current client and Agent lifecycle.
- Disable hidden legacy local-AI and stale Cloud forwarding in DSH mode.
- Bind Agent lifecycle and review tools to the assigned Agent, Node Run, Project, Workstream, and Review Gate.
- Create local SQLite and attachment storage with private owner-only permissions on POSIX systems.
- Ignore conventional `.env` and `.npmrc` credential files to prevent accidental commits.

## [0.1.0] - 2026-08-17

### Added

- Initial public release of 运筹 / Knotline as a DeepSeek Harness sidebar plugin: a single Project Map surface with six root node types (Request, Agent, Skill, Backlog, Approval Pool, Scheduled Trigger), automatic request classification, capability-based delegation, Agent Teams, backlog queueing, approval-gated execution, scheduled triggers, and a pre-review artifact → independent review → delivery flow.
- Chat-parity feedback: the agent's full final reply is harvested into node runs and surfaces on Task Bench, notification, and delivery nodes; running Task Benches embed a live transcript of the agent conversation.
- Fullscreen post-style detail pages for requests, reports, and agent runs, with Markdown rendering (including tables), text annotation, comments relayed to the producing agent, and live agent status replies.
- Fullscreen workspace picker as the entry surface, a one-time first-run guide, brand-led motion (signal-flow edges, node and menu animations, reduced-motion support), and the 运筹 bilingual brand identity.
