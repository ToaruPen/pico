import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type ResidentSingleInstanceLock = {
  readonly release: () => void;
};

export type ResidentSingleInstanceLockOptions = {
  readonly pid?: number;
  readonly isProcessRunning?: (pid: number) => boolean;
};

export type ResidentSingleInstanceLockProcessEvents = {
  readonly once: (event: "exit" | "SIGINT" | "SIGTERM", listener: () => void) => unknown;
  readonly off: (event: "exit" | "SIGINT" | "SIGTERM", listener: () => void) => unknown;
};

export function acquireResidentSingleInstanceLock(
  lockPath: string,
  options: ResidentSingleInstanceLockOptions = {}
): ResidentSingleInstanceLock {
  const resolved = resolve(lockPath);
  const pid = options.pid ?? process.pid;
  const isProcessRunning = options.isProcessRunning ?? defaultIsProcessRunning;

  mkdirSync(dirname(resolved), { recursive: true });
  writeSingleInstanceLock(resolved, pid, isProcessRunning);

  return {
    release: () => {
      if (readLockPid(resolved) === pid) {
        rmSync(resolved, { force: true });
      }
    }
  };
}

export function registerResidentSingleInstanceLockShutdownCleanup(
  lock: ResidentSingleInstanceLock,
  abortController: AbortController,
  processEvents: ResidentSingleInstanceLockProcessEvents = process
): () => void {
  const cleanup = (): void => {
    lock.release();
  };
  const abort = (): void => {
    abortController.abort();
  };

  processEvents.once("exit", cleanup);
  processEvents.once("SIGINT", abort);
  processEvents.once("SIGTERM", abort);

  return () => {
    processEvents.off("exit", cleanup);
    processEvents.off("SIGINT", abort);
    processEvents.off("SIGTERM", abort);
  };
}

function writeSingleInstanceLock(
  resolved: string,
  pid: number,
  isProcessRunning: (pid: number) => boolean
): void {
  try {
    writeLockFile(resolved, pid);
  } catch (error) {
    if (!isFileAlreadyExistsError(error)) {
      throw error;
    }

    const existingPid = requireNoRunningLock(resolved, isProcessRunning);

    recoverStaleLock(resolved, existingPid, pid, isProcessRunning);
  }
}

function recoverStaleLock(
  resolved: string,
  stalePid: number | undefined,
  pid: number,
  isProcessRunning: (pid: number) => boolean
): void {
  const recoveryLockPath = `${resolved}.recovery`;
  acquireRecoveryLock(recoveryLockPath, pid, isProcessRunning);

  try {
    requireObservedStaleLock(resolved, stalePid, isProcessRunning);
    rmSync(resolved, { force: true });

    try {
      writeLockFile(resolved, pid);
    } catch (error) {
      if (!isFileAlreadyExistsError(error)) {
        throw error;
      }

      requireNoRunningLock(resolved, isProcessRunning);
      throw error;
    }
  } finally {
    rmSync(recoveryLockPath, { force: true });
  }
}

function acquireRecoveryLock(
  recoveryLockPath: string,
  pid: number,
  isProcessRunning: (pid: number) => boolean
): void {
  try {
    writeLockFile(recoveryLockPath, pid);
  } catch (error) {
    if (!isFileAlreadyExistsError(error)) {
      throw error;
    }

    const recoveryPid = readLockPid(recoveryLockPath);

    if (recoveryPid !== undefined && isProcessRunning(recoveryPid)) {
      throw new Error(
        `pico resident voice lock recovery is already running (pid: ${recoveryPid})`,
        {
          cause: error
        }
      );
    }

    rmSync(recoveryLockPath, { force: true });
    writeLockFile(recoveryLockPath, pid);
  }
}

function requireObservedStaleLock(
  resolved: string,
  stalePid: number | undefined,
  isProcessRunning: (pid: number) => boolean
): void {
  const currentPid = readLockPid(resolved);

  if (currentPid !== stalePid) {
    requireNoRunningLock(resolved, isProcessRunning);
    throw new Error("pico resident voice lock changed during stale recovery");
  }
}

function requireNoRunningLock(
  resolved: string,
  isProcessRunning: (pid: number) => boolean
): number | undefined {
  const existingPid = readLockPid(resolved);

  if (existingPid !== undefined && isProcessRunning(existingPid)) {
    throw new Error(`pico resident voice runtime is already running (pid: ${existingPid})`);
  }

  return existingPid;
}

function writeLockFile(resolved: string, pid: number): void {
  const file = openSync(resolved, "wx");

  try {
    writeFileSync(file, String(pid));
  } finally {
    closeSync(file);
  }
}

function readLockPid(resolved: string): number | undefined {
  try {
    const parsed = Number(readFileSync(resolved, "utf8").trim());

    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

function defaultIsProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ESRCH") {
      return false;
    }

    if (isErrnoException(error) && error.code === "EPERM") {
      return true;
    }

    throw error;
  }
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return isErrnoException(error) && error.code === "EEXIST";
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
