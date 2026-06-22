import { describe, expect, it, vi } from "vitest";

import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import { createSessionLifecycle } from "../src/modules/session/index.js";

describe("session lifecycle", () => {
  it("starts from a typed trigger and ends after the configured timed duration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T09:00:00.000Z"));

    try {
      const audit = createStructuredAuditLog();
      const lifecycle = createSessionLifecycle({
        ending: {
          mode: "timed",
          durationMs: 60_000
        },
        audit
      });

      const session = lifecycle.start({
        kind: "wake_name",
        label: "ピコ",
        source: "voice"
      });
      lifecycle.appendEntry(session.id, {
        role: "staff",
        content: "今日の工作は折り紙です。"
      });

      expect(session).toMatchObject({
        id: "session-1",
        state: "active",
        startedAt: "2026-06-12T09:00:00.000Z",
        trigger: {
          kind: "wake_name",
          label: "ピコ",
          source: "voice"
        }
      });
      expect(lifecycle.read(session.id)?.state).toBe("active");

      vi.advanceTimersByTime(60_000);

      const ended = lifecycle.read(session.id);
      expect(ended?.state).toBe("ended");
      expect(ended?.endedAt).toBe("2026-06-12T09:01:00.000Z");
      expect(lifecycle.cutoff(session.id)).toEqual({
        sessionId: "session-1",
        cutoffAt: "2026-06-12T09:01:00.000Z",
        sourceEntryIds: ["session-1-entry-1"],
        entries: [
          {
            id: "session-1-entry-1",
            role: "staff",
            content: "今日の工作は折り紙です。"
          }
        ],
        requestedBy: "session_lifecycle"
      });
      lifecycle.acknowledgeCutoff(session.id);
      expect(lifecycle.read(session.id)).toBeUndefined();
      expect(audit.entries().map((event) => event.name)).toEqual([
        "session.started",
        "session.ended"
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unsupported trigger kinds and cannot append after ending", () => {
    vi.useFakeTimers();

    try {
      const lifecycle = createSessionLifecycle({
        ending: {
          mode: "timed",
          durationMs: 1
        }
      });

      expect(() =>
        lifecycle.start({
          kind: "camera_person_detected" as "wake_name",
          label: "person",
          source: "camera"
        })
      ).toThrow("pico session start trigger kind is invalid");

      const session = lifecycle.start({
        kind: "bell",
        label: "front bell",
        source: "gpio"
      });
      vi.advanceTimersByTime(1);

      expect(() =>
        lifecycle.appendEntry(session.id, {
          role: "staff",
          content: "終了後の追記はできない。"
        })
      ).toThrow("pico session is not active");
    } finally {
      vi.useRealTimers();
    }
  });

  it("can explicitly end an active session for resident shutdown cutoff", () => {
    const lifecycle = createSessionLifecycle({
      ending: {
        mode: "timed",
        durationMs: 60_000
      }
    });
    const session = lifecycle.start({
      kind: "wake_name",
      label: "ピコ",
      source: "voice"
    });
    lifecycle.appendEntry(session.id, {
      role: "staff",
      content: "終了時にも記憶化する内容です。"
    });

    expect(lifecycle.end(session.id)).toMatchObject({
      id: session.id,
      state: "ended"
    });
    expect(lifecycle.cutoff(session.id)).toMatchObject({
      sessionId: session.id,
      sourceEntryIds: ["session-1-entry-1"]
    });
  });

  it("ends timed sessions after the latest activity instead of the start time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T09:00:00.000Z"));

    try {
      const lifecycle = createSessionLifecycle({
        ending: {
          mode: "timed",
          durationMs: 60_000
        }
      });
      const session = lifecycle.start({
        kind: "wake_name",
        label: "ピコ",
        source: "voice"
      });

      vi.advanceTimersByTime(50_000);
      vi.setSystemTime(new Date("2026-06-12T09:00:50.000Z"));
      lifecycle.refreshActivity(session.id);

      vi.advanceTimersByTime(10_000);
      expect(lifecycle.read(session.id)?.state).toBe("active");

      vi.advanceTimersByTime(50_000);
      expect(lifecycle.read(session.id)?.state).toBe("ended");
      expect(lifecycle.read(session.id)?.endedAt).toBe("2026-06-12T09:01:50.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces one active session at a time and allows a new session after timed ending", () => {
    vi.useFakeTimers();

    try {
      const lifecycle = createSessionLifecycle({
        ending: {
          mode: "timed",
          durationMs: 10
        }
      });
      lifecycle.start({
        kind: "wake_name",
        label: "ピコ",
        source: "voice"
      });

      expect(() =>
        lifecycle.start({
          kind: "bell",
          label: "front bell",
          source: "gpio"
        })
      ).toThrow("pico session is already active");

      vi.advanceTimersByTime(10);

      expect(
        lifecycle.start({
          kind: "bell",
          label: "front bell",
          source: "gpio"
        })
      ).toMatchObject({
        id: "session-2",
        state: "active"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not keep short-lived Pi Agent print-mode processes alive with session timers", () => {
    const timers: NodeJS.Timeout[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    const captureSetTimeout = (handler: TimerHandler, timeout?: number): NodeJS.Timeout => {
      const timer = originalSetTimeout(handler, timeout) as unknown as NodeJS.Timeout;
      timers.push(timer);

      return timer;
    };
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(captureSetTimeout);

    try {
      const lifecycle = createSessionLifecycle({
        ending: {
          mode: "timed",
          durationMs: 60_000
        }
      });
      lifecycle.start({
        kind: "greeting",
        label: "おはよう",
        source: "field-test"
      });

      expect(timers[0]?.hasRef()).toBe(false);
    } finally {
      for (const timer of timers) {
        clearTimeout(timer);
      }

      timeoutSpy.mockRestore();
    }
  });

  it("isolates audit failures from session state changes and timer callbacks", () => {
    vi.useFakeTimers();

    try {
      const lifecycle = createSessionLifecycle({
        ending: {
          mode: "timed",
          durationMs: 1
        },
        audit: {
          record: () => {
            throw new Error("audit sink unavailable");
          },
          entries: () => []
        }
      });

      const session = lifecycle.start({
        kind: "wake_name",
        label: "ピコ",
        source: "voice"
      });
      expect(lifecycle.read(session.id)?.state).toBe("active");

      expect(() => vi.advanceTimersByTime(1)).not.toThrow();
      expect(lifecycle.read(session.id)?.state).toBe("ended");
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts ended sessions after the configured retention window", () => {
    vi.useFakeTimers();

    try {
      const lifecycle = createSessionLifecycle({
        ending: {
          mode: "timed",
          durationMs: 1
        },
        endedSessionRetentionMs: 2
      });
      const session = lifecycle.start({
        kind: "bell",
        label: "front bell",
        source: "gpio"
      });

      vi.advanceTimersByTime(1);
      expect(lifecycle.read(session.id)?.state).toBe("ended");

      vi.advanceTimersByTime(2);
      expect(lifecycle.read(session.id)).toBeUndefined();
      expect(() => lifecycle.cutoff(session.id)).toThrow("pico session does not exist");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an ended session after cutoff until the cutoff is acknowledged", () => {
    vi.useFakeTimers();

    try {
      const lifecycle = createSessionLifecycle({
        ending: {
          mode: "timed",
          durationMs: 1
        },
        endedSessionRetentionMs: 1_000
      });
      const session = lifecycle.start({
        kind: "wake_name",
        label: "ピコ",
        source: "voice"
      });
      lifecycle.appendEntry(session.id, {
        role: "staff",
        content: "記憶に残す発話です。"
      });

      vi.advanceTimersByTime(1);

      const cutoff = lifecycle.cutoff(session.id);
      expect(cutoff.sessionId).toBe(session.id);
      expect(lifecycle.read(session.id)?.state).toBe("ended");

      lifecycle.acknowledgeCutoff(session.id);
      expect(lifecycle.read(session.id)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects runtime timed endings beyond Node timer bounds", () => {
    expect(() =>
      createSessionLifecycle({
        ending: {
          mode: "timed",
          durationMs: 2_147_483_648
        }
      })
    ).toThrow("pico session ending durationMs must be a positive integer <= 2147483647");
  });
});
