import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

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
  let exited = false;
  let terminationRequested = false;
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

  const requestTermination = (): void => {
    if (exited || terminationRequested) {
      return;
    }

    terminationRequested = true;
    child.kill("SIGTERM");
  };
  const failReadiness = (error: Error): void => {
    if (readiness !== "pending") {
      return;
    }

    readiness = "failed";
    stopping = true;
    requestTermination();
    rejectReady(error);
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
      rejectCompletion(bridgeError);
    }
  };
  const onExit = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
    exited = true;
    options.signal?.removeEventListener("abort", onAbort);

    if (readiness === "pending") {
      readiness = "failed";
      rejectReady(
        new Error(
          `pico macOS control bridge exited before ready (${formatExit(code, exitSignal)})${formatDiagnostics(standardError)}`
        )
      );
      resolveCompletion();
      return;
    }

    if (stopping) {
      resolveCompletion();
      return;
    }

    rejectCompletion(
      new Error(
        `pico macOS control bridge exited unexpectedly (${formatExit(code, exitSignal)})${formatDiagnostics(standardError)}`
      )
    );
  };
  const close = (): Promise<void> => {
    if (!stopping) {
      stopping = true;
      requestTermination();
    }

    return completion;
  };
  const onAbort = (): void => {
    if (readiness === "pending") {
      failReadiness(new Error("pico macOS control bridge startup was aborted"));
      return;
    }

    close().catch(() => undefined);
  };

  child.stderr.on("data", onStandardError);
  child.stdout.on("data", onStandardOutput);
  child.once("error", onProcessError);
  child.once("exit", onExit);
  options.signal?.addEventListener("abort", onAbort, { once: true });

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
