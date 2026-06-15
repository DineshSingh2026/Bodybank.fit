# BodyBank — Claude Code (this folder)

## Do not use TodoWrite

This project sets `permissions.deny` → `TodoWrite` in `.claude/settings.json` because **Claude for VS Code** validates that tool strictly (only `pending` / `in_progress` / `completed`) and the UI can show `Unhandled case: [object Object]` when validation fails.

**Do not call `TodoWrite`.** Track multi-step work in your reply using a normal markdown checklist or numbered list.

If that deny rule is removed later, every todo `status` must be exactly one of: `pending`, `in_progress`, `completed` — never `cancelled`, `done`, or `complete`.
