/**
 * MCP Server implementation for Agent Track Dashboard
 * Uses the modern McpServer high-level API with registerTool, Zod schemas,
 * tool annotations, and structured content responses.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { initDatabase, getDatabase } from './db/database.js';
import { TaskRepository } from './repositories/task-repository.js';
import { AgentRepository } from './repositories/agent-repository.js';
import { BoardRepository } from './repositories/board-repository.js';
import { SessionRepository } from './repositories/session-repository.js';

import type {
  AgentTask,
  Agent,
  Board,
  Session,
  BoardColumn,
} from '@agent-track/shared';
import { AgentStatus, TaskStatus, TaskImportance } from '@agent-track/shared';
import { DEFAULT_COLUMNS } from './db/schema.js';
import { notifyApiServer } from './utils/notifier.js';
import { detectAgentIdentity, describeAgent } from './utils/agent-identity.js';
import { launchDashboard } from './utils/launcher.js';

interface AgentKanbanMCPServerOptions {
  cleanStaleDataOnStart?: boolean;
}

export class AgentKanbanMCPServer extends EventEmitter {
  private server: McpServer;
  private taskRepo: TaskRepository;
  private agentRepo: AgentRepository;
  private boardRepo: BoardRepository;
  private sessionRepo: SessionRepository;

  constructor(dbPath?: string, options: AgentKanbanMCPServerOptions = {}) {
    super();

    initDatabase(dbPath ? { path: dbPath } : undefined);

    if (options.cleanStaleDataOnStart !== false) {
      this.cleanStaleData();
    }

    this.taskRepo = new TaskRepository();
    this.agentRepo = new AgentRepository();
    this.boardRepo = new BoardRepository();
    this.sessionRepo = new SessionRepository();

    this.server = new McpServer({
      name: 'agent-kanban-mcp',
      version: '0.1.0',
    });

    this.registerTools();
    this.registerPrompts();
  }

  private cleanStaleData() {
    try {
      const db = getDatabase();
      db.exec(`UPDATE agents SET status = 'offline'`);
      db.exec(`UPDATE sessions SET is_active = 0 WHERE is_active = 1`);
      console.error('[MCP] Marked stale agents offline and closed stale sessions');
    } catch (error) {
      console.error('[MCP] Warning: failed to clean stale data:', error);
    }
  }

  private registerTools() {
    // ── Tracking lifecycle ────────────────────────────────────────────────────

    this.server.registerTool(
      'start_tracking',
      {
        description:
          'Begin tracking this coding session on the dashboard. Binds to the board for the current project (creating it if needed), registers the running AI tool as an agent, opens a session, and — unless disabled — starts the dashboard and opens it in a browser. Call this when the user asks to start tracking; nothing is launched automatically.',
        inputSchema: {
          projectPath: z.string().optional().describe('Project directory. Defaults to the server working directory.'),
          agentName: z.string().optional().describe('Override the detected agent name.'),
          agentType: z.string().optional().describe('Override the detected agent type.'),
          fresh: z.boolean().default(false).describe('Start a brand-new board instead of reusing the project board.'),
          openDashboard: z.boolean().default(true).describe('Start the dashboard and open it in a browser.'),
        },
        outputSchema: {
          boardId: z.string(),
          agentId: z.string(),
          sessionId: z.string(),
          agentName: z.string(),
          agentType: z.string(),
          dashboardUrl: z.string(),
        },
        annotations: { readOnlyHint: false, idempotentHint: false },
      },
      (args) => {
        const result = this.startTracking(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );

    this.server.registerTool(
      'stop_tracking',
      {
        description:
          'End the tracking session: finishes any tasks still open for this agent so nothing is left stranded in the In Progress column, then closes the session.',
        inputSchema: {
          sessionId: z.string().describe('Session ID returned by start_tracking'),
          summary: z.string().optional().describe('What was accomplished this session'),
          completeOpenTasks: z.boolean().default(true).describe('Mark this agent\'s unfinished tasks as done.'),
        },
        outputSchema: {
          status: z.literal('ended'),
          tasksCompleted: z.number(),
        },
        annotations: { readOnlyHint: false, idempotentHint: true },
      },
      (args) => {
        const result = this.stopTracking(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );

    // ── Board Management ──────────────────────────────────────────────────────

    this.server.registerTool(
      'create_board',
      {
        description: 'Create a new kanban board for tracking agent activities',
        inputSchema: {
          name: z.string().min(1).max(100).describe('Board name'),
          description: z.string().optional().describe('Board description'),
          projectPath: z.string().optional().describe('Absolute path to the project directory'),
          repository: z.string().optional().describe('Git repository URL'),
        },
        outputSchema: {
          boardId: z.string(),
          columns: z.array(z.object({
            id: z.string(),
            name: z.string(),
            position: z.number(),
            color: z.string(),
          })),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      (args) => {
        const result = this.createBoard(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );

    this.server.registerTool(
      'list_boards',
      {
        description: 'List all kanban boards',
        inputSchema: {},
        outputSchema: {
          boards: z.array(z.object({
            id: z.string(),
            name: z.string(),
            description: z.string().optional(),
            projectPath: z.string().optional(),
          })),
        },
        annotations: { readOnlyHint: true },
      },
      () => {
        const result = this.listBoards();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );

    this.server.registerTool(
      'get_board',
      {
        description: 'Get detailed board information including all tasks, columns, and active sessions',
        inputSchema: {
          boardId: z.string().describe('Board ID'),
        },
        annotations: { readOnlyHint: true },
      },
      (args) => {
        const result = this.getBoard(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );

    // ── Agent Registration ────────────────────────────────────────────────────

    this.server.registerTool(
      'register_agent',
      {
        description: 'Register an AI agent with its capabilities. Call once at the start of a session.',
        inputSchema: {
          name: z.string().optional().describe('Human-readable agent name. Omit to auto-detect the running tool (Claude Code, Codex, Gemini CLI, Cursor, …).'),
          type: z.string().optional().describe('Agent type slug. Omit to auto-detect.'),
          capabilities: z.array(z.string()).optional().describe('List of capability tags'),
          maxConcurrentTasks: z.number().default(1).describe('Maximum number of tasks this agent can handle at once'),
        },
        outputSchema: {
          agentId: z.string(),
        },
        annotations: { readOnlyHint: false, idempotentHint: true },
      },
      (args) => {
        const result = this.registerAgent(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );

    this.server.registerTool(
      'heartbeat',
      {
        description: 'Send a heartbeat to keep the agent marked as active. Call every 30–60 seconds during long operations.',
        inputSchema: {
          agentId: z.string().describe('Agent ID returned by register_agent'),
          sessionId: z.string().optional().describe('Active session ID'),
        },
        outputSchema: {
          status: z.literal('ok'),
        },
        annotations: { readOnlyHint: false, idempotentHint: true },
      },
      (args) => {
        const result = this.heartbeat(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );

    // ── Session Management ────────────────────────────────────────────────────

    this.server.registerTool(
      'start_session',
      {
        description: 'Start a work session on a board. Required before creating tasks. Returns a sessionId needed for start_task.',
        inputSchema: {
          agentId: z.string().describe('Agent ID from register_agent'),
          boardId: z.string().describe('Board ID to work on'),
          metadata: z.record(z.unknown()).optional().describe('Arbitrary session metadata'),
        },
        outputSchema: {
          sessionId: z.string(),
        },
        annotations: { readOnlyHint: false, idempotentHint: false },
      },
      (args) => {
        const result = this.startSession(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );

    this.server.registerTool(
      'end_session',
      {
        description: 'End a work session. Agent will be marked offline if no other sessions are active.',
        inputSchema: {
          sessionId: z.string().describe('Session ID to end'),
          summary: z.string().optional().describe('Brief summary of work done this session'),
        },
        outputSchema: {
          status: z.literal('ended'),
        },
        annotations: { readOnlyHint: false, idempotentHint: true },
      },
      (args) => {
        const result = this.endSession(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );

    // ── Task Management ───────────────────────────────────────────────────────

    this.server.registerTool(
      'start_task',
      {
        description: 'Create a new task and immediately claim it. One task per distinct unit of work — never bundle unrelated changes.',
        inputSchema: {
          boardId: z.string().describe('Board ID'),
          sessionId: z.string().describe('Active session ID'),
          title: z.string().min(1).max(200).describe('Short, action-oriented title (e.g., "Fix null check in auth.ts")'),
          description: z.string().optional().describe('One sentence explaining what the task involves'),
          importance: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
          estimatedDuration: z.number().optional().describe('Estimated duration in seconds'),
          tags: z.array(z.string()).optional().describe(
            'Tags from: frontend, backend, api, database, ui, testing, bug, feature, refactor, ' +
            'performance, security, documentation, devops, infrastructure, migration, config, ' +
            'styling, accessibility, i18n, analytics, auth, ci-cd, deployment, monitoring, ' +
            'cleanup, design, prototype, research, review, hotfix'
          ),
          parentTaskId: z.string().optional().describe('Parent task ID for subtasks'),
        },
        outputSchema: {
          taskId: z.string(),
          status: z.literal('claimed'),
        },
        annotations: { readOnlyHint: false, idempotentHint: false },
      },
      async (args) => {
        const result = await this.startTask(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );

    this.server.registerTool(
      'update_task_status',
      {
        description: 'Move a task between kanban columns (todo → claimed → in_progress → review → done)',
        inputSchema: {
          taskId: z.string(),
          status: z.enum(['todo', 'claimed', 'in_progress', 'review', 'done']),
          currentAction: z.string().optional().describe('What the agent is currently doing on this task'),
        },
        outputSchema: {
          status: z.string(),
        },
        annotations: { readOnlyHint: false, idempotentHint: false },
      },
      (args) => {
        const result = this.updateTaskStatus(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );

    this.server.registerTool(
      'update_task_progress',
      {
        description: 'Update task progress percentage, current action, and code changes. Call when switching files or finishing a significant step.',
        inputSchema: {
          taskId: z.string(),
          progress: z.number().min(0).max(100).optional().describe('Progress 0–100'),
          currentAction: z.string().optional().describe('Human-readable description of current activity'),
          files: z.array(z.string()).optional().describe('Files being worked on'),
          linesChanged: z.object({
            added: z.number(),
            removed: z.number(),
          }).optional(),
          tokensUsed: z.number().optional(),
          codeChanges: z.array(z.object({
            filePath: z.string(),
            changeType: z.enum(['added', 'modified', 'deleted', 'renamed']),
            oldPath: z.string().optional(),
            diff: z.string().describe('Unified diff of the change'),
            language: z.string().optional(),
            linesAdded: z.number().optional(),
            linesDeleted: z.number().optional(),
          })).optional(),
        },
        outputSchema: {
          progress: z.number(),
        },
        annotations: { readOnlyHint: false, idempotentHint: false },
      },
      (args) => {
        const result = this.updateTaskProgress(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );

    this.server.registerTool(
      'complete_task',
      {
        description: 'Mark a task as successfully completed. Call add_comment with a summary before calling this.',
        inputSchema: {
          taskId: z.string(),
          summary: z.string().optional().describe('Brief summary of what was accomplished'),
          tokensUsed: z.number().optional(),
        },
        outputSchema: {
          status: z.literal('done'),
          actualDuration: z.number().optional().describe('Time taken in seconds'),
        },
        annotations: { readOnlyHint: false, idempotentHint: true },
      },
      (args) => {
        const result = this.completeTask(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );

    this.server.registerTool(
      'fail_task',
      {
        description: 'Mark a task as failed with error details',
        inputSchema: {
          taskId: z.string(),
          errorMessage: z.string().describe('Detailed error message explaining the failure'),
          willRetry: z.boolean().default(false).describe('Whether the agent will retry this task'),
        },
        outputSchema: {
          status: z.literal('failed'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      (args) => {
        const result = this.failTask(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );

    this.server.registerTool(
      'pause_task',
      {
        description: 'Pause a task that is in progress (moves it back to claimed status)',
        inputSchema: {
          taskId: z.string(),
          reason: z.string().describe('Why the task is being paused'),
        },
        outputSchema: {
          status: z.literal('claimed'),
        },
        annotations: { readOnlyHint: false, idempotentHint: true },
      },
      (args) => {
        const result = this.pauseTask(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );

    this.server.registerTool(
      'resume_task',
      {
        description: 'Resume a paused task (moves it back to in_progress)',
        inputSchema: {
          taskId: z.string(),
        },
        outputSchema: {
          status: z.literal('in_progress'),
        },
        annotations: { readOnlyHint: false, idempotentHint: true },
      },
      (args) => {
        const result = this.resumeTask(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );

    // ── Task Collaboration ────────────────────────────────────────────────────

    this.server.registerTool(
      'add_comment',
      {
        description: 'Add a comment to a task. Always call this before complete_task with a summary of what was done, decisions made, and files changed.',
        inputSchema: {
          taskId: z.string(),
          author: z.string().describe('Agent name or identifier'),
          content: z.string().describe('Comment text — include what was done, why, and which files changed'),
        },
        outputSchema: {
          commentId: z.string(),
        },
        annotations: { readOnlyHint: false, idempotentHint: false },
      },
      (args) => {
        const result = this.addComment(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );

    this.server.registerTool(
      'set_task_blocker',
      {
        description: 'Mark a task as blocked by one or more other tasks',
        inputSchema: {
          taskId: z.string().describe('Task that is blocked'),
          blockedBy: z.array(z.string()).describe('Task IDs that are blocking this task'),
        },
        outputSchema: {
          status: z.literal('updated'),
        },
        annotations: { readOnlyHint: false, idempotentHint: true },
      },
      (args) => {
        const result = this.setTaskBlocker(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );

    // ── Query Tools ───────────────────────────────────────────────────────────

    this.server.registerTool(
      'get_my_tasks',
      {
        description: 'Get all tasks assigned to this agent',
        inputSchema: {
          agentId: z.string(),
          boardId: z.string().optional().describe('Filter by board'),
          status: z.enum(['active', 'completed', 'all']).default('active'),
        },
        annotations: { readOnlyHint: true },
      },
      (args) => {
        const result = this.getMyTasks(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );

    this.server.registerTool(
      'get_available_tasks',
      {
        description: 'Get unclaimed tasks available for claiming, sorted by importance (critical first)',
        inputSchema: {
          boardId: z.string(),
          importance: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('Filter by importance level'),
        },
        annotations: { readOnlyHint: true },
      },
      (args) => {
        const result = this.getAvailableTasks(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );

    this.server.registerTool(
      'get_blocked_tasks',
      {
        description: 'Get all tasks that are currently blocked by unresolved dependencies',
        inputSchema: {
          boardId: z.string(),
        },
        annotations: { readOnlyHint: true },
      },
      (args) => {
        const result = this.getBlockedTasks(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      },
    );
  }

  private registerPrompts() {
    this.server.registerPrompt(
      'agent-track-instructions',
      { description: 'Instructions for how to use the agent-track tools correctly' },
      () => ({
        description: 'Agent Track Dashboard — usage instructions',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `You are connected to the Agent Track Dashboard via MCP. Follow these rules at all times:

## Task granularity
- Create ONE task per distinct unit of work. Never bundle multiple unrelated changes into one task card.
- Each task should represent a single file change, bug fix, feature, or investigation.

## Starting a task
When calling start_task, always include:
- tags: pick all that apply — frontend, backend, api, database, ui, testing, bug, feature, refactor, performance, security, documentation, devops, config, styling, cleanup, hotfix, research, review
- importance: set appropriately (critical, high, medium, low)
- description: a brief sentence explaining what the task involves

## Completing a task
Before calling complete_task, always call add_comment with:
- A summary of what was done
- Any decisions made or issues encountered
- Which files were changed and why

Example:
  add_comment(taskId, author="<your agent name>", content="Fixed null check in server.ts — the root cause was ...")
  complete_task(taskId, summary="Fixed null check bug")

## Progress updates
Call update_task_progress when switching between files or finishing a significant step, not only at the end.`,
            },
          },
        ],
      }),
    );
  }

  // ── Board Management ────────────────────────────────────────────────────────

  private createBoard(args: any): { boardId: string; columns: BoardColumn[] } {
    const boardId = randomUUID();
    const now = new Date();

    const board: Board = {
      id: boardId,
      name: args.name,
      description: args.description,
      projectPath: args.projectPath,
      repository: args.repository,
      settings: {
        autoArchiveCompleted: false,
        archiveAfterHours: 24,
        enableNotifications: true,
        criticalTaskAlerts: true,
      },
      createdAt: now,
      updatedAt: now,
    };

    this.boardRepo.create(board);

    const columns = DEFAULT_COLUMNS.map((column) => ({
      ...column,
      id: randomUUID(),
    }));

    for (const column of columns) {
      this.boardRepo.createColumn(boardId, column);
    }

    this.emit('board:created', board);
    notifyApiServer('board_created', boardId, { board });

    return { boardId, columns };
  }

  private listBoards(): { boards: Board[] } {
    return { boards: this.boardRepo.getAll() };
  }

  private getBoard(args: any): any {
    const board = this.boardRepo.get(args.boardId);
    if (!board) throw new Error(`Board not found: ${args.boardId}`);

    const columns = this.boardRepo.getColumns(args.boardId);
    const tasks = this.taskRepo.getByBoard(args.boardId);
    const sessions = this.sessionRepo.getActiveSessions(args.boardId);

    return { board, columns, tasks, activeSessionCount: sessions.length };
  }

  // ── Agent Registration ──────────────────────────────────────────────────────

  private registerAgent(args: any): { agentId: string } {
    const agentId = randomUUID();

    // Never hard-code "Claude": when the caller doesn't name itself, use the
    // tool detected from the environment (Codex, Gemini CLI, Cursor, …).
    const identity = detectAgentIdentity();

    const agent: Agent = {
      id: agentId,
      name: args.name || describeAgent(identity),
      type: args.type || identity.type,
      status: AgentStatus.ACTIVE,
      capabilities: args.capabilities,
      maxConcurrentTasks: args.maxConcurrentTasks || 1,
      tasksCompleted: 0,
      tasksInProgress: 0,
      averageTaskDuration: 0,
      successRate: 100,
      lastHeartbeat: new Date(),
    };

    this.agentRepo.upsert(agent);
    this.emit('agent:registered', agent);
    notifyApiServer('agent_status_changed', undefined, { agent });

    return { agentId };
  }

  private heartbeat(args: any): { status: 'ok' } {
    this.agentRepo.updateHeartbeat(args.agentId);

    if (args.sessionId) {
      this.sessionRepo.updateHeartbeat(args.sessionId);
    }

    const agent = this.agentRepo.get(args.agentId);
    if (agent) {
      const boardId = this.findAgentBoard(args.agentId);
      notifyApiServer('agent_status_changed', boardId, { agent });
    }

    return { status: 'ok' };
  }

  // ── Session Management ──────────────────────────────────────────────────────

  private startSession(args: any): { sessionId: string } {
    const sessionId = randomUUID();

    const session: Session = {
      id: sessionId,
      agentId: args.agentId,
      boardId: args.boardId,
      startedAt: new Date(),
      lastHeartbeat: new Date(),
      isActive: true,
      tasksCreated: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      totalTokensUsed: 0,
      metadata: args.metadata,
    };

    this.sessionRepo.create(session);
    this.agentRepo.updateHeartbeat(args.agentId);
    this.emit('session:started', session);

    const agent = this.agentRepo.get(args.agentId);
    if (agent) {
      notifyApiServer('agent_status_changed', args.boardId, { agent });
    }

    return { sessionId };
  }

  private endSession(args: any): { status: 'ended' } {
    const session = this.sessionRepo.get(args.sessionId);
    this.sessionRepo.endSession(args.sessionId);
    this.emit('session:ended', { sessionId: args.sessionId });

    if (session) {
      const otherSessions = this.getActiveSessionsForAgent(session.agentId);
      if (otherSessions.length === 0) {
        if (this.hasUnfinishedTasksForAgent(session.agentId)) {
          this.agentRepo.updateStatus(session.agentId, AgentStatus.OFFLINE);
        } else {
          this.agentRepo.archive(session.agentId);
        }
      }
      const agent = this.agentRepo.get(session.agentId);
      if (agent) {
        notifyApiServer('agent_status_changed', session.boardId, { agent });
      }
    }

    return { status: 'ended' };
  }

  // ── Task Management ─────────────────────────────────────────────────────────

  private async startTask(args: any): Promise<{ taskId: string; status: 'claimed' }> {
    const taskId = randomUUID();

    const session = this.sessionRepo.get(args.sessionId);
    if (!session) throw new Error(`Session not found: ${args.sessionId}`);

    const agent = this.agentRepo.get(session.agentId);
    if (!agent) throw new Error(`Agent not found: ${session.agentId}`);

    this.agentRepo.updateHeartbeat(session.agentId);

    const now = new Date();

    const task: AgentTask = {
      id: taskId,
      boardId: args.boardId,
      title: args.title,
      description: args.description,
      importance: args.importance || TaskImportance.MEDIUM,
      status: TaskStatus.CLAIMED,
      agentId: agent.id,
      agentName: agent.name,
      agentType: agent.type,
      sessionId: args.sessionId,
      createdAt: now,
      claimedAt: now,
      updatedAt: now,
      estimatedDuration: args.estimatedDuration,
      tags: args.tags,
      parentTaskId: args.parentTaskId,
      blockedBy: [],
    };

    this.taskRepo.create(task);
    this.sessionRepo.incrementTaskCreated(args.sessionId);

    this.emit('task:created', task);
    notifyApiServer('task_created', args.boardId, { task });

    return { taskId, status: 'claimed' };
  }

  private updateTaskStatus(args: any): { status: string } {
    const task = this.taskRepo.get(args.taskId);
    if (!task) throw new Error(`Task not found: ${args.taskId}`);

    if (task.agentId) this.agentRepo.updateHeartbeat(task.agentId);

    const updates: Partial<AgentTask> = {
      status: args.status,
      currentAction: args.currentAction,
      updatedAt: new Date(),
    };

    if (args.status === 'in_progress' && !task.startedAt) {
      updates.startedAt = new Date();
    }

    this.taskRepo.update(args.taskId, updates);

    const updatedTask = this.taskRepo.get(args.taskId);
    this.emit('task:updated', updatedTask);
    notifyApiServer('task_updated', task.boardId, { task: updatedTask });

    return { status: args.status };
  }

  private updateTaskProgress(args: any): { progress: number } {
    const task = this.taskRepo.get(args.taskId);
    if (!task) throw new Error(`Task not found: ${args.taskId}`);

    if (task.agentId) this.agentRepo.updateHeartbeat(task.agentId);

    const progressValue = typeof args.progress === 'number' ? args.progress : task.progress;
    const shouldStartWork =
      task.status === TaskStatus.CLAIMED ||
      task.status === TaskStatus.TODO;
    const shouldCompleteTask =
      task.status !== TaskStatus.DONE &&
      typeof progressValue === 'number' &&
      progressValue >= 100;
    const effectiveStatus = shouldCompleteTask
      ? TaskStatus.DONE
      : shouldStartWork
        ? TaskStatus.IN_PROGRESS
        : task.status;

    const updates: Partial<AgentTask> = {
      progress: args.progress,
      currentAction: args.currentAction,
      files: args.files,
      linesChanged: args.linesChanged,
      tokensUsed: args.tokensUsed,
      codeChanges: args.codeChanges,
      status: effectiveStatus,
      updatedAt: new Date(),
    };

    if (effectiveStatus === TaskStatus.IN_PROGRESS && !task.startedAt) {
      updates.startedAt = new Date();
    }

    if (args.codeChanges && args.codeChanges.length > 0) {
      let totalInsertions = 0;
      let totalDeletions = 0;
      for (const change of args.codeChanges) {
        totalInsertions += change.linesAdded || 0;
        totalDeletions += change.linesDeleted || 0;
      }
      updates.diffSummary = {
        filesChanged: args.codeChanges.length,
        insertions: totalInsertions,
        deletions: totalDeletions,
      };
    }

    if (effectiveStatus === TaskStatus.DONE && !task.completedAt) {
      const completedAt = new Date();
      const referenceTime = task.startedAt || updates.startedAt || task.claimedAt || task.createdAt;

      updates.completedAt = completedAt;
      updates.actualDuration = referenceTime
        ? Math.floor((completedAt.getTime() - referenceTime.getTime()) / 1000)
        : undefined;
      updates.progress = 100;
    }

    this.taskRepo.update(args.taskId, updates);

    if (effectiveStatus === TaskStatus.DONE && task.status !== TaskStatus.DONE) {
      this.sessionRepo.incrementTaskCompleted(task.sessionId);
      this.agentRepo.incrementTasksCompleted(task.agentId);

      if (args.tokensUsed) {
        this.sessionRepo.addTokensUsed(task.sessionId, args.tokensUsed);
      }
    }

    const updatedTask = this.taskRepo.get(args.taskId);
    this.emit('task:updated', updatedTask);
    notifyApiServer('task_updated', task.boardId, { task: updatedTask });

    return { progress: args.progress ?? task.progress ?? 0 };
  }

  private completeTask(args: any): { status: 'done'; actualDuration?: number } {
    const task = this.taskRepo.get(args.taskId);
    if (!task) throw new Error(`Task not found: ${args.taskId}`);

    if (task.agentId) this.agentRepo.updateHeartbeat(task.agentId);

    if (task.status === TaskStatus.DONE) {
      if (args.tokensUsed) {
        this.taskRepo.update(args.taskId, {
          tokensUsed: args.tokensUsed,
          updatedAt: new Date(),
        });
        this.sessionRepo.addTokensUsed(task.sessionId, args.tokensUsed);
      }

      return { status: 'done', actualDuration: task.actualDuration };
    }

    const completedAt = new Date();
    const referenceTime = task.startedAt || task.claimedAt || task.createdAt;
    const actualDuration = referenceTime
      ? Math.floor((completedAt.getTime() - referenceTime.getTime()) / 1000)
      : undefined;

    this.taskRepo.update(args.taskId, {
      status: TaskStatus.DONE,
      progress: 100,
      completedAt,
      actualDuration,
      tokensUsed: args.tokensUsed || task.tokensUsed,
      updatedAt: new Date(),
    });

    this.sessionRepo.incrementTaskCompleted(task.sessionId);
    this.agentRepo.incrementTasksCompleted(task.agentId);

    if (args.tokensUsed) {
      this.sessionRepo.addTokensUsed(task.sessionId, args.tokensUsed);
    }

    const updatedTask = this.taskRepo.get(args.taskId);
    this.emit('task:completed', updatedTask);
    notifyApiServer('task_updated', task.boardId, { task: updatedTask });

    return { status: 'done', actualDuration };
  }

  private failTask(args: any): { status: 'failed' } {
    const task = this.taskRepo.get(args.taskId);
    if (!task) throw new Error(`Task not found: ${args.taskId}`);

    if (task.agentId) this.agentRepo.updateHeartbeat(task.agentId);

    this.taskRepo.update(args.taskId, {
      errorMessage: args.errorMessage,
      retryCount: (task.retryCount || 0) + 1,
      updatedAt: new Date(),
    });

    if (!args.willRetry) {
      this.sessionRepo.incrementTaskFailed(task.sessionId);
    }

    const updatedTask = this.taskRepo.get(args.taskId);
    this.emit('task:failed', updatedTask);
    notifyApiServer('task_updated', task.boardId, { task: updatedTask });

    return { status: 'failed' };
  }

  private pauseTask(args: any): { status: 'claimed' } {
    const task = this.taskRepo.get(args.taskId);
    if (!task) throw new Error(`Task not found: ${args.taskId}`);

    if (task.agentId) this.agentRepo.updateHeartbeat(task.agentId);

    this.taskRepo.update(args.taskId, {
      status: TaskStatus.CLAIMED,
      currentAction: `Paused: ${args.reason}`,
      updatedAt: new Date(),
    });

    const updatedTask = this.taskRepo.get(args.taskId);
    this.emit('task:updated', updatedTask);
    notifyApiServer('task_updated', task.boardId, { task: updatedTask });

    return { status: 'claimed' };
  }

  private resumeTask(args: any): { status: 'in_progress' } {
    const task = this.taskRepo.get(args.taskId);
    if (!task) throw new Error(`Task not found: ${args.taskId}`);

    if (task.agentId) this.agentRepo.updateHeartbeat(task.agentId);

    const updates: Partial<AgentTask> = {
      status: TaskStatus.IN_PROGRESS,
      currentAction: 'Resumed',
      updatedAt: new Date(),
    };

    if (!task.startedAt) updates.startedAt = new Date();

    this.taskRepo.update(args.taskId, updates);

    const updatedTask = this.taskRepo.get(args.taskId);
    this.emit('task:updated', updatedTask);
    notifyApiServer('task_updated', task.boardId, { task: updatedTask });

    return { status: 'in_progress' };
  }

  // ── Task Collaboration ──────────────────────────────────────────────────────

  private addComment(args: any): { commentId: string } {
    const commentId = randomUUID();
    const db = getDatabase();

    db.prepare(`
      INSERT INTO comments (id, task_id, author, author_type, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(commentId, args.taskId, args.author, 'agent', args.content, Date.now());

    this.emit('comment:added', { commentId, ...args });
    return { commentId };
  }

  private setTaskBlocker(args: any): { status: 'updated' } {
    this.taskRepo.update(args.taskId, {
      blockedBy: args.blockedBy,
      updatedAt: new Date(),
    });

    const updatedTask = this.taskRepo.get(args.taskId);
    this.emit('task:updated', updatedTask);

    return { status: 'updated' };
  }

  // ── Query Methods ───────────────────────────────────────────────────────────

  private getMyTasks(args: any): { tasks: AgentTask[] } {
    return { tasks: this.taskRepo.getByAgent(args.agentId, args.status) };
  }

  private getAvailableTasks(args: any): { tasks: AgentTask[] } {
    const importanceOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    const allTasks = this.taskRepo.getByBoard(args.boardId);

    let available = allTasks.filter(t => t.status === 'todo');
    if (args.importance) available = available.filter(t => t.importance === args.importance);

    available.sort((a, b) =>
      (importanceOrder[a.importance ?? 'medium'] ?? 2) - (importanceOrder[b.importance ?? 'medium'] ?? 2)
    );

    return { tasks: available };
  }

  private getBlockedTasks(args: any): { tasks: AgentTask[] } {
    return { tasks: this.taskRepo.getBlockedTasks(args.boardId) };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private findAgentBoard(agentId: string): string | undefined {
    try {
      const row = getDatabase().prepare(
        `SELECT board_id FROM sessions WHERE agent_id = ? AND is_active = 1 ORDER BY started_at DESC LIMIT 1`
      ).get(agentId) as { board_id: string } | undefined;
      return row?.board_id;
    } catch {
      return undefined;
    }
  }

  private getActiveSessionsForAgent(agentId: string): Session[] {
    try {
      return getDatabase().prepare(
        `SELECT * FROM sessions WHERE agent_id = ? AND is_active = 1`
      ).all(agentId) as any[];
    } catch {
      return [];
    }
  }

  private hasUnfinishedTasksForAgent(agentId: string): boolean {
    try {
      const db = getDatabase();
      const row = db.prepare(
        `SELECT 1 FROM agent_tasks WHERE agent_id = ? AND status IN ('todo', 'claimed', 'in_progress', 'review') LIMIT 1`
      ).get(agentId);
      return Boolean(row);
    } catch {
      return true;
    }
  }

  // ── Tracking lifecycle ──────────────────────────────────────────────────────

  private startTracking(args: any): {
    boardId: string;
    agentId: string;
    sessionId: string;
    agentName: string;
    agentType: string;
    dashboardUrl: string;
  } {
    const projectPath = args.projectPath || process.cwd();

    // Bind to the project's board. Reusing it is what keeps the MCP server, the
    // activity hook and the keeper writing to the same place.
    let boardId: string | undefined;
    if (!args.fresh) {
      boardId = this.findBoardByProjectPath(projectPath);
    }
    if (!boardId) {
      boardId = this.createBoardForProject(projectPath);
    }

    const identity = detectAgentIdentity();
    const agentName = args.agentName || describeAgent(identity);
    const agentType = args.agentType || identity.type;

    const { agentId } = this.registerAgent({
      name: agentName,
      type: agentType,
      capabilities: ['code-generation', 'refactoring', 'debugging'],
      maxConcurrentTasks: 3,
    });

    const { sessionId } = this.startSession({ agentId, boardId });

    const dashboardUrl = `http://localhost:5173/board/${boardId}`;

    if (args.openDashboard !== false) {
      // Fire-and-forget: the launcher never rejects, and tracking must not
      // block on a browser or a dev server coming up.
      void launchDashboard(boardId);
    }

    return { boardId, agentId, sessionId, agentName, agentType, dashboardUrl };
  }

  private stopTracking(args: any): { status: 'ended'; tasksCompleted: number } {
    const session = this.sessionRepo.get(args.sessionId);
    let tasksCompleted = 0;

    // Close out anything still open, otherwise these cards sit in In Progress
    // forever once the tool that created them goes away.
    if (session && args.completeOpenTasks !== false) {
      const open = this.taskRepo
        .getByBoard(session.boardId)
        .filter(
          (t) =>
            t.agentId === session.agentId &&
            t.status !== TaskStatus.DONE,
        );

      for (const task of open) {
        this.completeTask({
          taskId: task.id,
          summary: args.summary || 'Completed when tracking stopped',
        });
        tasksCompleted++;
      }
    }

    this.endSession({ sessionId: args.sessionId, summary: args.summary });

    return { status: 'ended', tasksCompleted };
  }

  // ── Public Interface (used by index.ts) ─────────────────────────────────────

  findBoardByProjectPath(projectPath: string): string | undefined {
    try {
      const row = getDatabase().prepare(
        `SELECT id FROM boards WHERE project_path = ? ORDER BY created_at DESC LIMIT 1`
      ).get(projectPath) as { id: string } | undefined;
      return row?.id;
    } catch {
      return undefined;
    }
  }

  createBoardForProject(projectPath: string): string {
    const name = projectPath.split('/').filter(Boolean).pop() || 'Untitled Project';
    const result = this.createBoard({
      name,
      description: `Auto-created board for ${name}`,
      projectPath,
    });
    return result.boardId;
  }

  async connect(transport: Transport) {
    await this.server.connect(transport);
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.connect(transport);
    console.error('Agent Kanban MCP Server running on stdio');
  }

  async close() {
    await this.server.close();
  }
}
