/**
 * KanbanBoard Component
 * Main kanban board with drag and drop functionality
 */
import React, { useEffect } from 'react';
import { DndContext, DragEndEvent, DragOverlay, DragStartEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { KanbanColumn } from './KanbanColumn';
import { TaskCard } from './TaskCard';
import { useBoard } from '@/hooks/useBoard';
import { useTasks } from '@/hooks/useTasks';
import { useTaskStore } from '@/stores/taskStore';
import { useUIStore } from '@/stores/uiStore';
import type { AgentTask, TaskStatus } from '@/types';
import { cn } from '@/utils/cn';
import { columnToStatus } from '@/utils/colors';

export interface KanbanBoardProps {
  boardId: string;
  className?: string;
}

/** Max number of completed tasks to render in the Done column */
const DONE_COLUMN_DISPLAY_LIMIT = 50;

/**
 * KanbanBoard is the main container for the kanban view
 * Features:
 * - Drag and drop task management
 * - Multiple columns based on task status
 * - Real-time updates via WebSocket
 * - Task detail modal integration
 */
export const KanbanBoard: React.FC<KanbanBoardProps> = ({
  boardId,
  className,
}) => {
  const { currentBoard, columns, loading, error, fetchBoard } = useBoard(boardId);
  const { tasks, moveTask, fetchTasks } = useTasks(boardId);
  const { selectTask } = useTaskStore();
  const { openTaskModal } = useUIStore();

  const [activeTask, setActiveTask] = React.useState<AgentTask | null>(null);

  // Require 8px of movement before drag activates, so clicks work normally
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  // Fetch board and tasks on mount
  useEffect(() => {
    if (boardId) {
      fetchBoard(boardId);
      fetchTasks(boardId);
    }
  }, [boardId, fetchBoard, fetchTasks]);

  /**
   * Handle drag start event
   */
  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const task = active.data.current?.task as AgentTask;
    if (task) {
      setActiveTask(task);
    }
  };

  /**
   * Handle drag end event
   */
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    setActiveTask(null);

    if (!over) return;

    const taskId = active.id as string;
    const newStatus = over.id as TaskStatus;

    // Get the task to check if status changed
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.status === newStatus) return;

    // Move task to new status
    moveTask(taskId, newStatus);
  };

  /**
   * Handle task card click
   */
  const handleTaskClick = (task: AgentTask) => {
    selectTask(task.id);
    openTaskModal();
  };

  if (loading && !currentBoard) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading board...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-destructive font-semibold mb-2">Error loading board</p>
          <p className="text-muted-foreground text-sm">{error}</p>
        </div>
      </div>
    );
  }

  if (!currentBoard) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Board not found</p>
      </div>
    );
  }

  return (
    <div className={cn('h-full flex flex-col', className)}>
      {/* Kanban Board */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div className="flex gap-4 h-full p-6">
            {columns.map((column) => {
              const statusKey = columnToStatus(column);
              const columnTasks = tasks.filter(
                (task) => task.status === statusKey
              );

              // Sort Done column by newest first (most recent updatedAt),
              // and cap the display at the 50 most-recent to avoid flooding
              const sortedTasks = statusKey === 'done'
                ? [...columnTasks]
                    .sort((a, b) => {
                      const dateA = new Date(a.completedAt || a.updatedAt).getTime();
                      const dateB = new Date(b.completedAt || b.updatedAt).getTime();
                      return dateB - dateA; // Descending order (newest first)
                    })
                    .slice(0, DONE_COLUMN_DISPLAY_LIMIT)
                : columnTasks;

              return (
                <KanbanColumn
                  key={column.id}
                  column={column}
                  tasks={sortedTasks}
                  onTaskClick={handleTaskClick}
                />
              );
            })}

            {columns.length === 0 && (
              <div className="flex items-center justify-center w-full">
                <p className="text-muted-foreground">
                  No columns configured for this board
                </p>
              </div>
            )}

            {/* Right-edge spacer: ensures padding after the last column is preserved when horizontally scrolling */}
            {columns.length > 0 && <div className="shrink-0 w-1" aria-hidden="true" />}
          </div>

          {/* Drag Overlay */}
          <DragOverlay>
            {activeTask ? (
              <div className="opacity-50">
                <TaskCard task={activeTask} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  );
};

KanbanBoard.displayName = 'KanbanBoard';
