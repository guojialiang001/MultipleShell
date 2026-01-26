# Known Bugs / Issues

This file tracks currently known issues in this repo and their status.

## Fixed

### IPC "An object could not be cloned" when creating a terminal

- Symptom: Creating a new PowerShell tab throws `Error: An object could not be cloned` in `App.vue:createTab`.
- Root cause: Vue reactive Proxy objects were passed through Electron IPC (`ipcRenderer.invoke`), which requires structured-cloneable data.
- Fix: Convert config objects to plain JSON before emitting/IPC calls.
- Code: `src/renderer/components/ConfigSelector.vue`, `src/renderer/App.vue`

## Open

### Terminal selection disappears on mouse up

- Symptom: Selecting text in the terminal with the mouse clears immediately on mouse release.
- Suspected root cause: Incoming pty output can still be written during the drag/mouseup settling window, causing xterm.js to clear selection.
- Status: Fix attempt updated (add capture-phase `mousedown`; chunked `terminal.write` drain; last-resort selection restore right after `mouseup`); needs verification in the `ping -t` repro.
- Code: `src/renderer/components/Terminal.vue`
- Notes: Detailed write-up in `BUG-TextSelectionLost.zh-CN.md`.

### Garbled text (mojibake) in some UI strings/docs

- Symptom: Some Chinese strings show as garbled characters.
- Notes: Likely file encoding mismatch (not UTF-8) in a subset of `.vue`/`.md` files.

### Right-click copy/paste has noticeable latency in terminal

- Symptom: Right-click to copy selected text (or paste when no selection) feels delayed.
- Root cause: Using `navigator.clipboard.*` in Electron renderer can be slow due to permission checks / async clipboard plumbing.
- Fix: Use Electron main-process `clipboard` via IPC (`clipboard:writeText`/`clipboard:readText`).
- Code: `src/main/index.js`, `src/preload/index.js`, `src/renderer/components/Terminal.vue`

### Double cursor (cursor artifact) after pasting into interactive TUI (e.g. claude)

- Symptom: After paste in an interactive prompt/TUI, two cursors appear (main cursor + artifact).
- Suspected root cause: Right-click paste previously bypassed xterm's input pipeline by writing clipboard text directly to pty.
- Fix: Read clipboard via IPC, then call `terminal.paste(text)` so xterm handles bracketed paste and cursor updates.
- Code: `src/renderer/components/Terminal.vue`
- Notes: Detailed write-up in `BUG-DoubleCursorOnPaste.zh-CN.md`.

### Multiple prompts/inputs when running `claude` (repeated `? for shortcuts`)

- Symptom: After running `claude`, the UI shows multiple `>` inputs / repeated `? for shortcuts`.
- Root cause: Terminal component mistakenly treated normal clear-screen sequences (`ESC[2J`/`ESC[3J`/`ESC c`) as a signal to `terminal.reset()`, which breaks TUIs that redraw by clearing the screen.
- Fix: Remove the hard-reset interception; let xterm process control sequences normally.
- Code: `src/renderer/components/Terminal.vue`
- Notes: Detailed write-up in `BUG-ClaudeTriplePrompt.zh-CN.md`.

### PowerShell `clear/cls` only clears partially

- Symptom: Running `clear`/`cls` does not fully wipe the terminal (looks like only part of the screen/history is cleared).
- Root cause: PowerShell clear behavior varies by host; it may clear only the viewport or even just print many newlines. Combined with this app's buffered output, the result can look "partially cleared".
- Fix: Track user input; when the user submits `clear`/`cls`/`clear-host` on the normal buffer, force a local `terminal.clear()` and drop pending output (without `reset()`).
- Code: `src/renderer/components/Terminal.vue`
- Notes: Detailed write-up in `BUG-ClearPartial.zh-CN.md`.

### Terminal bottom line clipped (can't scroll to true bottom)

- Symptom: Scrolling to bottom still leaves the last line(s) partially hidden/clipped.
- Root cause: `FitAddon.fit()` miscalculates available height when the xterm mount container has padding, resulting in too many rows and the last row being cut off.
- Fix: Move padding to an outer wrapper; keep the xterm mount container padding-free.
- Code: `src/renderer/components/Terminal.vue`
- Notes: Detailed write-up in `BUG-TerminalBottomClipped.zh-CN.md`.

### `vite build` may fail with `EBUSY` when output dir is locked

- Symptom: `EBUSY: resource busy or locked, rmdir 'dist\\win-unpacked'`.
- Notes: Usually happens if a previous packaged app is still running or the folder is locked by antivirus/explorer.

### Hard-coded transcription API token checked into the repo

- Symptom: Voice transcription works only with the baked-in key; rotating or revoking the key breaks the feature.
- Risk: The token is exposed in source control and packaged builds.
- Root cause: `TRANSCRIPTION_TOKEN` is a constant in the main process.
- Fix: Move the token to environment/config/secure storage and never commit it.
- Code: `src/main/index.js`

### Orphaned pending tabs when creating multiple tabs quickly

- Symptom: Pressing Ctrl+T repeatedly while the config selector is open leaves "New Tab" entries that never become real terminals.
- Root cause: Only the latest `pendingTabId` is tracked; earlier pending tabs are never resolved or cleaned up.
- Fix: Prevent additional pending tabs, or track and clean all pending entries on cancel/create.
- Code: `src/renderer/App.vue`

### Invalid working directory can crash pty spawn

- Symptom: Creating a terminal with a deleted or invalid `workingDir` can throw and crash the main process.
- Root cause: `pty.spawn` is called with unvalidated `cwd` and no error handling.
- Fix: Validate `workingDir` exists; fall back to `USERPROFILE`; catch and surface spawn errors.
- Code: `src/main/pty-manager.js`

### Output loss while selecting under heavy output

- Symptom: While selecting text during high-volume output, some output is lost after selection ends.
- Root cause: When selection guard is active and the buffer exceeds `MAX_PENDING_CHARS`, chunks are dropped.
- Fix: Pause output with a visible "output paused" state, or apply backpressure instead of dropping.
- Code: `src/renderer/components/Terminal.vue`
