import type { PicoModule } from "../../orchestrator/contracts.js";
import type { StructuredAuditLog } from "../audit/index.js";

export type SessionStartTriggerKind =
  | "wake_name"
  | "greeting"
  | "bell"
  | "button_trigger"
  | "line_command"
  | "schedule"
  | "tool_event";

export type SessionState = "active" | "ended";

export type SessionStartTrigger = {
  readonly kind: SessionStartTriggerKind;
  readonly label: string;
  readonly source: string;
};

export type TimedSessionEndingConfig = {
  readonly mode: "timed";
  readonly durationMs: number;
};

export type SessionLifecycleOptions = {
  readonly ending: TimedSessionEndingConfig;
  readonly audit?: StructuredAuditLog;
};

export type SessionRecord = {
  readonly id: string;
  readonly state: SessionState;
  readonly startedAt: string;
  readonly endedAt: string | undefined;
  readonly trigger: SessionStartTrigger;
};

export type SessionLifecycle = {
  readonly start: (trigger: SessionStartTrigger) => SessionRecord;
  readonly read: (id: string) => SessionRecord | undefined;
  readonly refreshActivity: (id: string) => SessionRecord;
  readonly end: (id: string) => SessionRecord;
  readonly remove: (id: string) => void;
};

type ManagedSession = {
  id: string;
  state: SessionState;
  startedAt: string;
  endedAt: string | undefined;
  trigger: SessionStartTrigger;
  timeout: NodeJS.Timeout | undefined;
};

const sessionStartTriggerKinds = new Set<SessionStartTriggerKind>([
  "wake_name",
  "greeting",
  "bell",
  "button_trigger",
  "line_command",
  "schedule",
  "tool_event"
]);
const maxNodeTimeoutMs = 2_147_483_647;

export function createSessionModule(): PicoModule {
  return {
    metadata: {
      kind: "session",
      status: "available",
      summary: "Manages modular interaction session starts and timed session endings.",
      capabilities: [
        {
          id: "session.start",
          description: "Start a pico interaction session from a trusted typed trigger."
        },
        {
          id: "session.end",
          description: "End a pico interaction session explicitly or after inactivity."
        }
      ]
    }
  };
}

export function createSessionLifecycle(options: SessionLifecycleOptions): SessionLifecycle {
  const durationMs = requireTimedDuration(options.ending);
  const sessions = new Map<string, ManagedSession>();
  let nextSessionId = 1;

  return {
    start(trigger) {
      requireNoActiveSession(sessions);
      const startedAt = nowIso();
      const session: ManagedSession = {
        id: `session-${nextSessionId}`,
        state: "active",
        startedAt,
        endedAt: undefined,
        trigger: normalizeTrigger(trigger),
        timeout: undefined
      };
      nextSessionId += 1;
      session.timeout = scheduleSessionTimer(() => {
        endSession(session, options.audit);
      }, durationMs);
      sessions.set(session.id, session);
      recordSessionAudit(options.audit, "session.started", startedAt, session);

      return cloneSession(session);
    },
    read(id) {
      const session = sessions.get(id);

      return session === undefined ? undefined : cloneSession(session);
    },
    refreshActivity(id) {
      const session = requireSession(sessions, id);

      if (session.state !== "active") {
        throw new Error("pico session is not active");
      }

      refreshSessionTimer(session, options.audit, durationMs);

      return cloneSession(session);
    },
    end(id) {
      const session = requireSession(sessions, id);
      endSession(session, options.audit);

      return cloneSession(session);
    },
    remove(id) {
      const session = requireSession(sessions, id);

      if (session.state !== "ended") {
        throw new Error("pico session has not ended");
      }

      if (session.timeout !== undefined) {
        clearTimeout(session.timeout);
        session.timeout = undefined;
      }
      sessions.delete(session.id);
    }
  };
}

function endSession(session: ManagedSession, audit: StructuredAuditLog | undefined): void {
  if (session.state === "ended") {
    return;
  }

  if (session.timeout !== undefined) {
    clearTimeout(session.timeout);
    session.timeout = undefined;
  }

  session.state = "ended";
  session.endedAt = nowIso();
  recordSessionAudit(audit, "session.ended", session.endedAt, session);
}

function refreshSessionTimer(
  session: ManagedSession,
  audit: StructuredAuditLog | undefined,
  durationMs: number
): void {
  if (session.timeout !== undefined) {
    clearTimeout(session.timeout);
  }

  session.timeout = scheduleSessionTimer(() => {
    endSession(session, audit);
  }, durationMs);
}

function scheduleSessionTimer(callback: () => void, durationMs: number): NodeJS.Timeout {
  const timeout = setTimeout(callback, durationMs);
  timeout.unref();

  return timeout;
}

function recordSessionAudit(
  audit: StructuredAuditLog | undefined,
  name: "session.started" | "session.ended",
  occurredAt: string,
  session: ManagedSession
): void {
  try {
    audit?.record({
      category: "session_lifecycle",
      name,
      severity: "info",
      occurredAt,
      summary: "Pico session lifecycle event.",
      attributes: {
        "pico.session.id": session.id,
        "pico.session.trigger_kind": session.trigger.kind
      }
    });
  } catch {
    // Session state changes must remain deterministic even if the audit sink is unavailable.
  }
}

function normalizeTrigger(trigger: SessionStartTrigger): SessionStartTrigger {
  return Object.freeze({
    kind: requireSessionStartTriggerKind(trigger.kind),
    label: requireSessionText(trigger.label, "pico session start trigger label is required"),
    source: requireSessionText(trigger.source, "pico session start trigger source is required")
  });
}

function requireSessionStartTriggerKind(value: unknown): SessionStartTriggerKind {
  if (typeof value === "string" && sessionStartTriggerKinds.has(value as SessionStartTriggerKind)) {
    return value as SessionStartTriggerKind;
  }

  throw new Error("pico session start trigger kind is invalid");
}

function requireTimedDuration(ending: TimedSessionEndingConfig): number {
  if (!Number.isInteger(ending.durationMs) || ending.durationMs < 1) {
    throw new Error("pico session ending durationMs must be a positive integer");
  }

  if (ending.durationMs > maxNodeTimeoutMs) {
    throw new Error(
      `pico session ending durationMs must be a positive integer <= ${maxNodeTimeoutMs}`
    );
  }

  return ending.durationMs;
}

function requireNoActiveSession(sessions: ReadonlyMap<string, ManagedSession>): void {
  for (const session of sessions.values()) {
    if (session.state === "active") {
      throw new Error("pico session is already active");
    }
  }
}

function requireSession(sessions: ReadonlyMap<string, ManagedSession>, id: string): ManagedSession {
  const session = sessions.get(id);

  if (session === undefined) {
    throw new Error("pico session does not exist");
  }

  return session;
}

function requireSessionText(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new Error(message);
  }

  const trimmed = value.trim();

  if (trimmed === "") {
    throw new Error(message);
  }

  return trimmed;
}

function cloneSession(session: ManagedSession): SessionRecord {
  return Object.freeze({
    id: session.id,
    state: session.state,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    trigger: Object.freeze({ ...session.trigger })
  });
}

function nowIso(): string {
  return new Date().toISOString();
}
