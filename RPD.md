# RPD: Multiple Config Profiles + Local Encrypted Storage

## 1. Background

Today config templates are stored as plaintext JSON files under `configs/*.json`:

- In packaged apps this location can become read-only (asar/resources), so writes are unreliable.
- Plaintext JSON does not meet the requirement of "app-level encrypted file storage".
- File-name based identity makes it hard to evolve (and to safely support multiple variants for the same tool, e.g. "Codex - Default" vs "Codex - Enhanced").

## 2. Goals

- Support unlimited config templates ("profiles"), including multiple variants for the same tool (Codex, Claude Code, OpenCode, ...).
- Persist profiles under the per-user app data directory, encrypted at rest, stored locally.
- Keep the existing UX: pick a profile -> start a new PowerShell session in its own tab.

## 3. Non-goals (this iteration)

- Cloud sync / multi-device sync
- Team sharing / permission system
- Complex inheritance/overlay between profiles

## 4. User Stories

- As a user, I can create/edit/delete any number of profiles.
- As a user, I can maintain multiple Codex setups (default/enhanced/per-project) and switch quickly.
- As a user, my profiles exist only on my machine and are encrypted on disk.
- As a user, if the store is corrupted, the app recovers automatically (and keeps a backup for debugging).

## 5. Data Model

### 5.1 Profile

- `id: string` unique identifier (primary key)
- `name: string` display name (duplicates allowed; UI should encourage descriptive names)
- `workingDirectory: string`
- `envVars: Record<string, string>`
- `startupScript: string`
- `createdAt: string (ISO)`
- `updatedAt: string (ISO)`

### 5.2 Store File

Single file schema:

```json
{
  "version": 1,
  "updatedAt": "2026-01-24T00:00:00.000Z",
  "configs": [ /* Profile[] */ ]
}
```

## 6. Local Encrypted Storage

### 6.1 Location

- Use Electron `app.getPath('userData')`
- Store file: `configs.v1.enc`

### 6.2 Encryption

- Use Electron `safeStorage.encryptString/decryptString`
- Persist encrypted Buffer as base64 text
- Write atomically via temp file + rename

### 6.3 Migration

- If encrypted store does not exist: try importing legacy `configs/*.json` as seed profiles.
- If import fails/empty: create default profiles: `Claude Code`, `Codex`, `OpenCode`.

### 6.4 Corruption Handling

- On decrypt/parse failure: rename to `configs.v1.enc.corrupt.<timestamp>.bak`
- Recreate a fresh default store so the app remains usable

## 7. IPC API

- `get-configs` -> `Profile[]`
- `save-config(Profile)` -> upsert (update by `id`; create if no `id`)
- `delete-config(configId: string)` -> delete by id

## 8. UI / UX

- "Manage templates": list + add/edit/delete
- "Create terminal": pick any profile to start a session
- Editor fields:
  - working directory picker
  - startup script
  - environment variables (one `KEY=VALUE` per line)

## 9. Acceptance Criteria

- Unlimited profiles can be created/edited/deleted and the UI updates correctly.
- Deletion is by `id` (profiles with the same name do not collide).
- Store lives under `userData` and is not readable plaintext JSON on disk.
- Legacy `configs/*.json` are imported on first run after upgrade.
- Corrupted store triggers automatic recovery and produces a backup file.

