export class TFile {
  public readonly name: string;
  public readonly basename: string;

  public constructor(public readonly path: string) {
    this.name = path.split("/").at(-1) ?? path;
    this.basename = this.name.replace(/\.[^.]+$/u, "");
  }
}

export class WorkspaceLeaf {
  public constructor(public readonly app: unknown = {}) {}
}

export class ItemView {
  public readonly app: unknown;
  public readonly contentEl = {} as HTMLElement;

  public constructor(leaf: WorkspaceLeaf) {
    this.app = leaf.app;
  }
}

export class Notice {
  public readonly noticeEl = {} as HTMLElement;

  public constructor(_message = "", _timeout = 0) {}

  public hide(): void {}
}

export function parseYaml(source: string): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  let uses: Record<string, string | null>[] | undefined;
  let currentUse: Record<string, string | null> | undefined;
  const clean = (value: string): string => value.trim().replace(/^['"]|['"]$/gu, "");
  for (const line of source.split(/\r?\n/u)) {
    if (/^uses:\s*$/u.test(line)) {
      uses = [];
      parsed.uses = uses;
      currentUse = undefined;
      continue;
    }
    const useStart = /^\s+-\s+purpose:\s*(.*?)\s*$/u.exec(line);
    if (uses && useStart?.[1] !== undefined) {
      currentUse = { purpose: clean(useStart[1]) };
      uses.push(currentUse);
      continue;
    }
    const useField = /^\s+(course|project):\s*(.*?)\s*$/u.exec(line);
    if (currentUse && useField?.[1] && useField[2] !== undefined) {
      currentUse[useField[1]] = clean(useField[2]) || null;
      continue;
    }
    const match = /^([^\s:#][^:#]*):\s*(.*?)\s*$/u.exec(line);
    if (match?.[1] && match[2] !== undefined) {
      parsed[match[1].trim()] = clean(match[2]);
      currentUse = undefined;
    }
  }
  return parsed;
}
