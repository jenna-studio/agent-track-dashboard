#!/usr/bin/env python3
"""
agent-keeper.py
---------------
Keeps the Agent Track Dashboard ALWAYS alive while you code with an AI agent.

Problems this solves:
  - Agent shows as "offline/idle" even when Claude is actively coding
  - Tasks don't sync automatically — you have to manually ask Claude to update
  - Dashboard goes stale between MCP tool calls

How it works:
  1. Starts and auto-restarts the api-server + dashboard (keeps infrastructure up)
  2. Discovers the Claude MCP agent that was registered when Claude Code started
  3. Sends heartbeats for that agent every 15s so it NEVER goes offline
  4. Watches git changes every 8s and auto-creates/updates tasks with diffs
  5. When a new commit lands, completes the old task and opens a new one
  6. Also keeps its own "monitor" agent alive as fallback

Usage:
    # Monitor current directory (most common — run from your project folder)
    python /path/to/agent-track-dashboard/scripts/agent-keeper.py

    # Monitor a specific project
    python /path/to/agent-track-dashboard/scripts/agent-keeper.py /path/to/project

    # If api-server + dashboard are already running
    python /path/to/agent-track-dashboard/scripts/agent-keeper.py --no-api --no-dashboard
"""

import subprocess
import threading
import time
import sys
import signal
import uuid
import json
import argparse
import os
import fcntl
import hashlib
import tempfile
from pathlib import Path
from datetime import datetime
import urllib.request
import urllib.error
import urllib.parse

# ── paths ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR      = Path(__file__).parent.resolve()
DASHBOARD_ROOT  = SCRIPT_DIR.parent
API_SERVER_DIST = DASHBOARD_ROOT / "packages" / "api-server" / "dist" / "index.js"
DASHBOARD_PKG   = DASHBOARD_ROOT / "packages" / "dashboard"

API_URL        = "http://localhost:3000"
POLL_SEC       = 8    # how often to check for git changes
HEARTBEAT_SEC  = 15   # how often to send heartbeats (must be < 5 min to stay "active")
IDLE_CLOSE_SEC = 180  # close task after this many seconds of no changes

LOCK_DIR = Path(tempfile.gettempdir()) / "agent-track-keeper"

# Held for the lifetime of the process; flock is released automatically on exit.
_LOCK_FH = None


def acquire_singleton_lock(project: Path) -> bool:
    """
    Allow only one keeper per project.

    Every MCP server startup used to spawn another keeper, and they never
    exited — a dozen of them would race to create a card for the same file,
    which is where the duplicate task cards came from.
    """
    global _LOCK_FH
    try:
        LOCK_DIR.mkdir(parents=True, exist_ok=True)
        key = hashlib.sha1(str(project).encode()).hexdigest()[:16]
        fh = open(LOCK_DIR / f"{key}.lock", "w")
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return False
    except Exception:
        # Never let locking problems stop tracking entirely.
        return True
    fh.write(str(os.getpid()))
    fh.flush()
    _LOCK_FH = fh
    return True


# ── agent identity ────────────────────────────────────────────────────────────
# (name, type, identifying env vars, AI_AGENT aliases) — most specific first.
_AGENT_RULES = [
    ("Claude Code",    "claude-code", ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID"], ["claude"]),
    ("Codex",          "codex",       ["CODEX_SANDBOX", "CODEX_HOME", "CODEX_THREAD_ID"],                 ["codex"]),
    ("Gemini CLI",     "gemini",      ["GEMINI_CLI", "GEMINI_SANDBOX", "GEMINI_SESSION_ID"],              ["gemini"]),
    ("Cursor",         "cursor",      ["CURSOR_AGENT", "CURSOR_TRACE_ID"],                                ["cursor"]),
    ("GitHub Copilot", "copilot",     ["COPILOT_AGENT_ID", "GITHUB_COPILOT_AGENT"],                       ["copilot"]),
    ("Windsurf",       "windsurf",    ["WINDSURF_SESSION_ID", "WINDSURF_AGENT"],                          ["windsurf", "codeium"]),
    ("Aider",          "aider",       ["AIDER_MODEL", "AIDER_SESSION"],                                   ["aider"]),
]


def detect_agent_identity():
    """Work out which AI tool we are tracking. Never assume Claude."""
    name = os.environ.get("AGENT_TRACK_AGENT_NAME")
    typ = os.environ.get("AGENT_TRACK_AGENT_TYPE")
    if name or typ:
        slug = typ or name.lower().replace(" ", "-")
        return {"name": name or slug.replace("-", " ").title(), "type": slug}

    generic = (os.environ.get("AI_AGENT") or "").strip()
    slug = generic.split("_")[0].lower() if generic else ""

    for disp, kind, envs, aliases in _AGENT_RULES:
        if any(os.environ.get(e) for e in envs) or any(a in slug for a in aliases):
            return {"name": disp, "type": kind}

    if slug:
        return {"name": slug.replace("-", " ").title(), "type": slug}
    return {"name": "Unknown Agent", "type": "unknown"}


# ── stdlib HTTP helpers ────────────────────────────────────────────────────────

def _http(method: str, url: str, body=None, timeout=5):
    data    = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    req     = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {}
    except Exception:
        return {}


def GET(path, params=None):
    url = f"{API_URL}{path}"
    if params:
        url += "?" + "&".join(f"{k}={urllib.parse.quote(str(v))}"
                               for k, v in params.items() if v is not None)
    return _http("GET", url)


def POST(path, body):
    return _http("POST", f"{API_URL}{path}", body)


def PATCH(path, body):
    return _http("PATCH", f"{API_URL}{path}", body)


def api_ready():
    try:
        r = GET("/health")
        return bool(r)
    except Exception:
        return False


# ── git helpers ───────────────────────────────────────────────────────────────

def _git(args, cwd, timeout=12):
    try:
        r = subprocess.run(["git"] + args, cwd=str(cwd),
                           capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip()
    except Exception:
        return ""


def git_head(cwd):           return _git(["rev-parse", "HEAD"], cwd) or None
def git_branch(cwd):         return _git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
def git_status_short(cwd):   return _git(["status", "--short"], cwd)
def git_log_oneline(cwd, n=5): return _git(["log", "--oneline", f"-{n}"], cwd)


NOISE_DIRS = {
    "node_modules", "dist", "build", ".git", ".next", ".nuxt",
    "__pycache__", ".venv", "venv", ".tox", "coverage", ".nyc_output",
    ".cache", ".parcel-cache", ".turbo", "out", ".output", "vendor",
}
NOISE_EXTS = {".lock", ".log", ".map", ".pyc", ".pyo"}

def _is_noise(file_path: str) -> bool:
    parts = Path(file_path).parts
    if any(p in NOISE_DIRS for p in parts):
        return True
    if Path(file_path).suffix in NOISE_EXTS:
        return True
    return False


def git_changed_files(cwd):
    """Uncommitted changes (staged + unstaged + untracked), noise-filtered."""
    files = []
    type_map = {"M": "modified", "A": "added", "D": "deleted", "R": "renamed", "C": "copied"}

    # staged + unstaged vs HEAD
    out = _git(["diff", "--name-status", "HEAD"], cwd)
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            fp = parts[-1]
            if not _is_noise(fp):
                files.append({"filePath": fp,
                              "changeType": type_map.get(parts[0][0], "modified")})

    # untracked new files
    for f in _git(["ls-files", "--others", "--exclude-standard"], cwd).splitlines():
        if f and not _is_noise(f):
            files.append({"filePath": f, "changeType": "added"})

    return files


def git_numstat(cwd):
    added = removed = 0
    for line in _git(["diff", "HEAD", "--numstat"], cwd).splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            try:
                added   += int(parts[0]) if parts[0] != "-" else 0
                removed += int(parts[1]) if parts[1] != "-" else 0
            except ValueError:
                pass
    return {"added": added, "removed": removed}


def git_file_diff(path, cwd):
    return _git(["diff", "HEAD", "--", path], cwd, timeout=20)


def _task_title_from_files(changed):
    paths = [f["filePath"] for f in changed]
    if not paths:
        return "Working on project"
    if len(paths) == 1:
        return f"Editing {paths[0]}"
    names  = [Path(p).name for p in paths[:3]]
    suffix = f" (+{len(paths)-3} more)" if len(paths) > 3 else ""
    return f"Editing {', '.join(names)}{suffix}"


# ── keeper ────────────────────────────────────────────────────────────────────

class AgentKeeper:

    def __init__(self, project_path: Path, start_api=True, start_dashboard=True):
        self.project    = project_path.resolve()
        self.start_api  = start_api
        self.start_dash = start_dashboard
        self.running    = True

        self.api_proc   = None
        self.dash_proc  = None

        # Our own monitor agent (always present)
        self.monitor_id = f"keeper-{uuid.uuid4().hex[:8]}"

        # The real Claude / MCP agent we discover at runtime
        self.mcp_agent_id   = None  # set once we find it
        self.mcp_agent_name = None

        self.identity         = detect_agent_identity()

        self.board_id         = None
        # file_path -> {"id", "title", "sig", "last_change"}
        self.file_tasks       = {}
        self.submitted_diffs  = {}   # file_path -> last diff signature submitted
        # file_path -> signature we last CLOSED a card on. A dirty file stays
        # dirty until it is committed, so without this a closed card would be
        # recreated on the very next poll, forever.
        self.closed_sigs      = {}
        self.last_hash        = None
        self.last_change_ts   = 0.0

        self._beat_ts_monitor  = 0.0
        self._beat_ts_mcp      = 0.0

    # ── infrastructure management ─────────────────────────────────────────────

    def _run_api_server(self):
        while self.running:
            if not API_SERVER_DIST.exists():
                print(f"[keeper] api-server dist missing — run: pnpm build:api  (from {DASHBOARD_ROOT})")
                time.sleep(20)
                continue
            print("[keeper] Starting api-server…")
            self.api_proc = subprocess.Popen(
                ["node", str(API_SERVER_DIST)],
                cwd=str(DASHBOARD_ROOT),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            self.api_proc.wait()
            if self.running:
                print("[keeper] api-server crashed — restarting in 3s…")
                time.sleep(3)

    def _run_dashboard(self):
        while self.running:
            if not DASHBOARD_PKG.exists():
                time.sleep(10)
                continue
            print("[keeper] Starting dashboard…")
            self.dash_proc = subprocess.Popen(
                ["pnpm", "dev"],
                cwd=str(DASHBOARD_PKG),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            self.dash_proc.wait()
            if self.running:
                print("[keeper] dashboard crashed — restarting in 3s…")
                time.sleep(3)

    def _wait_for_api(self, max_s=60):
        print("[keeper] Waiting for API server", end="", flush=True)
        for _ in range(max_s):
            if api_ready():
                print(" ready!", flush=True)
                return True
            print(".", end="", flush=True)
            time.sleep(1)
        print(" TIMEOUT", flush=True)
        return False

    # ── board setup ───────────────────────────────────────────────────────────

    def _setup_board(self):
        project_str = str(self.project)

        # An explicit board wins: the MCP server passes this so the keeper, the
        # hook and the MCP tools all write to one board instead of three.
        pinned = os.environ.get("AGENT_TRACK_BOARD_ID")
        if pinned:
            self.board_id = pinned
            print(f"[keeper] Board pinned : {self.board_id}")
            return

        resp = GET("/api/boards")
        matching = [b for b in (resp.get("data") or [])
                    if b.get("projectPath") == project_str]
        if matching:
            # Newest first — the API orders by updated_at, but be explicit
            # rather than depending on it.
            matching.sort(key=lambda b: str(b.get("createdAt") or ""), reverse=True)
            board = matching[0]
            self.board_id = board["id"]
            print(f"[keeper] Board found  : {board.get('name')} ({self.board_id})")
            return

        log  = git_log_oneline(self.project, 3)
        resp = POST("/api/boards", {
            "name":        self.project.name,
            "description": f"Auto-created by agent-keeper\n\nRecent commits:\n{log}",
            "projectPath": project_str,
        })
        self.board_id = (resp.get("data") or {}).get("id")
        print(f"[keeper] Board created: {self.project.name} ({self.board_id})")

    # ── agent management ──────────────────────────────────────────────────────

    def _register_monitor_agent(self):
        POST("/api/agents", {
            "id":           self.monitor_id,
            "name":         "Agent Keeper (monitor)",
            "type":         "monitor",
            "status":       "active",
            "capabilities": ["monitoring", "git_tracking", "heartbeat"],
            "lastHeartbeat": int(time.time() * 1000),
        })

    def _discover_mcp_agent(self):
        """
        Find the most recently active Claude/AI agent that was registered
        by the MCP server (not our own monitor agent).
        """
        resp = GET("/api/agents")
        agents = resp.get("data") or []
        # Filter to non-monitor agents, sort by lastHeartbeat desc
        candidates = [
            a for a in agents
            if a.get("id") != self.monitor_id
            and a.get("type") not in ("monitor",)
        ]
        if not candidates:
            return None
        # pick most recently active
        candidates.sort(key=lambda a: a.get("lastHeartbeat") or 0, reverse=True)
        agent = candidates[0]
        return agent

    def _beat_monitor(self):
        now = time.time()
        if now - self._beat_ts_monitor < HEARTBEAT_SEC:
            return
        self._beat_ts_monitor = now
        PATCH(f"/api/agents/{self.monitor_id}", {
            "status":        "active",
            "lastHeartbeat": int(now * 1000),
        })

    def _beat_mcp_agent(self):
        """Refresh heartbeat on the REAL Claude MCP agent so it never goes offline."""
        now = time.time()
        if now - self._beat_ts_mcp < HEARTBEAT_SEC:
            return
        self._beat_ts_mcp = now

        # Re-discover in case Claude restarted and registered a new agent ID
        agent = self._discover_mcp_agent()
        if not agent:
            return

        aid = agent["id"]
        if aid != self.mcp_agent_id:
            self.mcp_agent_id   = aid
            self.mcp_agent_name = agent.get("name", aid)
            print(f"[keeper] Tracking MCP agent: {self.mcp_agent_name} ({aid})")

        PATCH(f"/api/agents/{aid}", {
            "status":        "active",
            "lastHeartbeat": int(now * 1000),
        })
        self._notify("agent_heartbeat", {"agentId": aid})

    # ── notify WebSocket ──────────────────────────────────────────────────────

    def _notify(self, event, data=None):
        POST("/api/notify", {
            "event":   event,
            "boardId": self.board_id,
            "data":    data or {},
        })

    # ── task helpers ──────────────────────────────────────────────────────────

    def _agent_id_for_task(self):
        """Prefer the real MCP agent; fall back to monitor."""
        return self.mcp_agent_id or self.monitor_id

    def _agent_name_for_task(self):
        # Prefer the agent the MCP server registered (it knows exactly which
        # tool it serves); otherwise fall back to environment detection.
        return self.mcp_agent_name or self.identity["name"]

    def _agent_type_for_task(self):
        return self.identity["type"]

    def _create_task(self, title, description="", status="in_progress"):
        if not self.board_id:
            return None
        resp = POST("/api/tasks", {
            "boardId":     self.board_id,
            "title":       title,
            "description": description,
            "agentId":     self._agent_id_for_task(),
            "agentName":   self._agent_name_for_task(),
            "agentType":   self._agent_type_for_task(),
            "status":      status,
            "importance":  "high",
            "progress":    0,
        })
        task = resp.get("data") or {}
        if task.get("id"):
            self._notify("task_created", {"taskId": task["id"]})
            print(f"[keeper] Task created : {task['id']} — {title}")
        return task

    def _complete_file_task(self, file_path, reason):
        """Move a single file's card to Done and remember what we closed on."""
        task = self.file_tasks.pop(file_path, None)
        if not task:
            return
        PATCH(f"/api/tasks/{task['id']}", {
            "status":        "done",
            "progress":      100,
            "currentAction": reason,
        })
        self._notify("task_updated", {"taskId": task["id"]})
        if task.get("sig"):
            self.closed_sigs[file_path] = task["sig"]
        self.submitted_diffs.pop(file_path, None)
        print(f"[keeper] Task done    : {task['id']}  ({Path(file_path).name}) — {reason}")

    def _complete_all_tasks(self, summary=""):
        for file_path in list(self.file_tasks):
            self._complete_file_task(file_path, summary or "Completed")

    def _find_existing_open_task(self, file_path, title):
        """
        Reuse a card another writer already opened for this file — the activity
        hook, or a keeper from a previous run. Without this every writer opens
        its own card for the same file.
        """
        for status in ("in_progress", "claimed", "todo"):
            resp = GET("/api/tasks", {"boardId": self.board_id, "status": status})
            for t in (resp.get("data") or []):
                files = t.get("files") or []
                if t.get("title") == title or file_path in files:
                    return {"id": t["id"], "title": t.get("title") or title}
        return None

    def _ensure_file_task(self, file_path, change_type, branch):
        """Get or create the single dedicated task for one file."""
        if file_path in self.file_tasks:
            return self.file_tasks[file_path]

        basename = Path(file_path).name
        title = f"Edit {basename}"

        existing = self._find_existing_open_task(file_path, title)
        if existing:
            self.file_tasks[file_path] = {
                "id": existing["id"], "title": existing["title"],
                "sig": None, "last_change": time.time(),
            }
            return self.file_tasks[file_path]

        desc = f"Branch: `{branch}`\nFile: `{file_path}` ({change_type})"
        task = self._create_task(title, desc)
        if task and task.get("id"):
            self.file_tasks[file_path] = {
                "id": task["id"], "title": title,
                "sig": None, "last_change": time.time(),
            }
            return self.file_tasks[file_path]
        return None

    def _file_signature(self, file_path):
        """Fingerprint of a file's current uncommitted content."""
        diff = git_file_diff(file_path, self.project)
        return hashlib.sha1((diff or "").encode("utf-8", "replace")).hexdigest(), diff

    # ── git sync ──────────────────────────────────────────────────────────────

    def _sync_changes(self):
        changed  = git_changed_files(self.project)
        self.last_hash = git_head(self.project)

        now = time.time()
        changed_paths = {fi["filePath"] for fi in changed}

        # A tracked file that is no longer dirty was committed or reverted.
        # That is the clearest "this piece of work is finished" signal we get.
        for file_path in list(self.file_tasks):
            if file_path not in changed_paths:
                self._complete_file_task(file_path, "Committed")
                self.closed_sigs.pop(file_path, None)

        # Cap to 5 files per cycle to avoid task explosion
        MAX_FILES = 5
        if len(changed) > MAX_FILES:
            print(f"[keeper] {len(changed)} changed files — capping to {MAX_FILES}")
            changed = changed[:MAX_FILES]

        branch = git_branch(self.project)
        lines  = git_numstat(self.project)

        for fi in changed:
            file_path   = fi["filePath"]
            change_type = fi["changeType"]

            sig, diff = self._file_signature(file_path)

            # We already closed a card on exactly this content. Only a real new
            # edit should reopen work for this file.
            if self.closed_sigs.get(file_path) == sig:
                continue

            task = self._ensure_file_task(file_path, change_type, branch)
            if not task:
                continue

            # Nothing actually changed since the last poll — leave the card
            # alone so its idle timer can run down and close it.
            if task.get("sig") == sig:
                continue

            task["sig"] = sig
            task["last_change"] = now
            self.last_change_ts = now

            tid  = task["id"]
            prog = min(10 + (lines["added"] + lines["removed"]) // 4, 85)

            PATCH(f"/api/tasks/{tid}", {
                "status":        "in_progress",
                "files":         [file_path],
                "currentAction": f"Modifying {Path(file_path).name}",
                "progress":      prog,
            })

            if diff and self.submitted_diffs.get(file_path) != sig:
                POST(f"/api/tasks/{tid}/code-changes", {
                    "filePath":     file_path,
                    "changeType":   change_type,
                    "diff":         diff,
                    "linesAdded":   lines["added"],
                    "linesRemoved": lines["removed"],
                })
                self.submitted_diffs[file_path] = sig

            self._notify("task_updated", {"taskId": tid})

        # Close any card whose file has stopped changing. This is per file, so
        # finished work moves to Done while other files are still being edited.
        for file_path, task in list(self.file_tasks.items()):
            if now - task.get("last_change", now) >= IDLE_CLOSE_SEC:
                self._complete_file_task(file_path, "No further changes")

        if changed:
            print(f"[keeper] Synced {len(changed):2d} file(s) +{lines['added']}/-{lines['removed']} lines")

    # ── main loop ─────────────────────────────────────────────────────────────

    def _watch_loop(self):
        print(f"[keeper] Polling every {POLL_SEC}s — heartbeat every {HEARTBEAT_SEC}s")
        print(f"[keeper] Dashboard: http://localhost:5173/board/{self.board_id}\n")
        while self.running:
            try:
                # Always beat our own monitor agent
                self._beat_monitor()
                # Always refresh the real MCP agent's heartbeat
                self._beat_mcp_agent()
                # Sync git changes (this also closes cards that went idle)
                self._sync_changes()
            except Exception as e:
                print(f"[keeper] Loop error: {e}")
            time.sleep(POLL_SEC)

    # ── startup ───────────────────────────────────────────────────────────────

    def start(self):
        print("=" * 60)
        print("  Agent Track Keeper")
        print(f"  project : {self.project}")
        print(f"  monitor : {self.monitor_id}")
        print("=" * 60)

        if self.start_api:
            threading.Thread(target=self._run_api_server, daemon=True,
                             name="api-server").start()
        if self.start_dash:
            threading.Thread(target=self._run_dashboard, daemon=True,
                             name="dashboard").start()

        if not self._wait_for_api(max_s=90):
            if not self.start_api:
                print("[keeper] API not reachable and --no-api was set. Exiting.")
                sys.exit(1)
            # Keep waiting — api server might still be building

        self._setup_board()
        self._register_monitor_agent()

        # Discover any MCP agent that's already running
        agent = self._discover_mcp_agent()
        if agent:
            self.mcp_agent_id   = agent["id"]
            self.mcp_agent_name = agent.get("name", agent["id"])
            print(f"[keeper] MCP agent   : {self.mcp_agent_name} ({self.mcp_agent_id})")
        else:
            print("[keeper] No MCP agent found yet — will discover once Claude starts")

        self._watch_loop()

    def stop(self):
        self.running = False
        # Don't strand cards in In Progress when the keeper goes away.
        try:
            self._complete_all_tasks("Keeper stopped")
        except Exception:
            pass
        if self.api_proc:
            self.api_proc.terminate()
        if self.dash_proc:
            self.dash_proc.terminate()
        print("[keeper] Stopped.")


# ── CLI ────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Keep Agent Track Dashboard running and auto-sync AI activity"
    )
    parser.add_argument("project", nargs="?",
                        help="Project path to monitor (default: cwd)")
    parser.add_argument("--no-api", action="store_true",
                        help="Don't start api-server (assumes it's already up)")
    parser.add_argument("--no-dashboard", action="store_true",
                        help="Don't start the dashboard dev server")
    args = parser.parse_args()

    project = Path(args.project).resolve() if args.project else Path.cwd()
    if not project.exists():
        print(f"[keeper] ERROR: path not found: {project}")
        sys.exit(1)

    if not acquire_singleton_lock(project):
        print(f"[keeper] Another keeper is already watching {project} — exiting.")
        sys.exit(0)

    keeper = AgentKeeper(project,
                         start_api=not args.no_api,
                         start_dashboard=not args.no_dashboard)

    def _sig(sig, _):
        keeper.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT,  _sig)
    signal.signal(signal.SIGTERM, _sig)
    keeper.start()


if __name__ == "__main__":
    main()
