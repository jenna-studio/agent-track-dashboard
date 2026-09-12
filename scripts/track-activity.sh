#!/bin/bash
#
# Claude Code Hook: Track agent activity on the dashboard
# Receives hook JSON via stdin, calls the API server to log activity.
# Captures code diffs from Edit/Write/NotebookEdit tools.
# Each file edit gets its own dedicated task card.
#

API_URL="${AGENT_TRACK_API_URL:-http://localhost:3000}/api"

# State is per project: a single shared file meant two projects open at once
# clobbered each other's board/agent ids and stranded their task cards.
PROJECT_KEY=$(printf '%s' "$PWD" | shasum 2>/dev/null | cut -c1-16)
[ -z "$PROJECT_KEY" ] && PROJECT_KEY="default"
STATE_DIR="${TMPDIR:-/tmp}/agent-track"
STATE_FILE="$STATE_DIR/session-$PROJECT_KEY.json"
mkdir -p "$STATE_DIR" 2>/dev/null

# Which AI tool is driving this hook? Never assume Claude.
detect_agent() {
  if [ -n "$AGENT_TRACK_AGENT_NAME" ]; then
    AGENT_NAME="$AGENT_TRACK_AGENT_NAME"
    AGENT_TYPE="${AGENT_TRACK_AGENT_TYPE:-$(printf '%s' "$AGENT_NAME" | tr '[:upper:] ' '[:lower:]-')}"
  elif [ -n "$CLAUDECODE" ] || [ -n "$CLAUDE_CODE_ENTRYPOINT" ]; then
    AGENT_NAME="Claude Code"; AGENT_TYPE="claude-code"
  elif [ -n "$CODEX_SANDBOX" ] || [ -n "$CODEX_HOME" ] || [ -n "$CODEX_THREAD_ID" ]; then
    AGENT_NAME="Codex"; AGENT_TYPE="codex"
  elif [ -n "$GEMINI_CLI" ] || [ -n "$GEMINI_SANDBOX" ] || [ -n "$GEMINI_SESSION_ID" ]; then
    AGENT_NAME="Gemini CLI"; AGENT_TYPE="gemini"
  elif [ -n "$CURSOR_AGENT" ] || [ -n "$CURSOR_TRACE_ID" ]; then
    AGENT_NAME="Cursor"; AGENT_TYPE="cursor"
  elif [ -n "$AI_AGENT" ]; then
    AGENT_NAME="${AI_AGENT%%_*}"; AGENT_TYPE="$AGENT_NAME"
  else
    AGENT_NAME="Unknown Agent"; AGENT_TYPE="unknown"
  fi
  export AGENT_NAME AGENT_TYPE
}
detect_agent

# Read hook input from stdin
INPUT=$(cat)
HOOK_TYPE="${CLAUDE_HOOK_EVENT:-unknown}"

# Helper: silent curl POST
api_post() {
  curl -s -X POST "$API_URL/$1" \
    -H "Content-Type: application/json" \
    -d "$2" 2>/dev/null
}

api_patch() {
  curl -s -X PATCH "$API_URL/$1" \
    -H "Content-Type: application/json" \
    -d "$2" 2>/dev/null
}

api_delete() {
  curl -s -X DELETE "$API_URL/$1" 2>/dev/null
}

# Check if API server is reachable
if ! curl -s --max-time 1 "$API_URL/../health" >/dev/null 2>&1; then
  exit 0
fi

case "$HOOK_TYPE" in
  SessionStart)
    # Get the newest board for the current project, falling back to the newest board overall
    BOARD_ID="$AGENT_TRACK_BOARD_ID"
    if [ -z "$BOARD_ID" ]; then
      # The project path goes in as an argument: a "VAR=x cmd | python3" prefix
      # only sets the variable for the first command in the pipeline, so python
      # never saw it and every session silently matched zero boards.
      BOARD_ID=$(curl -s "$API_URL/boards" 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
boards = data.get('data', [])
project_path = sys.argv[1]
matching = [board for board in boards if board.get('projectPath') == project_path]
# Newest board for THIS project; never silently fall back to another
# project's board, which used to scatter cards across boards.
matching.sort(key=lambda b: str(b.get('createdAt') or ''), reverse=True)
print(matching[0].get('id', '') if matching else '')
" "$PWD" 2>/dev/null)
    fi

    if [ -z "$BOARD_ID" ]; then
      exit 0
    fi

    # Register agent
    AGENT_RESULT=$(api_post "agents" "$(cat <<EOF
{
  "name": "$AGENT_NAME",
  "type": "$AGENT_TYPE",
  "status": "active",
  "capabilities": ["code-generation", "code-review", "debugging", "refactoring"],
  "maxConcurrentTasks": 3,
  "lastHeartbeat": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)")

    AGENT_ID=$(echo "$AGENT_RESULT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('data', {}).get('id', ''))
" 2>/dev/null)

    SESSION_ID="hook-session-$(date +%s)"

    # Save session state — no task created upfront
    # Each file edit will get its own task card
    cat > "$STATE_FILE" <<EOF
{
  "boardId": "$BOARD_ID",
  "agentId": "$AGENT_ID",
  "sessionId": "$SESSION_ID",
  "fileTasks": {}
}
EOF
    ;;

  PostToolUse)
    # Track file edits — one task per file
    if [ ! -f "$STATE_FILE" ]; then
      exit 0
    fi

    # Send heartbeat to keep agent online
    AGENT_ID=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('agentId',''))" 2>/dev/null)
    if [ -n "$AGENT_ID" ]; then
      api_patch "agents/$AGENT_ID" "{\"lastHeartbeat\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" >/dev/null 2>&1 &
    fi

    TOOL_NAME=$(echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('tool_name', data.get('toolName', '')))
" 2>/dev/null)

    # Only track file-modifying tools
    case "$TOOL_NAME" in
      Edit|Write|NotebookEdit)
        # One task per file: create a new task if file hasn't been seen yet,
        # otherwise update the existing task for that file.
        # NOTE: the program itself arrives on stdin via the heredoc, so the
        # hook payload has to come through the environment instead. Piping it
        # in was silently discarded and this block never ran.
        HOOK_INPUT="$INPUT" STATE_FILE="$STATE_FILE" AGENT_TRACK_API_URL="$AGENT_TRACK_API_URL" python3 << 'PYEOF'
import sys, json, os, urllib.request

API_URL = (os.environ.get("AGENT_TRACK_API_URL") or "http://localhost:3000") + "/api"
STATE_FILE = os.environ.get("STATE_FILE", "")
AGENT_NAME = os.environ.get("AGENT_NAME", "Unknown Agent")
AGENT_TYPE = os.environ.get("AGENT_TYPE", "unknown")

def detect_language(filepath):
    ext_map = {
        '.ts': 'typescript', '.tsx': 'typescriptreact',
        '.js': 'javascript', '.jsx': 'javascriptreact',
        '.py': 'python', '.rb': 'ruby', '.go': 'go',
        '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
        '.swift': 'swift', '.c': 'c', '.h': 'c',
        '.cpp': 'cpp', '.cc': 'cpp', '.cs': 'csharp',
        '.php': 'php', '.html': 'html', '.css': 'css',
        '.scss': 'scss', '.json': 'json', '.yaml': 'yaml',
        '.yml': 'yaml', '.md': 'markdown', '.sh': 'shellscript',
        '.sql': 'sql', '.xml': 'xml', '.vue': 'vue',
        '.svelte': 'svelte',
    }
    _, ext = os.path.splitext(filepath)
    return ext_map.get(ext, '')

def http_post(path, data):
    try:
        req = urllib.request.Request(
            f"{API_URL}/{path}",
            data=json.dumps(data).encode('utf-8'),
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        return {}

def http_patch(path, data):
    try:
        req = urllib.request.Request(
            f"{API_URL}/{path}",
            data=json.dumps(data).encode('utf-8'),
            headers={'Content-Type': 'application/json'},
            method='PATCH'
        )
        urllib.request.urlopen(req, timeout=3)
    except Exception:
        pass

try:
    hook_data = json.loads(os.environ.get("HOOK_INPUT") or "")
except Exception:
    sys.exit(0)

tool_name = hook_data.get('tool_name', hook_data.get('toolName', ''))
tool_input = hook_data.get('tool_input', hook_data.get('input', {}))

if not isinstance(tool_input, dict):
    sys.exit(0)

# Read state
try:
    with open(STATE_FILE) as f:
        state = json.load(f)
except Exception:
    sys.exit(0)

board_id   = state.get('boardId', '')
agent_id   = state.get('agentId', '')
file_tasks = state.get('fileTasks', {})  # file_path -> task_id

file_path = tool_input.get('file_path', tool_input.get('filePath', tool_input.get('notebook_path', '')))

if not file_path:
    sys.exit(0)

basename = os.path.basename(file_path)

# Determine is_new_file BEFORE building tags so the tag is accurate
task_id = file_tasks.get(file_path)
is_new_file = task_id is None

# Build tags: language + change type
lang = detect_language(file_path)
tags = []
if lang:
    tags.append(lang)
if tool_name == 'Write':
    tags.append('new-file' if is_new_file else 'edit')
elif tool_name == 'NotebookEdit':
    tags.append('notebook')
else:
    tags.append('edit')

# --- Get or create a dedicated task for this file ---

def http_get(path):
    try:
        with urllib.request.urlopen(f"{API_URL}/{path}", timeout=3) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        return {}


def find_open_task(board, path, title):
    """Reuse a card the keeper (or an earlier run) already opened for this file."""
    for status in ("in_progress", "claimed", "todo"):
        data = http_get(f"tasks?boardId={board}&status={status}").get("data") or []
        for t in data:
            if t.get("title") == title or path in (t.get("files") or []):
                return t.get("id", "")
    return ""


title = f"Edit {basename}"

if not task_id:
    task_id = find_open_task(board_id, file_path, title)
    if task_id:
        file_tasks[file_path] = task_id
        state['fileTasks'] = file_tasks
        with open(STATE_FILE, 'w') as f:
            json.dump(state, f)

if not task_id:
    resp = http_post("tasks", {
        "boardId":   board_id,
        "title":     title,
        "description": f"Editing `{file_path}`",
        "importance": "medium",
        "status":    "in_progress",
        "agentId":   agent_id,
        "agentName": AGENT_NAME,
        "agentType": AGENT_TYPE,
        "progress":  0,
        "files":     [file_path],
        "tags":      tags,
    })
    task_id = (resp.get('data') or {}).get('id', '')
    if task_id:
        file_tasks[file_path] = task_id
        state['fileTasks'] = file_tasks
        with open(STATE_FILE, 'w') as f:
            json.dump(state, f)

if not task_id:
    sys.exit(0)

# --- Build code change ---
code_change = {
    'filePath': file_path,
    'language': detect_language(file_path),
}

if tool_name == 'Edit':
    old_string = tool_input.get('old_string', '')
    new_string = tool_input.get('new_string', '')

    old_lines = old_string.split('\n') if old_string else []
    new_lines = new_string.split('\n') if new_string else []

    diff_parts = []
    diff_parts.append(f'--- a/{basename}')
    diff_parts.append(f'+++ b/{basename}')
    diff_parts.append(f'@@ -{1},{len(old_lines)} +{1},{len(new_lines)} @@')
    for line in old_lines:
        diff_parts.append(f'-{line}')
    for line in new_lines:
        diff_parts.append(f'+{line}')

    code_change['changeType'] = 'modified'
    code_change['diff'] = '\n'.join(diff_parts)
    code_change['linesAdded'] = len(new_lines)
    code_change['linesDeleted'] = len(old_lines)

elif tool_name == 'Write':
    content = tool_input.get('content', '')
    lines = content.split('\n') if content else []
    line_count = len(lines)

    max_lines = 100
    capped = lines[:max_lines]

    code_change['changeType'] = 'added' if is_new_file else 'modified'

    diff_parts = []
    if not is_new_file:
        diff_parts.append(f'--- a/{basename}')
    diff_parts.append(f'+++ b/{basename}')
    diff_parts.append(f'@@ -0,0 +1,{line_count} @@')
    for line in capped:
        diff_parts.append(f'+{line}')
    if line_count > max_lines:
        diff_parts.append(f'+... ({line_count - max_lines} more lines)')

    code_change['diff'] = '\n'.join(diff_parts)
    code_change['linesAdded'] = line_count
    code_change['linesDeleted'] = 0

elif tool_name == 'NotebookEdit':
    new_source = tool_input.get('new_source', '')
    lines = new_source.split('\n') if new_source else []

    code_change['changeType'] = 'modified'
    diff_parts = [f'+++ b/{basename}']
    diff_parts.append('@@ notebook cell @@')
    for line in lines[:50]:
        diff_parts.append(f'+{line}')
    if len(lines) > 50:
        diff_parts.append(f'+... ({len(lines) - 50} more lines)')
    code_change['diff'] = '\n'.join(diff_parts)
    code_change['linesAdded'] = len(lines)
    code_change['linesDeleted'] = 0

# Submit code change
if 'diff' in code_change:
    http_post(f"tasks/{task_id}/code-changes", code_change)

# Update task action
http_patch(f"tasks/{task_id}", {
    'currentAction': f'Editing {basename}',
    'files': [file_path],
})

PYEOF
        ;;
    esac
    ;;

  Stop|SessionEnd)
    # Stop fires at the end of EVERY assistant turn, SessionEnd once at the end.
    # Completing the turn's cards on Stop is what moves them out of In Progress;
    # only SessionEnd tears the session down. Deleting state on Stop used to
    # kill tracking for the rest of the session.
    if [ ! -f "$STATE_FILE" ]; then
      exit 0
    fi

    HOOK_EVENT="$HOOK_TYPE" STATE_FILE="$STATE_FILE" AGENT_TRACK_API_URL="$AGENT_TRACK_API_URL" python3 << 'PYEOF'
import json, os, urllib.request

API_URL = (os.environ.get("AGENT_TRACK_API_URL") or "http://localhost:3000") + "/api"
STATE_FILE = os.environ.get("STATE_FILE", "")
IS_SESSION_END = os.environ.get("HOOK_EVENT") == "SessionEnd"

def http_patch(path, data):
    try:
        req = urllib.request.Request(
            f"{API_URL}/{path}",
            data=json.dumps(data).encode('utf-8'),
            headers={'Content-Type': 'application/json'},
            method='PATCH'
        )
        urllib.request.urlopen(req, timeout=3)
    except Exception:
        pass

try:
    with open(STATE_FILE) as f:
        state = json.load(f)
except Exception:
    raise SystemExit(0)

agent_id   = state.get('agentId', '')
file_tasks = state.get('fileTasks', {})

# Every card opened during this turn is finished work — move it to Done.
for file_path, task_id in file_tasks.items():
    if task_id:
        http_patch(f"tasks/{task_id}", {
            "status":        "done",
            "progress":      100,
            "currentAction": "Completed",
        })

# Clear the per-turn card map but keep the session: the next turn's edits
# open fresh cards instead of being dropped on the floor.
state['fileTasks'] = {}
try:
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f)
except Exception:
    pass

if agent_id:
    http_patch(f"agents/{agent_id}", {"status": "idle" if IS_SESSION_END else "active"})
    if IS_SESSION_END:
        try:
            req = urllib.request.Request(f"{API_URL}/agents/{agent_id}", method='DELETE')
            urllib.request.urlopen(req, timeout=3)
        except Exception:
            pass

PYEOF

    # Only a real session end removes the state file.
    if [ "$HOOK_TYPE" = "SessionEnd" ]; then
      rm -f "$STATE_FILE"
    fi
    ;;
esac

exit 0
