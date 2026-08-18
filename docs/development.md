# Development

## Prerequisites

- Node.js `^22.19.0` or `>=24.0.0`
- npm
- DSH `0.1.0-rc.6` for integration verification

## Production build

```sh
npm run build
```

Outputs:

- `lib/index.js` and `lib/index.d.ts`: Host Cordis plugin;
- `lib/client.js` and `lib/client.d.ts`: official DSH Web sidebar launcher and directly embedded Map bundle.

## Verification

```sh
npm run check
npm run pack:check
```

`check` runs lint, TypeScript, unit tests, and both builds. `pack:check` shows the exact publish set.

For integration, use an isolated DSH home:

```powershell
$dshTestHome = New-Item -ItemType Directory -Force .\.dsh-test-home
$env:DSH_HOME = $dshTestHome.FullName
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add (Resolve-Path .).Path
npx @deepseek-ai/dsh@0.1.0-rc.6 --profile web --dump-config
npx @deepseek-ai/dsh@0.1.0-rc.6 web
```

Then verify `/knotline/api/health`, open the official DSH Web UI, and select **运筹 / Knotline** in its sidebar. Confirm that Map stays unavailable until an existing DSH Workspace project is selected. Drag Agent, Request, Backlog, Approval Pool, and Scheduled Trigger from the top drawers; choose Skill from the installed list. Confirm that Request opens the blurred composer only after landing and creates an island without execution. Double-click an Agent to rename it, and confirm positions and names persist. Also confirm that returning to Chat works and `/knotline/map/` returns 404 because no standalone page exists.

For the operating-map smoke path, use one isolated Project and verify:

1. the toolbar exposes only Request, Agent, Skill, Backlog, Approval Pool, and Scheduled Trigger creation;
2. creating an Agent immediately binds a resumable DSH Session;
3. connecting two Agents creates a Team plus derived Plan and Working Protocol documents while retaining both member Session IDs;
4. connecting a Request to an Agent classifies it and starts a real NodeRun; question, complex, and Debug paths derive the expected nodes;
5. connecting an Agent and Requests to a Backlog persists the queue and assigns eligible work;
6. completion creates a Pre-review Artifact;
7. connecting that artifact to another Agent starts a real independent review run and an approval creates the final Delivery.
8. connecting a Scheduled Trigger to an Agent or Team persists `scheduled_for`; after its interval the Host creates a Task Bench and sends the stored Prompt, while the node switch pauses and restarts timing.

Do not mark a Node Run complete from generated prose. Only structured Knotline tools and review decisions advance governed status.
