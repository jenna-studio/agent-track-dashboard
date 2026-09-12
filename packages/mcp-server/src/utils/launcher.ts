/**
 * Auto-launcher for API server, dashboard, and browser
 *
 * When the MCP server starts, this module checks whether the API server
 * and dashboard are already running. If not, it spawns them as detached
 * background processes and opens the dashboard in the default browser.
 */

import { spawn, execFile } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as net from 'net';
import * as fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Compiled path: packages/mcp-server/dist/utils/launcher.js
// Project root is 4 levels up
const PROJECT_ROOT = resolve(__dirname, '../../../..');
const DASHBOARD_DIR = resolve(PROJECT_ROOT, 'packages/dashboard');

const API_PORT = parseInt(process.env.API_PORT || '3000');
const DASHBOARD_PORT = 5173;
const DASHBOARD_URL = `http://localhost:${DASHBOARD_PORT}`;

/**
 * Check if a TCP port is accepting connections.
 */
function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}

/**
 * Wait until a port starts accepting connections, with a timeout.
 */
async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortListening(port)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Spawn a long-running process in the background (detached & unref'd).
 * stdout/stderr are piped to /dev/null so they don't interfere with stdio MCP transport.
 */
function spawnBackground(
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): void {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  child.unref();
  console.error(`[Launcher] Spawned ${command} ${args.join(' ')} (PID ${child.pid})`);
}

/**
 * Open a URL in the user's default browser.
 */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';

  const args =
    process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

  execFile(cmd, args, (err) => {
    if (err) {
      console.error(`[Launcher] Could not open browser: ${err.message}`);
    }
  });
}

/**
 * Auto-install the latest hook template into the project's .claude/hooks/ directory,
 * and register the hooks in .claude/settings.local.json if not already present.
 * This ensures every project using this MCP gets the up-to-date hook behavior.
 */
function installHook(projectPath: string): void {
  const templatePath = resolve(PROJECT_ROOT, 'scripts/track-activity.sh');
  const claudeDir = resolve(projectPath, '.claude');
  const hooksDir = resolve(claudeDir, 'hooks');
  const destPath = resolve(hooksDir, 'track-activity.sh');
  const settingsPath = resolve(claudeDir, 'settings.local.json');

  try {
    // Copy hook script
    if (!fs.existsSync(templatePath)) {
      console.error('[Launcher] Hook template not found at', templatePath);
      return;
    }
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.copyFileSync(templatePath, destPath);
    fs.chmodSync(destPath, 0o755);
    console.error(`[Launcher] Hook installed → ${destPath}`);

    // Register hooks in settings.local.json
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      } catch {
        // malformed JSON — start fresh
      }
    }

    const hookCommand = (event: string) => `CLAUDE_HOOK_EVENT=${event} bash .claude/hooks/track-activity.sh`;
    const hookEntry = (event: string) => ({
      hooks: [{ type: 'command', command: hookCommand(event), timeout: event === 'PostToolUse' ? 3 : 5 }],
    });

    const hooks = (settings.hooks as Record<string, unknown[]> | undefined) ?? {};
    let changed = false;

    for (const [event] of [['SessionStart'], ['PostToolUse'], ['Stop'], ['SessionEnd']] as const) {
      const existing = (hooks[event] as Array<{ hooks: Array<{ command: string }> }> | undefined) ?? [];
      const alreadyRegistered = existing.some((h) =>
        h.hooks?.some((c) => c.command?.includes('track-activity.sh')),
      );
      if (!alreadyRegistered) {
        hooks[event] = [...existing, hookEntry(event)];
        changed = true;
      }
    }

    if (changed) {
      settings.hooks = hooks;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.error(`[Launcher] Hook entries added to ${settingsPath}`);
    }
  } catch (err) {
    console.error('[Launcher] Could not install hook:', err);
  }
}

/**
 * Spawn the agent-keeper Python script as a detached background process.
 * The keeper keeps agent heartbeats alive and auto-syncs git changes to the
 * dashboard — it runs for the lifetime of the coding session.
 */
function launchKeeper(projectPath: string, boardId?: string): void {
  const keeperScript = resolve(PROJECT_ROOT, 'scripts/agent-keeper.py');
  // Try python3 first, fall back to python
  const python = process.platform === 'win32' ? 'python' : 'python3';

  try {
    const child = spawn(python, [keeperScript, projectPath, '--no-api', '--no-dashboard'], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: 'ignore',
      // Pin the keeper to the same board this MCP server is using, so the
      // keeper, the activity hook and the MCP tools don't each pick their own.
      // The keeper also holds a per-project lock, so a second one exits at once.
      env: { ...process.env, ...(boardId ? { AGENT_TRACK_BOARD_ID: boardId } : {}) },
    });
    child.unref();
    console.error(`[Launcher] Keeper started (PID ${child.pid}) watching ${projectPath}`);
  } catch (err) {
    console.error('[Launcher] Could not start agent-keeper.py:', err);
  }
}

/**
 * Main entry point – start servers if needed, then open the dashboard.
 * @param boardId Optional board ID to open directly in the dashboard
 */
export async function launchDashboard(boardId?: string): Promise<void> {
  try {
    // --- API server ---
    const apiUp = await isPortListening(API_PORT);
    if (!apiUp) {
      console.error(`[Launcher] API server not detected on port ${API_PORT}, starting…`);

      // Resolve the database path to an absolute path so the API server
      // finds the same DB regardless of its working directory.
      const dbPath = resolve(
        PROJECT_ROOT,
        process.env.DATABASE_PATH || 'packages/api-server/data/kanban.db',
      );

      spawnBackground(
        process.execPath, // current node binary
        [resolve(PROJECT_ROOT, 'packages/api-server/dist/index.js')],
        PROJECT_ROOT,
        { DATABASE_PATH: dbPath },
      );

      const apiReady = await waitForPort(API_PORT, 10_000);
      if (apiReady) {
        console.error(`[Launcher] API server is ready on port ${API_PORT}`);
      } else {
        console.error(`[Launcher] API server did not start within 10 s – continuing anyway`);
      }
    } else {
      console.error(`[Launcher] API server already running on port ${API_PORT}`);
    }

    // --- Dashboard dev server ---
    const dashAlreadyUp = await isPortListening(DASHBOARD_PORT);
    if (!dashAlreadyUp) {
      console.error(`[Launcher] Dashboard not detected on port ${DASHBOARD_PORT}, starting…`);

      spawnBackground(
        resolve(PROJECT_ROOT, 'node_modules/.bin/vite'),
        ['--port', String(DASHBOARD_PORT)],
        DASHBOARD_DIR,
      );

      const dashReady = await waitForPort(DASHBOARD_PORT, 15_000);
      if (dashReady) {
        console.error(`[Launcher] Dashboard is ready on port ${DASHBOARD_PORT}`);
      } else {
        console.error(`[Launcher] Dashboard did not start within 15 s – continuing anyway`);
      }
    } else {
      console.error(`[Launcher] Dashboard already running on port ${DASHBOARD_PORT}`);
    }

    // Install/update the hook in the current project
    installHook(process.cwd());

    // Start the keeper to maintain heartbeats and auto-sync git changes
    launchKeeper(process.cwd(), boardId);

    // Always open browser on MCP startup.
    const url = boardId ? `${DASHBOARD_URL}/board/${boardId}` : DASHBOARD_URL;
    console.error(`[Launcher] Opening ${url}`);
    openBrowser(url);
  } catch (error) {
    // Never let launcher errors crash the MCP server
    console.error('[Launcher] Error:', error);
  }
}
