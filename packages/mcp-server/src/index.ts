#!/usr/bin/env node

/**
 * Entry point for Agent Kanban MCP Server
 *
 * By default, uses the API server's database so both servers
 * share the same data. Override with DATABASE_PATH env variable.
 */

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { AgentKanbanMCPServer } from './server.js';
import { startStreamableHttpServer } from './http.js';
import { launchDashboard } from './utils/launcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve to the API server's database by default so both servers share data
const defaultDbPath = resolve(__dirname, '../../api-server/data/kanban.db');
const dbPath = process.env.DATABASE_PATH || defaultDbPath;

const transportMode = (process.env.MCP_TRANSPORT || 'stdio').toLowerCase();

function ensureProjectBoard(server: AgentKanbanMCPServer): string {
  // Reuse the board already bound to this working directory so the MCP server,
  // the activity hook and the keeper all write to the SAME board. Creating a
  // new board per launch used to split writes across boards, which is why the
  // dashboard looked empty while work was happening.
  const cwd = process.cwd();
  const existing = server.findBoardByProjectPath(cwd);
  if (existing) {
    console.error(`[MCP] Using existing board ${existing} for project ${cwd}`);
    return existing;
  }

  const boardId = server.createBoardForProject(cwd);
  console.error(`[MCP] Created board ${boardId} for project ${cwd}`);

  return boardId;
}

/**
 * Everything that reaches outside this process — spawning the API server and
 * dashboard, opening a browser, installing hooks, starting the keeper — is
 * OFF by default. Opening a project in an editor starts the MCP server, and
 * that must not drag a whole toolchain up with it. Tracking begins only when
 * the `start_tracking` tool is called, or when autostart is opted into.
 */
function isAutostartEnabled(): boolean {
  // Back-compat: honour the old per-feature switches when explicitly set.
  if (process.env.AUTO_LAUNCH_DASHBOARD === 'true') return true;
  if (process.env.AUTO_LAUNCH_DASHBOARD === 'false') return false;
  return process.env.AGENT_TRACK_AUTOSTART === 'true';
}

async function bootstrapProjectBoard(dbPathValue: string): Promise<string> {
  const bootstrapServer = new AgentKanbanMCPServer(dbPathValue, {
    cleanStaleDataOnStart: false,
  });

  try {
    return ensureProjectBoard(bootstrapServer);
  } finally {
    await bootstrapServer.close();
  }
}

async function runStdioMode() {
  const server = new AgentKanbanMCPServer(dbPath);
  await server.run();

  if (!isAutostartEnabled()) {
    console.error('[MCP] Idle — call the start_tracking tool to open the dashboard.');
    return;
  }

  // Opt-in path: behave like the old always-on startup.
  const boardId = ensureProjectBoard(server);
  console.error('[MCP] AGENT_TRACK_AUTOSTART=true — launching dashboard...');
  launchDashboard(boardId);
}

function readHttpPort(): number {
  const rawPort = process.env.MCP_HTTP_PORT || '8787';
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid MCP_HTTP_PORT: ${rawPort}`);
  }

  return port;
}

async function runHttpMode() {
  if (isAutostartEnabled()) {
    const boardId = await bootstrapProjectBoard(dbPath);
    console.error('[MCP] AGENT_TRACK_AUTOSTART=true — launching dashboard...');
    void launchDashboard(boardId);
  } else {
    console.error('[MCP] Idle — call the start_tracking tool to open the dashboard.');
  }

  await startStreamableHttpServer({
    dbPath,
    host: process.env.MCP_HTTP_HOST || '127.0.0.1',
    port: readHttpPort(),
    endpoint: process.env.MCP_HTTP_PATH || '/mcp',
  });
}

const runPromise = transportMode === 'http' || transportMode === 'streamable-http'
  ? runHttpMode()
  : runStdioMode();

runPromise.catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
