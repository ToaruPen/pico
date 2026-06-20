import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  acquireResidentSingleInstanceLock,
  registerResidentSingleInstanceLockShutdownCleanup
} from "../src/runtime/resident-single-instance-lock.js";

describe("resident single instance lock", () => {
  it("removes the lock when the current process owns it", () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-resident-lock-"));
    const lockPath = join(directory, "resident.lock");

    try {
      const lock = acquireResidentSingleInstanceLock(lockPath, {
        pid: 12_345,
        isProcessRunning: () => false
      });

      expect(readFileSync(lockPath, "utf8")).toBe("12345");

      lock.release();

      expect(() => readFileSync(lockPath, "utf8")).toThrow();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("does not remove another process lock during exit cleanup", () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-resident-lock-"));
    const lockPath = join(directory, "resident.lock");

    try {
      const lock = acquireResidentSingleInstanceLock(lockPath, {
        pid: 12_345,
        isProcessRunning: () => false
      });

      writeFileSync(lockPath, "54321");
      lock.release();

      expect(readFileSync(lockPath, "utf8")).toBe("54321");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("replaces stale locks and rejects live locks", () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-resident-lock-"));
    const lockPath = join(directory, "resident.lock");
    const isProcessRunning = vi.fn((pid: number) => pid === 22_222);

    try {
      writeFileSync(lockPath, "11111");
      const lock = acquireResidentSingleInstanceLock(lockPath, {
        pid: 12_345,
        isProcessRunning
      });

      expect(readFileSync(lockPath, "utf8")).toBe("12345");

      lock.release();
      writeFileSync(lockPath, "22222");

      expect(() =>
        acquireResidentSingleInstanceLock(lockPath, {
          pid: 12_345,
          isProcessRunning
        })
      ).toThrow("pico resident voice runtime is already running (pid: 22222)");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("keeps the lock during signal-triggered shutdown and releases it on process exit", () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-resident-lock-"));
    const lockPath = join(directory, "resident.lock");
    const processEvents = new EventEmitter();
    const abortController = new AbortController();

    try {
      const lock = acquireResidentSingleInstanceLock(lockPath, {
        pid: 12_345,
        isProcessRunning: () => false
      });
      const unregister = registerResidentSingleInstanceLockShutdownCleanup(
        lock,
        abortController,
        processEvents
      );

      processEvents.emit("SIGINT");

      expect(abortController.signal.aborted).toBe(true);
      expect(readFileSync(lockPath, "utf8")).toBe("12345");

      processEvents.emit("exit");

      expect(() => readFileSync(lockPath, "utf8")).toThrow();
      unregister();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("does not remove a fresh lock acquired during stale lock recovery", () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-resident-lock-"));
    const lockPath = join(directory, "resident.lock");
    let firstLivenessCheck = true;

    try {
      writeFileSync(lockPath, "11111");

      expect(() =>
        acquireResidentSingleInstanceLock(lockPath, {
          pid: 12_345,
          isProcessRunning: () => {
            if (firstLivenessCheck) {
              firstLivenessCheck = false;
              writeFileSync(lockPath, "22222");

              return false;
            }

            return true;
          }
        })
      ).toThrow("pico resident voice runtime is already running (pid: 22222)");
      expect(readFileSync(lockPath, "utf8")).toBe("22222");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("recovers stale recovery markers from dead owners", () => {
    const directory = mkdtempSync(join(tmpdir(), "pico-resident-lock-"));
    const lockPath = join(directory, "resident.lock");

    try {
      writeFileSync(lockPath, "11111");
      writeFileSync(`${lockPath}.recovery`, "22222");

      const lock = acquireResidentSingleInstanceLock(lockPath, {
        pid: 12_345,
        isProcessRunning: () => false
      });

      expect(readFileSync(lockPath, "utf8")).toBe("12345");
      expect(() => readFileSync(`${lockPath}.recovery`, "utf8")).toThrow();

      lock.release();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
