interface HistoryRenderJob {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  generation: number;
}

export class HistoryRenderQueue {
  private readonly jobs: HistoryRenderJob[] = [];
  private active = 0;
  private generation = 0;
  private scheduled: { owner: Window; id: number } | null = null;

  constructor(private readonly getWindow: () => Window) {}

  enqueue(run: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.jobs.push({ run, resolve, reject, generation: this.generation });
      this.schedule();
    });
  }

  clear(): void {
    this.generation++;
    if (this.scheduled) this.scheduled.owner.clearTimeout(this.scheduled.id);
    this.scheduled = null;
    for (const job of this.jobs.splice(0)) job.resolve();
  }

  private schedule(): void {
    if (this.scheduled || this.active >= 4 || !this.jobs.length) return;
    const owner = this.getWindow();
    this.scheduled = { owner, id: owner.setTimeout(() => {
      this.scheduled = null;
      this.drain();
    }, 0) };
  }

  private drain(): void {
    while (this.active < 4 && this.jobs.length) {
      const job = this.jobs.shift()!;
      this.active++;
      void Promise.resolve().then(() => {
        if (job.generation === this.generation) return job.run();
      }).then(job.resolve, job.reject).finally(() => {
        this.active--;
        this.schedule();
      });
    }
  }
}
