export class IndexSyncCoordinator {
  private active: Promise<void> | undefined;
  private requested = false;

  public constructor(private readonly synchronize: () => Promise<void>) {}

  public request(): Promise<void> {
    this.requested = true;
    if (!this.active) {
      const pending = this.drain().finally(() => {
        if (this.active === pending) this.active = undefined;
      });
      this.active = pending;
    }
    return this.active;
  }

  private async drain(): Promise<void> {
    while (this.requested) {
      this.requested = false;
      await this.synchronize();
    }
  }
}
