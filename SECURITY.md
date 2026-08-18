# Security policy

Knotline mounts a local HTTP + SSE API (`/knotline/map/api/*` and `/knotline/api/health`) inside the DSH WebServer trust boundary. Unlike a read-only dashboard, this API **mutates state**: it creates and connects map nodes, persists a local SQLite database under the DSH home directory, starts and resumes DSH agent conversations, and those agents can run filesystem and shell tools inside the selected workspace.

Threat model you should assume:

- The plugin accepts only loopback peers and positively allowlists the Map routes used by the current client and Agent lifecycle. Authentication remains the responsibility of the surrounding DSH Web instance; any process that can reach its local port can act on the map, including triggering agent execution.
- Legacy local-AI, Cloud, Jira, task, comment, attachment, and device-workspace routes are not exposed by the DSH plugin. No maintainer endpoint, account, key, token, database, or runtime configuration is distributed; every installation uses its owner's DSH environment and credentials.
- Agent lifecycle tools are bound to their assigned Agent and Node Run. Review decisions additionally require the assigned reviewer, Project, Workstream, and Review Gate.
- Session content, prompts, tool arguments/results, delivery text, and workspace paths are stored in the local database (`knotline.sqlite`) and may appear in API responses and SSE events.
- Treat access to Knotline as equivalent to access to the corresponding DSH Web instance and its workspaces.

Hardening guidance:

- Never expose a DSH Web bind to an untrusted network. Keep it on loopback; if an authenticated reverse proxy is required, run it on the same host so its connection to DSH remains loopback.
- Do not commit or share `.env*`, `.npmrc`, `.data/`, or any `knotline.sqlite*` files; they contain credentials or real project and session content.

## Reporting a vulnerability

Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/MrMaii/knotline/security/advisories/new). If that is unavailable, open a minimal public issue asking for a private contact channel — do not include exploit details, real session logs, API keys, credentials, or private workspace paths in public issues. You can expect an initial response within 14 days. Only the latest released version receives security fixes.
