import { describe, expect, it } from "vitest";

import {
  LocalServiceManager,
  type LocalServiceLaunchSettings,
} from "../src/plugin/local-service.js";

class FakeProcess {
  public code: number | null = null;
  public inputClosed = false;
  public terminated = false;
  private exitListener: (() => void) | undefined;

  public exitCode(): number | null {
    return this.code;
  }

  public closeInput(): void {
    this.inputClosed = true;
    this.code = 0;
    this.exitListener?.();
  }

  public terminate(): void {
    this.terminated = true;
    this.code = 1;
    this.exitListener?.();
  }

  public onError(_listener: (error: Error) => void): void {}

  public onExit(listener: () => void): void {
    this.exitListener = listener;
  }
}

const SETTINGS: LocalServiceLaunchSettings = {
  baseUrl: "http://127.0.0.1:8765",
  enabled: true,
  pythonExecutable: "E:\\code\\okf-workspace\\engine\\.venv\\Scripts\\python.exe",
  deploymentConfig: "E:\\ObsidianData\\OKF-Brain-State\\config\\deployment.json",
  logDirectory: "E:\\ObsidianData\\OKF-Brain-State\\logs",
};

describe("LocalServiceManager", () => {
  it("starts one owner-pipe service and stops only the process it owns", async () => {
    const process = new FakeProcess();
    const launched: { executable?: string; args?: string[] } = {};
    let checks = 0;
    const manager = new LocalServiceManager(
      () => SETTINGS,
      async () => {
        checks += 1;
        return checks >= 3;
      },
      (executable, args) => {
        launched.executable = executable;
        launched.args = args;
        return process;
      },
      async () => undefined,
    );

    await expect(manager.ensureStarted()).resolves.toBe("started");
    expect(launched.executable).toBe(SETTINGS.pythonExecutable);
    expect(launched.args).toEqual([
      "-m",
      "okf_workspace.server",
      "--config",
      SETTINGS.deploymentConfig,
      "--log-directory",
      SETTINGS.logDirectory,
      "--exit-on-stdin-close",
    ]);

    await manager.stop();
    expect(process.inputClosed).toBe(true);
    expect(process.terminated).toBe(false);
  });

  it("reuses an existing service and does not stop a process it did not start", async () => {
    let launches = 0;
    const manager = new LocalServiceManager(
      () => SETTINGS,
      async () => true,
      () => {
        launches += 1;
        return new FakeProcess();
      },
      async () => undefined,
    );

    await expect(manager.ensureStarted()).resolves.toBe("already-running");
    await manager.stop();
    expect(launches).toBe(0);
  });

  it("replaces a service that disappears during a plugin reload", async () => {
    const process = new FakeProcess();
    const health = [true, false, false, true];
    let launches = 0;
    const manager = new LocalServiceManager(
      () => SETTINGS,
      async () => health.shift() ?? true,
      () => {
        launches += 1;
        return process;
      },
      async () => undefined,
    );

    await expect(manager.ensureStarted()).resolves.toBe("started");
    expect(launches).toBe(1);
    await manager.stop();
  });

  it("keeps a live owned service when a later health probe would be slow", async () => {
    const process = new FakeProcess();
    let launches = 0;
    const health = [false, true];
    const manager = new LocalServiceManager(
      () => SETTINGS,
      async () => health.shift() ?? false,
      () => {
        launches += 1;
        return process;
      },
      async () => undefined,
    );

    await expect(manager.ensureStarted()).resolves.toBe("started");
    await expect(manager.ensureStarted()).resolves.toBe("already-running");
    expect(launches).toBe(1);
    expect(process.inputClosed).toBe(false);
    expect(process.terminated).toBe(false);
    await manager.stop();
  });

  it("reuses its healthy owned service without a reload grace wait", async () => {
    const process = new FakeProcess();
    let healthy = false;
    let waits = 0;
    const manager = new LocalServiceManager(
      () => SETTINGS,
      async () => healthy,
      () => {
        healthy = true;
        return process;
      },
      async () => {
        waits += 1;
      },
    );

    await expect(manager.ensureStarted()).resolves.toBe("started");
    const waitsAfterStartup = waits;
    await expect(manager.ensureStarted()).resolves.toBe("already-running");
    expect(waits).toBe(waitsAfterStartup);
    await manager.stop();
  });

  it("lets a replacement plugin instance adopt the child before delayed unload", async () => {
    const process = new FakeProcess();
    let healthy = false;
    let releaseStop: (() => void) | undefined;
    const stopWait = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const first = new LocalServiceManager(
      () => SETTINGS,
      async () => healthy,
      () => {
        healthy = true;
        return process;
      },
      async (milliseconds) => {
        if (milliseconds === 2_000) await stopWait;
      },
    );
    await expect(first.ensureStarted()).resolves.toBe("started");
    const stopping = first.stop();

    const replacement = new LocalServiceManager(
      () => SETTINGS,
      async () => true,
      () => {
        throw new Error("replacement must adopt the existing process");
      },
      async () => undefined,
    );
    await expect(replacement.ensureStarted()).resolves.toBe("already-running");
    releaseStop?.();
    await stopping;
    expect(process.inputClosed).toBe(false);

    await replacement.stop();
    expect(process.inputClosed).toBe(true);
  });

  it("refuses a non-loopback service address", async () => {
    const manager = new LocalServiceManager(
      () => ({ ...SETTINGS, baseUrl: "https://untrusted.example" }),
      async () => false,
      () => new FakeProcess(),
      async () => undefined,
    );

    await expect(manager.ensureStarted()).rejects.toThrow("127.0.0.1");
  });
});
