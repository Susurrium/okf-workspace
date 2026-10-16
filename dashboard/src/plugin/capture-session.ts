import { CaptureRelationError, normalizeCaptureRelation, type CaptureRelation } from '../domain/capture-context.js';

export interface PreparedCapture { path: string; markdown: string; relation: CaptureRelation }
export interface CaptureSnapshot {
  text: string;
  relation: CaptureRelation;
  busy: boolean;
  locked: boolean;
  error: string;
  savedPath?: string;
}
export interface CaptureSessionOptions {
  initialRelation?: CaptureRelation;
  text: string;
  relation: CaptureRelation;
  prepared?: PreparedCapture;
  persist(text: string, relation: CaptureRelation, prepared?: PreparedCapture): void;
  flush(): Promise<void>;
  prepare(text: string, relation: CaptureRelation): Promise<PreparedCapture>;
  write(prepared: PreparedCapture): Promise<{ path: string }>;
  refresh(): Promise<void>;
  saved(path: string): void;
}

/** 同一上下文的所有输入界面共享草稿、写入目标及重试状态。 */
export class CaptureSession {
  private text: string;
  private relation: CaptureRelation;
  private prepared?: PreparedCapture;
  private savedPath?: string;
  private error = '';
  private pending?: Promise<void>;
  private busy = false;
  private readonly listeners = new Set<(state: CaptureSnapshot) => void>();

  public constructor(private readonly options: CaptureSessionOptions) {
    this.text = options.text;
    this.relation = normalizeCaptureRelation(options.relation);
    this.prepared = options.prepared;
  }

  public snapshot(): CaptureSnapshot {
    return { text: this.text, relation: { ...this.relation }, busy: this.busy, locked: !!this.prepared, error: this.error, savedPath: this.savedPath };
  }

  public reportDraftError(error: unknown): void {
    this.error = `草稿尚未保存到磁盘，请保留输入并重试：${String(error)}`;
    this.emit();
  }

  public subscribe(listener: (state: CaptureSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => { this.listeners.delete(listener); };
  }

  public setText(text: string): void {
    if (this.busy || text === this.text) return;
    if (this.prepared) throw new Error('上次记录尚未完成，请先重试保存，再编辑新内容。');
    this.text = text;
    this.error = '';
    this.changed();
  }

  public setRelation(relation: CaptureRelation): void {
    if (this.busy) return;
    if (this.prepared) throw new Error('上次记录尚未完成，请先重试保存，再修改关联。');
    this.relation = normalizeCaptureRelation(relation);
    this.error = '';
    this.changed();
  }

  public submit(): Promise<void> {
    if (this.pending) return this.pending;
    if (!this.text.trim()) return Promise.reject(new Error('请输入要记录的内容'));
    this.busy = true;
    this.error = '';
    this.emit();
    this.pending = this.publish().finally(() => {
      this.busy = false;
      this.pending = undefined;
      this.emit();
    });
    return this.pending;
  }

  private async publish(): Promise<void> {
    try {
      this.prepared ??= await this.options.prepare(this.text.trim(), this.relation);
      // 先持久保存固定写入目标，重启或结果刷新失败后重试仍只写同一条记录。
      this.options.persist(this.text, this.relation, this.prepared);
      await this.options.flush();
      const result = await this.options.write(this.prepared);
      this.savedPath = result.path;
      await this.options.refresh();
      this.options.persist('', {}, undefined);
      await this.options.flush();
      this.text = '';
      this.relation = normalizeCaptureRelation(this.options.initialRelation ?? {});
      this.prepared = undefined;
      this.savedPath = undefined;
      this.options.saved(result.path);
    } catch (error) {
      if (error instanceof CaptureRelationError && !this.savedPath) this.prepared = undefined;
      this.options.persist(this.text, this.relation, this.prepared);
      this.error = this.savedPath
        ? `记录已保存到 ${this.savedPath}，后续步骤失败，请重试：${String(error)}`
        : `保存失败，内容已保留：${String(error)}`;
      throw new Error(this.error);
    }
  }

  private changed(): void {
    this.options.persist(this.text, this.relation, this.prepared);
    this.emit();
  }

  private emit(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }
}
