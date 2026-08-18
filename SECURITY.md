# Security policy

Knotline mounts a local HTTP + SSE API (`/knotline/map/api/*` and `/knotline/api/health`) inside the DSH WebServer trust boundary. Unlike a read-only dashboard, this API **mutates state**: it creates and connects map nodes, persists a local SQLite database under the DSH home directory, starts and resumes DSH agent conversations, and those agents can run filesystem and shell tools inside the selected workspace.

Threat model you should assume:

- Requests are authenticated only by the surrounding DSH Web instance. Actor identity on the map API is asserted via request headers and is not independently verified; any process that can reach the DSH Web port can act on the map, including triggering agent execution.
- Session content, prompts, tool arguments/results, delivery text, and workspace paths are stored in the local database (`knotline.sqlite`) and may appear in API responses and SSE events.
- Treat access to Knotline as equivalent to access to the corresponding DSH Web instance and its workspaces.

Hardening guidance:

- Never expose a DSH Web bind to an untrusted network. Keep it on loopback or behind an authenticated reverse proxy.
- Do not commit or share the `.data/` directory or any `knotline.sqlite*` files; they contain real project and session content.

## Reporting a vulnerability

Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/MrMaii/knotline/security/advisories/new). If that is unavailable, open a minimal public issue asking for a private contact channel — do not include exploit details, real session logs, API keys, credentials, or private workspace paths in public issues. You can expect an initial response within 14 days. Only the latest released version receives security fixes.
