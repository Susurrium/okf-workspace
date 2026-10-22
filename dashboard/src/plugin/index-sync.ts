export class IndexSyncCoordinator {
  private active: Promise<void> | undefined;
  private requested = false;
  private fullScan = false;
  private readonly paths = new Set<string>();

  public constructor(private readonly synchronize: (paths?: readonly string[]) => Promise<void>) {}

  public request(paths?: readonly string[]): Promise<void> {
    this.requested = true;
    if (paths === undefined) this.fullScan = true;
    else for (const path of paths) this.paths.add(path);
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
      const paths = this.fullScan ? undefined : [...this.paths];
      this.fullScan = false;
      this.paths.clear();
      try {
        await this.synchronize(paths);
      } catch (error) {
        if (paths === undefined) this.fullScan = true;
        else for (const path of paths) this.paths.add(path);
        throw error;
      }
    }
  }
}
