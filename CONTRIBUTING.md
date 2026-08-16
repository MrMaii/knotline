# Contributing

Keep changes aligned with Knotline's boundary: one Map surface for orchestrating agents, built on official DSH contracts. There is no task list, board, dashboard, timeline, or separate operations console — see [docs/PRD.md](docs/PRD.md) for the normative scope.

## Prerequisites

- Node.js `^22.19.0 || >=24.0.0` (see `engines` in `package.json`)
- A DSH web profile for manual verification (`npx @deepseek-ai/dsh@0.1.0-rc.6 web`); see [docs/development.md](docs/development.md)

## Contribution terms

By contributing, you license your contribution under Apache License 2.0 and certify the [Developer Certificate of Origin 1.1](DCO.txt). Copyright is not assigned to the Knotline maintainer.

Sign every commit:

```sh
git commit -s
```

The resulting commit message must contain a truthful `Signed-off-by: Name <email>` line. Do not sign for code or assets you do not have the right to submit.

For copied, adapted, generated, or AI-assisted material:

- identify the source, version or commit, author when known, and license in the pull request;
- confirm the license is compatible with Apache-2.0 and redistribution of the combined work;
- retain required copyright, permission, attribution, trademark, and modification notices;
- update `PROVENANCE.md` or `THIRD_PARTY_NOTICES.md` when the material is distributed;
- personally review the result and certify the DCO. Tool output is not proof that material is original or safe to license.

Do not add third-party branding in a way that implies affiliation, sponsorship, or endorsement.

## Verification

Before opening a pull request:

```sh
npm install
npm run check
npm run pack:check
```

For UI changes, exercise the Map end to end in a real DSH web profile: create each root node type from the top drawers (Request, Agent, Skill, Backlog, Approval Pool, Scheduled Trigger), connect a Request to an Agent and watch classification derive the right node, exercise the review flow through to Delivery, and check the inspector and notification center. For DSH integration changes, verify against an isolated current DSH Web profile and record the exact version used.

Avoid adding user-facing surfaces beyond the Map, new user-creatable node types not in the PRD, or silent compatibility fallbacks.
