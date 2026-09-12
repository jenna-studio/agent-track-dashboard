# Agent Track Dashboard — Codex Instructions

## Using the agent-track MCP

### Starting a task
When calling `start_task`, always include:
- **`tags`** — pick all that apply from: `frontend`, `backend`, `api`, `database`, `ui`, `testing`, `bug`, `feature`, `refactor`, `performance`, `security`, `documentation`, `devops`, `config`, `styling`, `cleanup`, `hotfix`, `research`, `review`
- **`importance`** — set appropriately (`critical`, `high`, `medium`, `low`)
- **`description`** — brief sentence explaining what the task involves

Each task must represent **one single piece of work**. Do not bundle multiple unrelated changes into one task card. Create a separate task for each distinct unit of work.

### Completing a task
Before calling `complete_task`, always call `add_comment` first with:
- A summary of what was done
- Any relevant decisions made or gotchas encountered
- Files changed and why

Example flow:
```
add_comment(taskId, author="Codex", content="Fixed the null check in server.ts — the issue was ...")
complete_task(taskId, summary="Fixed null check bug")
```

### Updating progress
Call `update_task_progress` when switching between files or finishing a significant step, not just at the end.
