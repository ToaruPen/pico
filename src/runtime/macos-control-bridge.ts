import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { PicoResidentControlConfig } from "../config/index.js";

export type MacOSControlProcess = EventEmitter & {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly kill: (signal?: NodeJS.Signals) => boolean;
};

export type MacOSControlBridge = {
  readonly completion: Promise<void>;
  readonly close: () => Promise<void>;
};

export type StartMacOSControlBridgeOptions = {
  readonly control: PicoResidentControlConfig;
  readonly signal?: AbortSignal;
  readonly platform?: NodeJS.Platform;
  readonly readyTimeoutMs?: number;
  readonly executablePath?: string;
  readonly spawnProcess?: (
    executable: string,
    arguments_: readonly string[]
  ) => MacOSControlProcess;
};

const maximumDiagnosticBytes = 8192;
const maximumReadyLineBytes = 1024;
const terminationGraceMs = 1_000;
const terminationKillTimeoutMs = 1_000;

export function resolveMacOSControlExecutablePath(): string {
  return fileURLToPath(
    new URL("../../sidecars/macos-control/.build/release/pico-macos-control", import.meta.url)
  );
}

export async function startMacOSControlBridge(
  options: StartMacOSControlBridgeOptions
): Promise<MacOSControlBridge> {
  validateBridgeStartup(options);
  const child = createControlProcess(options);
  let standardError = "";
  let readyOutput = "";
  let readiness: "pending" | "ready" | "failed" = "pending";
  let stopping = false;
  let closed = false;
  let completionSettled = false;
  let processFailure: Error | undefined;
  let terminationOperation: Promise<void> | undefined;
  let cleanupProcessListeners: () => void = () => undefined;
  let resolveReady: () => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  let resolveCompletion: () => void = () => undefined;
  let rejectCompletion: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // Startup failures can make completion unobservable to the caller.
  void completion.catch(() => undefined);

  const settleCompletion = (error?: Error): void => {
    if (completionSettled) {
      return;
    }

    completionSettled = true;
    cleanupProcessListeners();

    if (error === undefined) {
      resolveCompletion();
    } else {
      rejectCompletion(error);
    }
  };
  const terminateProcess = (): Promise<void> => {
    if (terminationOperation !== undefined) {
      return terminationOperation;
    }

    if (closed) {
      return completion;
    }

    stopping = true;
    child.kill("SIGTERM");
    terminationOperation = (async () => {
      if (await waitForBridgeSettlement(completion, terminationGraceMs)) {
        return completion;
      }

      child.kill("SIGKILL");

      if (await waitForBridgeSettlement(completion, terminationKillTimeoutMs)) {
        return completion;
      }

      settleCompletion(
        new Error("pico macOS control bridge did not stop after SIGKILL", {
          ...(processFailure === undefined ? {} : { cause: processFailure })
        })
      );
      return completion;
    })();
    return terminationOperation;
  };
  const failReadiness = (error: Error): void => {
    if (readiness !== "pending") {
      return;
    }

    readiness = "failed";
    void terminateProcess().then(
      () => rejectReady(error),
      (terminationError: unknown) => {
        const terminationMessage =
          terminationError instanceof Error ? terminationError.message : String(terminationError);
        rejectReady(
          new Error(`${error.message}; ${terminationMessage}`, { cause: terminationError })
        );
      }
    );
  };
  const onStandardError = (chunk: Buffer | string): void => {
    if (standardError.length >= maximumDiagnosticBytes) {
      return;
    }

    standardError += Buffer.from(chunk)
      .toString("utf8")
      .slice(0, maximumDiagnosticBytes - standardError.length);
  };
  const onStandardOutput = (chunk: Buffer | string): void => {
    if (readiness !== "pending") {
      return;
    }

    readyOutput += Buffer.from(chunk).toString("utf8");

    if (readyOutput.length > maximumReadyLineBytes) {
      failReadiness(new Error("pico macOS control bridge emitted an invalid readiness line"));
      return;
    }

    const newlineIndex = readyOutput.indexOf("\n");

    if (newlineIndex === -1) {
      return;
    }

    const line = readyOutput.slice(0, newlineIndex).trim();

    if (line !== '{"event":"ready"}') {
      failReadiness(new Error("pico macOS control bridge emitted an invalid readiness line"));
      return;
    }

    readiness = "ready";
    resolveReady();
  };
  const onProcessError = (error: Error): void => {
    const bridgeError = new Error(`pico macOS control bridge process failed: ${error.message}`, {
      cause: error
    });

    if (readiness === "pending") {
      failReadiness(bridgeError);
      return;
    }

    if (!stopping) {
      processFailure = bridgeError;
      void terminateProcess().catch(() => undefined);
    }
  };
  const onClose = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
    closed = true;

    if (readiness === "pending") {
      readiness = "failed";
      rejectReady(
        new Error(
          `pico macOS control bridge exited before ready (${formatExit(code, exitSignal)})${formatDiagnostics(standardError)}`
        )
      );
      settleCompletion();
      return;
    }

    if (stopping) {
      settleCompletion(processFailure);
      return;
    }

    settleCompletion(
      new Error(
        `pico macOS control bridge exited unexpectedly (${formatExit(code, exitSignal)})${formatDiagnostics(standardError)}`
      )
    );
  };
  const close = (): Promise<void> => terminateProcess();
  const onAbort = (): void => {
    if (readiness === "pending") {
      failReadiness(new Error("pico macOS control bridge startup was aborted"));
      return;
    }

    close().catch(() => undefined);
  };
  cleanupProcessListeners = () => {
    options.signal?.removeEventListener("abort", onAbort);
    child.stderr.off("data", onStandardError);
    child.stdout.off("data", onStandardOutput);
    child.off("error", onProcessError);
    child.off("close", onClose);
  };

  child.stderr.on("data", onStandardError);
  child.stdout.on("data", onStandardOutput);
  child.once("error", onProcessError);
  child.once("close", onClose);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  if (options.signal?.aborted === true) {
    onAbort();
  }

  const timeout = setTimeout(() => {
    failReadiness(new Error("pico macOS control bridge did not become ready before timeout"));
  }, options.readyTimeoutMs ?? 5_000);
  timeout.unref();

  try {
    await ready;
  } finally {
    clearTimeout(timeout);
  }

  return { completion, close };
}

async function waitForBridgeSettlement(
  completion: Promise<void>,
  timeoutMs: number
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
    timeout.unref();
  });

  try {
    return await Promise.race([
      completion.then(
        () => true,
        () => true
      ),
      timedOut
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function validateBridgeStartup(options: StartMacOSControlBridgeOptions): void {
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("pico macOS control bridge requires macOS");
  }

  if (options.signal?.aborted) {
    throw new Error("pico macOS control bridge startup was aborted");
  }
}

function createControlProcess(options: StartMacOSControlBridgeOptions): MacOSControlProcess {
  const spawnProcess = options.spawnProcess ?? spawnControlProcess;
  const executablePath = options.executablePath ?? resolveMacOSControlExecutablePath();

  return spawnProcess(executablePath, buildBridgeArguments(options.control));
}

function spawnControlProcess(
  executable: string,
  arguments_: readonly string[]
): MacOSControlProcess {
  return spawn(executable, arguments_, {
    stdio: ["ignore", "pipe", "pipe"]
  }) as ChildProcess as MacOSControlProcess;
}

function buildBridgeArguments(control: PicoResidentControlConfig): readonly string[] {
  return [
    "--host",
    control.host,
    "--port",
    String(control.port),
    "--token-path",
    control.authTokenPath,
    "--talk-key",
    control.keyboard.talkKey,
    "--cancel-key",
    control.keyboard.cancelKey
  ];
}

function formatExit(code: number | null, signal: NodeJS.Signals | null): string {
  return code === null ? `signal ${signal ?? "unknown"}` : `code ${String(code)}`;
}

function formatDiagnostics(value: string): string {
  const diagnostics = value.trim();

  return diagnostics === "" ? "" : `: ${diagnostics}`;
}
