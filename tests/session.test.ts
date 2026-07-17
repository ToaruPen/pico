import { describe, expect, it, vi } from "vitest";

import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import { createSessionLifecycle } from "../src/modules/session/index.js";

const trigger = {
  kind: "wake_name",
  label: "ピコ",
  source: "voice"
} as const;

describe("session lifecycle", () => {
  it("keeps only interaction-control state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T09:00:00.000Z"));

    try {
      const lifecycle = createSessionLifecycle({
        ending: { mode: "timed", durationMs: 1_000 }
      });

      expect(lifecycle.start(trigger)).toEqual({
        id: "session-1",
        state: "active",
        startedAt: "2026-06-12T09:00:00.000Z",
        endedAt: undefined,
        trigger
      });
      expect(lifecycle.read("session-1")).not.toHaveProperty("entries");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends after the configured inactivity duration and records audit-safe attributes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T09:00:00.000Z"));

    try {
      const audit = createStructuredAuditLog();
      const lifecycle = createSessionLifecycle({
        ending: { mode: "timed", durationMs: 60_000 },
        audit
      });
      lifecycle.start(trigger);

      vi.advanceTimersByTime(60_000);

      expect(lifecycle.read("session-1")).toMatchObject({
        state: "ended",
        endedAt: "2026-06-12T09:01:00.000Z"
      });
      expect(audit.entries().map((event) => event.name)).toEqual([
        "session.started",
        "session.ended"
      ]);
      expect(audit.entries().map((event) => event.attributes)).toEqual([
        {
          "pico.session.id": "session-1",
          "pico.session.trigger_kind": "wake_name"
        },
        {
          "pico.session.id": "session-1",
          "pico.session.trigger_kind": "wake_name"
        }
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends timed sessions after the latest activity instead of the start time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T09:00:00.000Z"));

    try {
      const lifecycle = createSessionLifecycle({
        ending: { mode: "timed", durationMs: 60_000 }
      });
      lifecycle.start(trigger);

      vi.advanceTimersByTime(50_000);
      vi.setSystemTime(new Date("2026-06-12T09:00:50.000Z"));
      lifecycle.refreshActivity("session-1");

      vi.advanceTimersByTime(10_000);
      expect(lifecycle.read("session-1")?.state).toBe("active");

      vi.advanceTimersByTime(50_000);
      expect(lifecycle.read("session-1")).toMatchObject({
        state: "ended",
        endedAt: "2026-06-12T09:01:50.000Z"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces one active interaction and allows another after ending", () => {
    const lifecycle = createSessionLifecycle({
      ending: { mode: "timed", durationMs: 60_000 }
    });
    lifecycle.start(trigger);

    expect(() => lifecycle.start({ kind: "bell", label: "front bell", source: "gpio" })).toThrow(
      "pico session is already active"
    );

    lifecycle.end("session-1");
    expect(lifecycle.start({ kind: "bell", label: "front bell", source: "gpio" })).toMatchObject({
      id: "session-2",
      state: "active"
    });
  });

  it("ends idempotently", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T09:00:00.000Z"));

    try {
      const lifecycle = createSessionLifecycle({
        ending: { mode: "timed", durationMs: 60_000 }
      });
      lifecycle.start(trigger);
      const first = lifecycle.end("session-1");

      vi.setSystemTime(new Date("2026-06-12T09:01:00.000Z"));

      expect(lifecycle.end("session-1")).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("notifies ended-session subscribers once and supports unsubscribe", () => {
    vi.useFakeTimers();

    try {
      const lifecycle = createSessionLifecycle({
        ending: { mode: "timed", durationMs: 1_000 }
      });
      const ended: string[] = [];
      const unsubscribe = lifecycle.subscribeEnded((session) => ended.push(session.id));
      lifecycle.start(trigger);

      lifecycle.end("session-1");
      lifecycle.end("session-1");
      expect(ended).toEqual(["session-1"]);

      lifecycle.start(trigger);
      unsubscribe();
      vi.advanceTimersByTime(1_000);
      expect(ended).toEqual(["session-1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns immutable interaction snapshots", () => {
    const lifecycle = createSessionLifecycle({
      ending: { mode: "timed", durationMs: 60_000 }
    });
    const started = lifecycle.start(trigger);

    expect(Object.isFrozen(started)).toBe(true);
    expect(Object.isFrozen(started.trigger)).toBe(true);
    expect(() => Object.assign(started.trigger, { label: "変更" })).toThrow(TypeError);
    expect(lifecycle.read(started.id)?.trigger.label).toBe("ピコ");
  });

  it("removes only an ended interaction", () => {
    const lifecycle = createSessionLifecycle({
      ending: { mode: "timed", durationMs: 60_000 }
    });
    const session = lifecycle.start(trigger);

    expect(() => lifecycle.remove(session.id)).toThrow("pico session has not ended");
    lifecycle.end(session.id);
    lifecycle.remove(session.id);

    expect(lifecycle.read(session.id)).toBeUndefined();
  });

  it("rejects unsupported trigger kinds", () => {
    const lifecycle = createSessionLifecycle({
      ending: { mode: "timed", durationMs: 60_000 }
    });

    expect(() =>
      lifecycle.start({
        kind: "camera_person_detected" as "wake_name",
        label: "person",
        source: "camera"
      })
    ).toThrow("pico session start trigger kind is invalid");
  });

  it("does not keep short-lived Pi Agent print-mode processes alive with timers", () => {
    const timers: NodeJS.Timeout[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, timeout) => {
      const timer = originalSetTimeout(handler, timeout);
      timers.push(timer);
      return timer;
    });

    try {
      const lifecycle = createSessionLifecycle({
        ending: { mode: "timed", durationMs: 60_000 }
      });
      lifecycle.start(trigger);

      expect(timers[0]?.hasRef()).toBe(false);
    } finally {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timeoutSpy.mockRestore();
    }
  });

  it("isolates audit failures from state changes and timer callbacks", () => {
    vi.useFakeTimers();

    try {
      const lifecycle = createSessionLifecycle({
        ending: { mode: "timed", durationMs: 1 },
        audit: {
          record: () => {
            throw new Error("audit sink unavailable");
          },
          entries: () => []
        }
      });
      lifecycle.start(trigger);

      expect(() => vi.advanceTimersByTime(1)).not.toThrow();
      expect(lifecycle.read("session-1")?.state).toBe("ended");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects runtime timed endings beyond Node timer bounds", () => {
    expect(() =>
      createSessionLifecycle({
        ending: { mode: "timed", durationMs: 2_147_483_648 }
      })
    ).toThrow("pico session ending durationMs must be a positive integer <= 2147483647");
  });
});
