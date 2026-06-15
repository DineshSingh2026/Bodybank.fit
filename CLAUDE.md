# BodyBank — Claude agent notes

## TodoWrite is disabled in this repo

`.claude/settings.json` includes `permissions.deny`: `["TodoWrite"]` so Claude Code / **Claude for VS Code** will not run the TodoWrite tool here. That avoids a known failure mode: invalid or unsupported `status` values (the extension only allows `pending`, `in_progress`, `completed`) and a broken error banner (`Unhandled case: [object Object]`).

**Use markdown task lists or numbered steps in prose** instead of TodoWrite.

See `.claude/CLAUDE.md` for the same policy in project-scoped memory.
