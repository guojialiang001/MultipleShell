# MultipleShell

English | [Chinese](doc/README.zh-CN.md)

A multi-tab terminal manager for local development/debugging. Start different kinds of terminal sessions (Claude Code / Codex / OpenCode) from config templates, manage multiple PowerShell sessions in a single window, with voice input, auto-updates, and encrypted storage.

> The current implementation launches terminals via `powershell.exe` by default (Windows-first).
>
> Optional: **Remote mode** provides quick "open/copy deep link" entries for Guacamole RemoteApp/VNC, suitable for mobile/browser access.

## Keywords

- multi-terminal manager
- tabbed terminal / terminal emulator
- PowerShell session manager (Windows)
- Electron + Vue 3 + Vite + xterm.js + node-pty
- Claude Code / OpenAI Codex / OpenCode
- Guacamole / RemoteApp / VNC / RDP / PWA

## Features (as implemented)

- Multi-tab terminal: manage multiple sessions in a single window; tab bar supports overflow scrolling.
- Multi-instance sync (Host/Client): run multiple MultipleShell instances on the same Windows machine (including RDP RemoteApp sessions) while sharing the same session set; session list and terminal output sync in real time across instances.
- Multi-instance safety: Clients use an isolated `userData` (avoid Chromium profile contention); all stateful writes/side effects (configs/drafts/monitor/update/voice) are centralized on the Host.
- Create/close guards: new tabs can start as `pending`; closing a tab/window from the UI requires typing `close` to confirm.
- Config templates (3 types only): `claude-code` / `codex` / `opencode`.
- CC Switch integration (optional): import providers/proxy/failover config from CC Switch as templates; when creating sessions you can follow the current provider or route through the CC Switch proxy (for auto-failover).
- Config management: list/create/edit/delete templates (delete confirmation dialog).
- Per-tab working directory: choose a working directory when creating a session; the main process blocks system-sensitive directories (e.g. `C:\Windows\System32`, `C:\Program Files`).
- Voice input: record -> transcribe -> write directly into the current terminal input stream.
- Auto updates: powered by `electron-updater` (generic feed), with check/download/restart-to-install, plus real-time status pushed to the renderer.
- i18n: built-in `zh-CN` / `en`, switchable in Settings.
- View mode (thumbnail cards): a dashboard of session "summary cards" (running/idle/stuck/done/error); no screenshots; keeps only the last N lines (default 20) as a preview to save resources and reduce sensitive-data exposure.
- Remote mode: configure a Guacamole portal URL + RemoteApp/VNC connection names; one-click open/copy deep links (`/#/client/c/<connectionId>`), suitable for mobile browsers/PWA.
- Terminal usability tweaks:
  - Right click: copy when a selection exists, otherwise paste.
  - Selection protection during heavy output.
  - Extra fallback handling for `clear/cls` (front-end detection + forced clear).
- Secure storage (important): configs and drafts are encrypted with Electron `safeStorage` and stored in the user directory; the app warns and exits if secure storage is unavailable.
- Codex extra isolation + history retention: each session uses a dedicated temporary `CODEX_HOME` (avoid template drift) and syncs persisted runtime state from `<userData>/codex-runtime/<configId>/persist/` (default whitelist includes `history.jsonl`).
- Claude Code session isolation + history retention: per-template `CLAUDE_CONFIG_DIR` + HOME/USERPROFILE; by default preserves `history.jsonl` under the template profile (set `MPS_CLAUDE_CLEAR_HISTORY=1` to clear).
- Windows install/uninstall UX: NSIS installer includes custom "app is running" checks to avoid uninstall/upgrade failures across different privileges/users.

## Tech Stack

- Electron main process: `src/main/`
- Preload: `src/preload/`
- Renderer: Vue 3 + Vite; terminal rendering via xterm.js
- PTY: `node-pty` (defaults to PowerShell)
- CC Switch DB reader: `sql.js` (WASM SQLite; reads `cc-switch.db`)
- Packaging: electron-builder (NSIS)

## Quick Start

### Requirements

- Node.js 22.12+ (recommended to match `package-lock.json`)
- npm
- Windows: if `node-pty` fails to install, you'll need Visual Studio Build Tools + Python (node-gyp dependencies)

### Install dependencies

```bash
npm install
```

### Start dev

```bash
npm run dev
```

### Build (Windows)

```bash
npm run build:win
```

Other build commands are in `package.json` scripts (e.g. `build`, `build:win:x64`, `build:win:ia32`).

> Build outputs default to `release/<arch>/` (see `electron-builder.json`).

### Self-check (encrypted config/write path)

```bash
npm run selfcheck:rpd
```

### Self-check (view-state machine)

```bash
npm run selfcheck:monitor
```

Optional extras (stress/boundary checks):

```bash
node .\\scripts\\monitor-pty-selfcheck.js
node .\\scripts\\monitor-stresscheck.js
```

## User Guide

### Create a terminal tab

1. Press `Ctrl+T` or click "New tab".
2. Pick a config template (Claude Code / Codex / OpenCode).
3. Optional: click "Browse" to set the working directory (system directories are blocked).
4. A PowerShell session starts and is shown in the current tab.

### CC Switch (optional)

- Purpose: reuse CC Switch providers/proxy/failover config, import into MultipleShell, and create sessions.
- Config dir: default `~/.cc-switch`; on Windows it also tries `%APPDATA%\\com.ccswitch.desktop\\app_paths.json`; override with `MPS_CC_SWITCH_CONFIG_DIR` (or `CC_SWITCH_CONFIG_DIR`).
- One-click import: in "Manage configs" click "Import from CC Switch (override)". It syncs (including deletions) all templates prefixed with `ccswitch-`, without touching templates you created manually.
- Default toggles (create-session panel):
  - "Only use CC Switch configs": off by default (shows all templates).
  - "Auto detect": off by default (no background polling); enable manually or click "Refresh".
- CC Switch not installed/initialized: if `cc-switch.db` is missing in the detected directory, the app won't hard-fail; it shows "CC Switch not detected" in the UI.
- Run mode:
  - "Use CC Switch": merges the selected provider config into the template; leaving `CC Switch Provider ID` empty means "follow current provider".
  - "Use CC Switch proxy": routes requests through the CC Switch proxy (requires proxy enabled in CC Switch, works with CC Switch auto-failover). OpenCode uses CC Switch's Codex proxy config.

### Multi-instance sync (Desktop + RemoteApp)

- Host election: the first instance becomes the Host (owns the PTY + session registry); later instances become Clients (UI only, talk to the Host via local IPC).
- Session sync: tabs/session list are host-authoritative (broadcast via `sessions:changed`); create/input/close sessions on any side and other instances update in real time.
- Centralized writes: Clients never directly write shared state (configs/drafts/monitor/update/voice); they call Host RPC instead to avoid corrupting user data via concurrent writes.
- Profile isolation: each Client switches Chromium `userData` to `%LOCALAPPDATA%\\MultipleShell\\clients\\<pid>` to avoid profile lock conflicts.
- Transport/auth: user-scoped Windows Named Pipe; handshake token stored at `%APPDATA%\\MultipleShell\\agent-token`; override the pipe name via `MPS_AGENT_PIPE` for debugging.
- Design doc (Chinese): [doc/REMOTEAPP_DESKTOP_SYNC_PLAN_ZH.md](doc/REMOTEAPP_DESKTOP_SYNC_PLAN_ZH.md)

### Close confirmation (UI)

- Close tab: clicking the tab close button requires typing `close`.
- Close window: clicking the in-app top-right close button requires typing `close`.

### Voice input

- Use the voice bar at the bottom: click to start recording, click again to stop.
- After stopping, the main process calls the transcription API and writes the recognized text into the current terminal input.
- Microphone permission is requested on first use; the app only requests audio permission (no video).

> Transcription is done via HTTPS to `api.siliconflow.cn` `/v1/audio/transcriptions` using model `FunAudioLLM/SenseVoiceSmall`.

### Common shortcuts

- `Ctrl+T`: new tab
- `Ctrl+W`: close current tab (quick close; bypasses the UI text confirmation)
- `F12`: toggle DevTools

### View mode (thumbnail cards)

- Entry: choose "View" from the mode switcher in the top-left.
- Docked floating panel: in Shell mode, click "View" in the bottom-right to open the floating panel without switching modes.
- Card contents: terminal name, working directory, type, status, runtime, last active time, output line count, error count.
- Actions: single-click focuses; double-click or click "Open" jumps to the terminal and switches back to Shell mode.
- Resource savings: no screenshots and no full logs on disk; only keeps the last N lines in memory (default 20) plus stats; view updates are throttled/merged (default 250ms).

Implementation notes: [doc/MONITOR_CARD_THUMBNAIL_SAVING_ZH.md](doc/MONITOR_CARD_THUMBNAIL_SAVING_ZH.md), [doc/SHELL_MONITORING_SOLUTION.md](doc/SHELL_MONITORING_SOLUTION.md)

### Remote mode (Remote / Guacamole shortcuts)

This mode aggregates Guacamole portal/RemoteApp/VNC entry points into a desktop client. It does not embed the remote desktop; it only generates links and opens them with the system default browser.

1. Settings -> Remote access:
   - `Portal URL`: Guacamole base URL (e.g. `https://remote.example.com/guacamole/`; if reverse-proxied to `/`, use `https://remote.example.com/`).
   - `System RDP port`: local machine RDP port (default `3389`).
   - `Load RDP config`: enable RDP+NLA, add firewall rules, and register the RemoteApp alias `||MultipleShell` (requires running MultipleShell as Administrator; also recommended to close extra instances to avoid RemoteApp startup issues).
   - `RemoteApp shortcuts`: toggle (when off, RemoteApp entry is always disabled).
   - `Base64 encode connection names`: toggle (encodes the names below when generating deep links; needed for some Guacamole/gateway setups).
   - `RemoteApp connection name` / `VNC connection name`: recommended to copy `<...>` from the Guacamole URL `#/client/c/<...>`. Alternatively, use the `<connection name="...">` from your `user-mapping.xml` (enable Base64 if required).
2. Switch the top mode to "Remote" to access:
   - Open portal / Copy portal URL
   - Open RemoteApp / Copy RemoteApp deep link
   - Open VNC / Copy VNC deep link

Notes:

- Remote settings are stored in renderer `localStorage` (not encrypted, local-only). Do not store secrets/passwords here.

## Optional: Remote access deployment (Guacamole / RemoteApp / RD Web Client)

This repository includes a reference setup for "mobile browser -> RemoteApp/VNC/SSH" access. It is decoupled from MultipleShell's core terminal features (you can ignore it for local development).

- Guacamole (Docker):
  - `docker-compose.yml`: runs `guacd` + `guacamole`; expects a `user-mapping.xml` (file auth) for users/connection definitions.
  - `extensions/`: mount Guacamole extension JARs; this repo also contains `extensions/custom-theme` as optional static theme assets.
  - Start:

    ```bash
    docker compose up -d
    ```

    By default it listens on `127.0.0.1:8080`; the portal is typically `http://127.0.0.1:8080/guacamole/` (recommended: reverse proxy to 443 via Nginx).
- Windows RemoteApp helper scripts:
  - `scripts/win-remoteapp-ensure.ps1`: enable RDP+NLA, configure firewall, read `remote-app` entries from `user-mapping.xml`, and register them into `TSAppAllowList` (so `||alias` works).
  - `scripts/test-rdp-connection.ps1`: TCP reachability check for the RDP port.
- RD Web Client (official HTML5) route (alternative to Guacamole):
  - Notes (Chinese): [doc/RD_WEB_CLIENT_WINDOWS_ZH.md](doc/RD_WEB_CLIENT_WINDOWS_ZH.md)
  - Cert helper script: `scripts/rds-rdwebclient-cert.ps1`
- Guacamole custom theme (optional):
  - Docs: `extensions/custom-theme/README.md`
  - One-click deploy: `scripts/deploy-guacamole-theme.sh`

## Config template types

Only three template types are supported (and validated by the main process):

### 1) Claude Code (`claude-code`)

- You edit the content of a `settings.json` file (JSON text).
- When a session starts, the main process writes it to `<userData>/claude-homes/<configId>/settings.json` and sets `CLAUDE_CONFIG_DIR` to that directory.
- Windows: sessions always use `C:\\Users\\<username>\\.claude.json` as Claude Code's "home" config; if missing it is created as `{}` (it will not copy/use `.claude.json.backup`).
- `.claude.json` is copied into `<userData>/claude-homes/<configId>/.claude.json` on session start, with session-related fields removed (`lastSessionId`, `projects`) to avoid cross-profile bleed.

Example (default template direction in this project):

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your_zhipu_api_key",
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": 1
  }
}
```

### 2) Codex (`codex`)

- You provide two files: `config.toml` + `auth.json` (the UI uses dual panels; drafts are auto-saved).
- When a session starts:
  - The template source files are mirrored to `<userData>/codex-homes/<configId>/` for long-term storage.
  - Each session gets an isolated temporary `CODEX_HOME` (e.g. `%TEMP%\\mps-codex-home-<sessionId>`). `config.toml` and `auth.json` are written into that temp dir to prevent Codex from writing back and drifting templates.
  - Tool history/state is synced (whitelist-based) between `<userData>/codex-runtime/<configId>/persist/` and the temp `CODEX_HOME` (default: `history.jsonl`).
  - Environment variables like `CODEX_HOME`, `CODEX_CONFIG_TOML(_PATH)`, `CODEX_AUTH_JSON(_PATH)` are set (and printed in the terminal at startup for debugging).

### 3) OpenCode (`opencode`)

- You edit a `.opencode.json` file (JSON text).
- When a session starts, the main process writes it to `<userData>/opencode-homes/<configId>/opencode/.opencode.json` and sets `XDG_CONFIG_HOME=<userData>/opencode-homes/<configId>` so upstream OpenCode can pick it up.
- If missing, MultipleShell injects `data.directory=<userData>/opencode-runtime/<configId>` to keep OpenCode session history in a per-template stable location.
- Note: if the working directory contains a local `./.opencode.json`, upstream OpenCode will merge it and it can override these settings.
- This type also supports extra `envVars` (injected into the session environment).

Default template:

```json
{}
```

## Data and security

- Encrypted storage:
  - Config store: `<userData>/configs.v1.enc`
  - Draft store (Codex editor autosave): `<userData>/drafts.v1.enc`
  - Both are encrypted via Electron `safeStorage` (backed by Windows DPAPI / macOS Keychain / Linux libsecret).
- Extra files:
  - `claude-homes/`, `codex-homes/`, `opencode-homes/` store materialized template files (for external tools to read).
  - `codex-runtime/` stores per-template Codex persisted state (e.g. `persist/history.jsonl`) for history retention.
  - Codex sessions create temp `mps-codex-home-*` dirs and clean them up on exit (set `MPS_KEEP_CODEX_HOME=1` to keep them for debugging).
  - Multi-instance agent handshake token: `%APPDATA%\\MultipleShell\\agent-token` (generated by the Host; used by Clients).
  - Client isolated profile: `%LOCALAPPDATA%\\MultipleShell\\clients\\<pid>` (per Client; auto recreated if deleted).
- Security reminders:
  - `user-mapping.xml` (Guacamole file auth) contains plaintext users/passwords/targets. Replace it before deployment and never commit real credentials.
  - The voice-transcription API key is currently provided by `src/main/built-in-config-manager.js` (example implementation). For production, inject it from external config/secure storage and rotate keys.

## Auto updates (optional)

- Controlled via env vars:
  - `MPS_UPDATE_URL`: generic update feed URL (when unset, auto-update is shown as disabled)
  - `MPS_UPDATE_DEV=1`: enable auto-update logic in dev/unpacked mode (by default it only runs in packaged builds)
- UI: Settings menu provides "Check updates / Download progress / Restart to install".

## Environment variables (debug/dev)

- `MPS_AGENT_PIPE`: override the local agent Named Pipe name (by default derived from the current user; shared by desktop and RemoteApp).
- `MPS_CC_SWITCH_CONFIG_DIR` / `CC_SWITCH_CONFIG_DIR`: override the CC Switch config dir (to read `cc-switch.db`).
- `MPS_UPDATE_URL`: enable auto updates (generic feed).
- `MPS_UPDATE_DEV=1`: enable auto updates in dev.
- `MPS_REMOTEAPP_EXE_PATH`: force the `MultipleShell.exe` path for RemoteApp registration (debugging custom install paths).
- `MPS_KEEP_CODEX_HOME=1`: keep each session's temp `CODEX_HOME` dir.
- `MPS_CODEX_CLEAR_HISTORY=1`: clear per-template Codex persisted history/state (whitelist) before starting a Codex session.
- `MPS_CODEX_PERSIST_WHITELIST=...`: override Codex persisted whitelist files (comma/semicolon-separated; default: `history.jsonl`).
- `MPS_DEBUG_ENV_APPLY=1`: debug env injection (prints hints in the terminal).
- `MPS_SUPPRESS_DIALOGS=1`: suppress main-process dialogs (used by self-check scripts).
- `MPS_CLAUDE_CLEAR_HISTORY=1`: clear Claude Code `history.jsonl` in the template profile (default: preserved).

## FAQ

### Install failures (node-gyp / node-pty)

This usually means local C++ build dependencies are missing. Install:

- Visual Studio Build Tools
- Python 3.x

Then run `npm install` again.

### Cursor blinks too fast / multiple cursor boxes

- xterm does not expose a public "blink rate" option; you need to patch internal constants or switch to the DOM renderer and adjust animation duration.
- See: [doc/CURSOR_BLINKING_ISSUES.md](doc/CURSOR_BLINKING_ISSUES.md)

### No scrollbar / cannot scroll back

- Common causes include overlay scrollbars, output using `\r` without line feeds, `clear/cls`, full-screen TUI (alternate screen), etc.
- See: [doc/SHELL_SCROLLBAR_ANALYSIS.md](doc/SHELL_SCROLLBAR_ANALYSIS.md)

## Project layout (brief)

```
src/
  main/        # Electron main process (config store, pty, updates, voice, ...)
  preload/     # IPC bridge
  renderer/    # UI (Vue)
scripts/       # self-checks and helper scripts
build/         # NSIS installer scripts, icons, etc
configs/       # legacy/migration templates (auto-imported on first run)
extensions/    # Guacamole extensions and custom theme assets (optional)
dist/          # Vite build output (generated)
dist-electron/ # Vite Electron build output (generated)
release/       # electron-builder output (generated)

docker-compose.yml  # Guacamole + guacd (file auth) example
electron-builder.json
```

## Notes (maintainers)

- JSON files under `configs/` are imported on first run / migration (see `src/main/config-manager.js`).
- The voice API key is currently "built-in" (see `src/main/built-in-config-manager.js`). For external config/encrypted files, the approach in `scripts/encrypt-api-key.js` (generating `resources/voice-api.enc`) is a good starting point.
- NSIS "running instance detection + optional debug logs" lives in `build/installer.nsh`. Related notes: [doc/UNINSTALL_RUNNING_CHECK_SOLUTION.md](doc/UNINSTALL_RUNNING_CHECK_SOLUTION.md)

## Docs index

- Terminal view design and trade-offs:
  - [doc/SHELL_MONITORING_SOLUTION.md](doc/SHELL_MONITORING_SOLUTION.md)
  - [doc/MONITOR_CARD_THUMBNAIL_SAVING_ZH.md](doc/MONITOR_CARD_THUMBNAIL_SAVING_ZH.md)
  - [doc/SHELL_MONITORING_TODO.md](doc/SHELL_MONITORING_TODO.md)
- Terminal UX investigations:
  - [doc/CURSOR_BLINKING_ISSUES.md](doc/CURSOR_BLINKING_ISSUES.md)
  - [doc/SHELL_SCROLLBAR_ANALYSIS.md](doc/SHELL_SCROLLBAR_ANALYSIS.md)
- Windows install/uninstall (NSIS):
  - [doc/UNINSTALL_RUNNING_CHECK_SOLUTION.md](doc/UNINSTALL_RUNNING_CHECK_SOLUTION.md)
- Remote access (browser/mobile) notes:
  - [doc/GUACAMOLE_REMOTEAPP_WINDOWS_ZH.md](doc/GUACAMOLE_REMOTEAPP_WINDOWS_ZH.md)
  - [doc/GUACAMOLE_REMOTEAPP_WINDOWS_ZH_TODO.md](doc/GUACAMOLE_REMOTEAPP_WINDOWS_ZH_TODO.md)
  - [doc/GUACAMOLE_REMOTEAPP_MULTIPLESHELL_ZH_TODO.md](doc/GUACAMOLE_REMOTEAPP_MULTIPLESHELL_ZH_TODO.md)
  - [doc/RD_WEB_CLIENT_WINDOWS_ZH.md](doc/RD_WEB_CLIENT_WINDOWS_ZH.md)
  - [doc/RD_WEB_CLIENT_WINDOWS_ZH_TODO.md](doc/RD_WEB_CLIENT_WINDOWS_ZH_TODO.md)
  - [doc/MOBILE_REMOTE_ACCESS_SOLUTION_ZH.md](doc/MOBILE_REMOTE_ACCESS_SOLUTION_ZH.md)
  - [doc/MOBILE_REMOTE_ACCESS_SOLUTION_WINDOWS_ZH.md](doc/MOBILE_REMOTE_ACCESS_SOLUTION_WINDOWS_ZH.md)
  - [doc/MOBILE_REMOTE_ACCESS_SOLUTION_LINUX_ZH.md](doc/MOBILE_REMOTE_ACCESS_SOLUTION_LINUX_ZH.md)
- Guacamole theme:
  - [extensions/custom-theme/README.md](extensions/custom-theme/README.md)

## Feedback and contributing

Issues and pull requests are welcome. When reporting bugs, please include repro steps and expected behavior.

