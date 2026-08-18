# Compatibility

## Current target

Knotline `0.1.0` targets DeepSeek Harness `0.1.0-rc.6`.

The integration relies only on current first-class DSH mechanisms:

- bundle manifests through `dsh.bundle.patch`;
- Cordis Loader plugin rows;
- `dsh.client` Web modules;
- `sidebar.footer.action` in the official Web client;
- `shell.overlay` in the official Web client;
- the official `--dsw-*` theme-token contract and `data-ds-dark-theme` state;
- `ctx.webServer.register`;
- `ctx.sessionQuery`, `ctx.sessions`, and `ctx.agents`.

## Preview policy

DeepSeek Harness is a developer preview and does not promise stable plugin contracts yet. Knotline therefore treats each DSH release candidate as a compatibility boundary.

Before raising the supported version:

1. install the new exact DSH version into an isolated home;
2. inspect the composed profile with `--dump-config`;
3. boot the official Web profile;
4. verify the client bundle loads from `/plugins`;
5. verify the sidebar Map plugin, `/knotline/map/api/*` mutations, Agent execution, and Map event refresh;
6. run the repository quality gates and browser design QA.

Do not claim compatibility from semver shape alone.
