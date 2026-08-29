/**
 * Work runtime — queues, assignment, and lifecycle state machine.
 * Extracted from verticals/work-assistant per valeriworkvertical.md §15 + VELARI ARCHITECTURE.md §3 module rule.
 * Brand-neutral, no hard-coded product name. Concise, senior-grade.
 */

export type TaskStatus = "draft" | "assigned" | "in_progress" | "submitted" | "in_review" | "approved" | "returned" | "escalated" | "completed" | "archived";

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  draft: ["assigned", "in_progress"],
  assigned: ["in_progress", "submitted"],
  in_progress: ["submitted"],
  submitted: ["in_review", "approved", "returned"],
  in_review: ["approved", "returned", "escalated"],
  approved: ["completed", "archived"],
  returned: ["in_progress", "assigned"],
  escalated: ["in_review", "approved", "returned"],
  completed: ["archived"],
  archived: [],
};

export class WorkStateError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "WorkStateError";
  }
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  const allowed = TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new WorkStateError(`cannot transition from ${from} to ${to}`, "invalid_transition");
  }
}

export interface WorkQueueItem {
  id: string;
  taskId: string;
  assigneeId?: string;
  priority: number;
  enqueuedAt: string;
}

// Simple in-memory queue — replaceable with BullMQ per valeriworkvertical.md §4
export class WorkQueue {
  private items: WorkQueueItem[] = [];

  enqueue(item: WorkQueueItem): void {
    this.items.push(item);
    this.items.sort((a, b) => b.priority - a.priority);
  }

  dequeue(): WorkQueueItem | undefined {
    return this.items.shift();
  }

  peek(): WorkQueueItem | undefined {
    return this.items[0];
  }

  size(): number {
    return this.items.length;
  }

  removeByTaskId(taskId: string): void {
    this.items = this.items.filter((i) => i.taskId !== taskId);
  }
}

export function isAllowedDomain(url: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return false; // blank default for now — nothing allowed until policy set
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowedDomains.some((d) => {
      const norm = d.toLowerCase().replace(/^\*\./, "");
      return host === norm || host.endsWith(`.${norm}`);
    });
  } catch {
    return false;
  }
}

export function requiresApproval(risk: string, autoApprove: boolean): boolean {
  if (risk !== "external_write" && risk !== "sensitive") return false;
  return !autoApprove;
}
