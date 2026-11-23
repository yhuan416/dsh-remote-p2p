# Changelog

## 0.2.2 — 2026-11-23

### Fixed

- **Grant remotes: WebSocket/RPC upgrades returned 401** (the UI showed "无法连接"). DSH browser cookies are bound to the request
  authority, and the upgrade path (like the health probe and deep-link fetch) still sent the tunnel/upstream Host. All proxied
  headers now go through one `authorityOf()` helper, so grant peers receive their own authority for Host/Origin.

## 0.2.1 — 2026-11-23 · pairing and revocation

### Added

- Admin APIs: `GET /api/remote-hosts/peers` (pinned viewers + per-remote pairing state), `POST .../pair`,
  `POST .../unpair`, `POST .../peers/revoke`, `POST .../peers/approve`.
- `grantPolicy` config: `tofu` (default, pin on first exchange) or `strict` (exchange only for already-approved peers).
- Plugin config card: pairing section — per-remote state/auth/nodeId/paired badge with 配对/解除 buttons, pinned viewer list
  with 撤销, and the effective policy.

## 0.2.0 — 2026-11-23 · M2 slice

### Added

- **Node identity**: `$DSH_HOME/node-identity.json` holds an ed25519 keypair; `nodeId` is the first 16 hex of sha256(SPKI).
- **Peer endpoints** (public, signature-authorised instead of DSH-cookie-authenticated): `GET /api/remote-p2p/identity`,
  `POST /api/remote-p2p/exchange`, `GET /api/remote-p2p/stats`. Exchange verifies the viewer's signed proof
  (`aud` = backend nodeId, ±120s), TOFU-pins its public key in `$DSH_HOME/peers.json`, and mints the DSH session cookie
  **inside the backend process** — the plaintext launch token is never written for, or sent to, the peer.
- **Viewer grant auth**: a remote may set `auth: "grant"` (works for both `direct` and `ssh-tunnel` transports); the viewer fetches
  the peer identity, pins/verifies its public key, signs a proof, exchanges it for a cookie, and proxies as before. No token file
  and no plaintext token in the flow.
- Store/API expose `auth` and the pinned peer `nodeId`; `remote-hosts.json` keeps working (records without `auth` default to `token`).

### Verified

- Two local instances: viewer with `auth: "grant"` proxied `/remotes/<id>/` → 200 while the backend's token file was deleted,
  backend stats showed `exchanges: 1`, and both sides pinned each other in `peers.json`.
- **Cross-host (WSL → n100 instance :3084, ssh used as network transport only)**: exchange succeeded and `/remotes/<id>/` → 200
  with `tokenSource: null`. DSH binds its browser cookie to the request authority (Host), so the identity endpoint now publishes
  `authority` and the viewer forwards with that Host/Origin — without it the minted cookie was rejected (401).

## 0.1.2 — 2026-11-23

### Added

- `GET /api/remote-hosts/self-check`: a read-only feasibility/regression probe for the M2 design — in-process ed25519
  sign/verify plus node fingerprint, availability of `ctx.connection.authenticatedUrl`, and a server-side cookie exchange
  (`fetch` of the authenticated URL, 303 + Set-Cookie).
- `docs/M2-FEASIBILITY.zh.md`: evidence, minimal design (node identity, signed grant, `/identity` + `/exchange`, pairing and
  peers registry), risks and acceptance criteria.

## 0.1.1 — 2026-11-23

### Added

- **Plugin configuration card** for the Plugins page (`plugins.bundle.config` slot, key `dsh-remote-p2p`): node identity
  (file path, freshness, hostname/pid/web port), viewer lock owner, ssh tunnels with liveness, configured peer count and the
  effective viewer config, plus shortcuts to refresh and open `/remotes/`. Schema editing stays in the generated settings form.
- `GET /api/remote-hosts/node` serves that card's status (plugin version, identity file, lock, tunnels, effective config).

## 0.1.0 — 2026-11-23 · merged package

`dsh-remote-p2p` is the successor of `dsh-remote-hub` 0.7.x and `dsh-remote-agent` 0.2.x; entries below this release are that lineage.

### Added

- One plugin serves both halves of a remote link: the node publishes its identity/token file for paired peers (`identityFile`,
  default `$DSH_HOME/remote-agent.json`) **and** proxies its configured peers under `/remotes/<id>/`.
- Backend identity is independent of the viewer singleton: a second dsh sharing a `DSH_HOME` still publishes its identity (so a
  peer can reach it) even though it cannot proxy peers itself.
- `scripts/install.sh` migrates a profile from the two parent packages (removes their dependency, bundle selection and links,
  keeps `remote-hosts.json` and `remote-agent.json`).
- `lib/identity.js` with a pure `identityPayload()` / `identityPath()` so the identity half is testable offline.
- Plugin id and package name: `remote-p2p` / `dsh-remote-p2p`.

### Unchanged on purpose

- Store and identity file names (`remote-hosts.json`, `remote-agent.json`), URL prefix `/remotes/`, and the viewer/backend wire
  protocol, so existing deployments and hubs keep working through the rename.

## Unreleased

## 0.7.0 — 2026-11-23

### Fixed

- **Two hubs no longer fight over each other's ssh tunnels.** The tunnel registry is one file per hub process
  (`$DSH_HOME/remote-hub-tunnels.<pid>.json`) instead of one shared `remote-hub-tunnels.json`, and the startup sweep only
  kills tunnels whose owning hub process is gone. Previously a second hub (or a restarted one) SIGTERM-ed every recorded
  `ssh -L` child — including tunnels belonging to a live hub — so the hubs kept rebuilding each other's tunnels.
- **One hub per `DSH_HOME`.** The hub now takes `$DSH_HOME/remote-hub.lock` (pid + process start ticks) and starts a second
  instance on the same home with a clear error instead of racing: no `/remotes` routes, no tunnel, no shared session writes.
  The lock is released and the tunnel registry removed on shutdown, so a crashed hub's leftovers are still swept.

### Notes

- Legacy `remote-hub-tunnels.json` files are adopted and cleaned once; new tunnels are recorded per process.
- Harness instances that should be reachable through a hub still need their own `DSH_HOME` (or a distinct identity file:
  `dsh-remote-agent` supports `file` in its config) for the same reason.


### Added

- GitHub Actions workflow (`.github/workflows/check.yml`) running `npm run check` on push/PR.
- `.gitattributes` (LF normalization, binary markers) and `.editorconfig`.
- README: badge block, quick start, table of contents, an embedded mermaid topology diagram,
  a Troubleshooting table, and an Ecosystem table linking the three sibling projects;
  both English and Chinese READMEs kept structurally in sync.

## 0.6.0 — 2026-11-11

### Added

- `remote_sessions` renders session times as local wall-clock time with the UTC offset instead of a
  bare UTC timestamp.
- Version handshake: health probes parse the backend's `__DSH_BOOT__.release.version`, log a
  mismatch against the hub's own dsh version, expose `remoteVersion` / `hubVersion` /
  `versionWarning` from `/api/remote-hosts/list` and `/api/remote-hosts/probe`, and show the warning
  in the switcher status tooltip.
- The top-bar **＋ 在 <remote> 新建会话** chooser lists the remote's workspaces and creates the
  session with `workspace`; known cwd paths, a custom path, and the remote default remain as
  fallbacks.

## 0.5.0 — 2026-11-09

### Added

- **Workspace selection for remote sessions.** `remote_subagent` takes `workspace` (a workspace id
  or its absolute path) and `/api/remote-hosts/session/create` accepts `workspace`; the new
  session joins that remote workspace (`session/create` `workspaceId`) instead of owning a bare
  `cwd`. `workspace` and `cwd` are mutually exclusive at every layer.
- `resolveRemoteWorkspace()` resolves a workspace path to its id by reading the backend's
  `workspace.json` store over ssh; the tool/admin errors list the known paths when a path misses.

### Notes

- The upstream subagent seam (`SubagentStartRequest`) still only carries `cwd`, so the native
  `remote-dsh-<id>` provider rows cannot take a workspace argument; `remote_subagent` is the
  surface that does.
- A `cwd`-created session is not recorded in the workspace store (the hub shows it as an orphan);
  only `workspaceId` creation joins the workspace.

## 0.4.0 — 2026-11-09

### Added

- Native `remote-dsh-<id>` provider parity with local subagents where the external-provider seam
  allows: `agentPreset` forwarding, `agentOptions.provider/model/reasoningEffort` via
  `session/selectModel`, prompt-enforced `outputSchema` with local validation, and session rename
  from the subagent label.

### Known limits

- Remote children remain one-shot: no continuable children, live tool/event streaming into the
  parent, shared parent context, or depth-limit inheritance.

## 0.3.1 — 2026-11-09

### Fixed

- `remote_subagent` / `remote-dsh-<id>` returned the ~120-character `turnOutline` preview instead
  of the full assistant answer. The result is now read from the durable transcript with
  `session/page` (`assistant/message` events), falling back to the preview only when the
  transcript is unavailable.

## 0.3.0 — 2026-11-09

### Added

- `remote_subagent` tool: create or continue a remote dsh session, wait for the turn to settle,
  and return the final assistant text plus the remote session id.
- Native dsh subagent providers `remote-dsh-<host id>` for `dsh-tool-subagent` rows.
- Remote dsh providers/tools are registered independently of OpenCode configuration.

### Changed

- `remote_sessions` is now available even when no OpenCode server is configured.
- M2 roadmap updated: remote subagents are the priority; hub-side session lifecycle is deferred
  because the remote page already provides it.

## 0.2.0 — 2026-11-09

### Added

- Remote session control APIs: `POST /api/remote-hosts/session/create` (optional `cwd`) and
  `POST /api/remote-hosts/session/prompt`.
- Per-remote **＋ 在 <remote> 新建会话** in the top-bar switcher, with a cwd chooser that lists
  known workspace paths, supports a custom path, and remembers the last used directory.
- Remote session list aggregation (workspace store over ssh + `session/list` RPC) in the
  Plugins page, with per-session deep link into the backend pane.
- `ARCHITECTURE.md`, `COMPATIBILITY.md`, `TODO.md`, offline `scripts/check.mjs`, plugin icon,
  `engines.dsh`, and a documented admin/API surface.

### Removed

- Embedded remote workspace views (sidebar mirror, sidebar page with an iframe, new-session
  hero row). They layered UI over the native shell without a native data seam; the top-bar
  environment switcher remains the supported UX.

### Changed

- Switcher dropdown/top bar wording and layout; README restructured with links to architecture,
  compatibility and roadmap docs.

## 0.1.0 — 2026-11-06

### Added

- Hub-side reverse proxy for remote `dsh web` backends under `/remotes/<id>/` (HTTP, SSE,
  WebSocket, index rewriting, auth gate, cookie isolation).
- Admin API and persistent store: list/save/remove/probe plus workspace/session aggregation.
- Managed per-remote `ssh -L` supervisor: port allocation, backoff, reallocation, cleanup.
- Remote token resolution (inline, local file, ssh-read agent file) and server-side cookie
  exchange.
- Top-bar backend switcher and optional sidebar dropdown; Plugins-page management section.
- `remote_sessions` agent tool and robustness notes.