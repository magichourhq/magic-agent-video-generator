export interface ScheduledProjectRun {
  projectId: string;
  run: () => Promise<void>;
  onQueued?: (position: number, active: number, limit: number) => void | Promise<void>;
  onStart?: (active: number, limit: number) => void | Promise<void>;
}

export interface ProjectRunSchedulerSnapshot {
  active: number;
  queued: number;
  limit: number;
  queued_project_ids: string[];
}

export class ProjectRunScheduler {
  private active = 0;
  private readonly queue: ScheduledProjectRun[] = [];

  constructor(readonly limit: number) {
    if (!Number.isFinite(limit) || limit < 1) {
      throw new Error(`Invalid project run concurrency limit: ${limit}`);
    }
  }

  enqueue(task: ScheduledProjectRun): void {
    this.queue.push(task);
    if (this.active >= this.limit) {
      void task.onQueued?.(this.queue.length, this.active, this.limit);
    }
    this.drain();
  }

  snapshot(): ProjectRunSchedulerSnapshot {
    return {
      active: this.active,
      queued: this.queue.length,
      limit: this.limit,
      queued_project_ids: this.queue.map((item) => item.projectId),
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.active += 1;
      void task.onStart?.(this.active, this.limit);
      void task.run().finally(() => {
        this.active = Math.max(0, this.active - 1);
        this.drain();
      });
    }
  }
}

