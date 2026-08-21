import { spawn } from "node:child_process";

export interface LocalServiceLaunchSettings {
  baseUrl: string;
  enabled: boolean;
  pythonExecutable: string;
  deploymentConfig: string;
  logDirectory: string;
}

export type LocalServiceStartResult = "already-running" | "started";

interface ManagedServiceProcess {
  exitCode(): number | null;
  closeInput(): void;
  terminate(): void;
  onError(listener: (error: Error) => void): void;
  onExit(listener: () => void): void;
}

interface SharedOwnedService {
  process: ManagedServiceProcess;
  generation: number;
}

const SHARED_SERVICES_KEY = Symbol.for("okf-workspace.local-services");

function sharedServices(): Map<string, SharedOwnedService> {
  const runtime = globalThis as typeof globalThis & {
    [SHARED_SERVICES_KEY]?: Map<string, SharedOwnedService>;
  };
  runtime[SHARED_SERVICES_KEY] ??= new Map<string, SharedOwnedService>();
  return runtime[SHARED_SERVICES_KEY];
}

type Launcher = (executable: string, args: string[]) => ManagedServiceProcess;
type Pause = (milliseconds: number) => Promise<void>;
type HealthCheck = (baseUrl: string) => Promise<boolean>;

function assertLoopback(baseUrl: string): void {
  const parsed = new URL(baseUrl);
  const host = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("工作区本地服务地址必须是 http://127.0.0.1 或 localhost");
  }
}

const launch: Launcher = (executable, args) => {
  const child = spawn(executable, args, {
    windowsHide: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  return {
    exitCode: () => child.exitCode,
    closeInput: () => child.stdin?.end(),
    terminate: () => {
      child.kill();
    },
    onError: (listener) => {
      child.once("error", listener);
    },
    onExit: (listener) => {
      child.once("exit", listener);
    },
  };
};

const pause: Pause = (milliseconds) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const healthCheck: HealthCheck = async (baseUrl) => {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/u, "")}/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
};

export class LocalServiceManager {
  private owned: ManagedServiceProcess | undefined;
  private ownedGeneration: number | undefined;
  private startup: Promise<LocalServiceStartResult> | undefined;

  public constructor(
    private readonly settings: () => LocalServiceLaunchSettings,
    private readonly checkHealth: HealthCheck = healthCheck,
    private readonly startProcess: Launcher = launch,
    private readonly wait: Pause = pause,
  ) {}

  public ensureStarted(): Promise<LocalServiceStartResult> {
    this.adoptSharedProcess();
    if (this.startup) return this.startup;
    const pending = this.start().finally(() => {
      if (this.startup === pending) this.startup = undefined;
    });
    this.startup = pending;
    return pending;
  }

  public async stop(): Promise<void> {
    const process = this.owned;
    const generation = this.ownedGeneration;
    const baseUrl = this.settings().baseUrl;
    this.owned = undefined;
    this.ownedGeneration = undefined;
    if (!process || process.exitCode() !== null) return;
    // Obsidian reloads a plugin by unloading the old JavaScript instance before
    // the replacement has fully initialized. Keep the child alive briefly so
    // the new instance can adopt the same process instead of closing an active
    // HTTP response. A real disable/Obsidian exit has no replacement claimant,
    // so the owner pipe is still closed after this bounded handoff window.
    await this.wait(2_000);
    const shared = sharedServices().get(baseUrl);
    if (
      shared?.process === process &&
      generation !== undefined &&
      shared.generation !== generation
    ) {
      return;
    }
    await this.stopProcess(process, baseUrl);
  }

  private async stopProcess(process: ManagedServiceProcess, baseUrl: string): Promise<void> {
    if (process.exitCode() !== null) return;
    process.closeInput();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (process.exitCode() !== null) {
        this.forgetSharedProcess(baseUrl, process);
        return;
      }
      await this.wait(100);
    }
    process.terminate();
    this.forgetSharedProcess(baseUrl, process);
  }

  private async start(): Promise<LocalServiceStartResult> {
    const settings = this.settings();
    assertLoopback(settings.baseUrl);
    // A live child can be busy with indexing, conversion, or a diagnostic request.
    // Treat process liveness as ownership liveness: a single slow health probe must
    // never tear down in-flight requests and background work.
    if (this.owned?.exitCode() === null) return "already-running";
    if (await this.checkHealth(settings.baseUrl)) {
      // A plugin reload closes the previous owner's pipe. Give that instance one
      // bounded shutdown window before deciding it is safe to reuse.
      await this.wait(1_250);
      if (await this.checkHealth(settings.baseUrl)) return "already-running";
    }
    if (!settings.enabled) throw new Error("工作区本地服务自动启动已关闭");
    if (!settings.pythonExecutable || !settings.deploymentConfig) {
      throw new Error("工作区本地服务缺少 Python 或部署配置路径");
    }
    const process = this.startProcess(settings.pythonExecutable, [
      "-m",
      "okf_workspace.server",
      "--config",
      settings.deploymentConfig,
      "--log-directory",
      settings.logDirectory,
      "--exit-on-stdin-close",
    ]);
    this.owned = process;
    const shared: SharedOwnedService = { process, generation: 1 };
    sharedServices().set(settings.baseUrl, shared);
    this.ownedGeneration = shared.generation;
    const failure: { error?: Error } = {};
    process.onError((error) => {
      failure.error = error;
    });
    process.onExit(() => {
      if (this.owned === process) this.owned = undefined;
      if (this.ownedGeneration === shared.generation) this.ownedGeneration = undefined;
      this.forgetSharedProcess(settings.baseUrl, process);
    });
    for (let attempt = 0; attempt < 32; attempt += 1) {
      if (failure.error) throw failure.error;
      if (await this.checkHealth(settings.baseUrl)) return "started";
      if (process.exitCode() !== null) {
        throw new Error(`工作区本地服务提前退出（code ${process.exitCode()}）`);
      }
      await this.wait(250);
    }
    process.terminate();
    if (this.owned === process) this.owned = undefined;
    throw new Error("工作区本地服务启动超时，请查看 Runtime State/logs");
  }

  private adoptSharedProcess(): void {
    if (this.owned?.exitCode() === null) return;
    const baseUrl = this.settings().baseUrl;
    const shared = sharedServices().get(baseUrl);
    if (!shared) return;
    if (shared.process.exitCode() !== null) {
      sharedServices().delete(baseUrl);
      return;
    }
    shared.generation += 1;
    this.owned = shared.process;
    this.ownedGeneration = shared.generation;
  }

  private forgetSharedProcess(baseUrl: string, process: ManagedServiceProcess): void {
    if (sharedServices().get(baseUrl)?.process === process) {
      sharedServices().delete(baseUrl);
    }
  }
}
