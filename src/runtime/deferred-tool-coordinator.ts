export type DeferredToolKind = "camera_scene_description";

export type DeferredToolExecutionResult =
  | {
      readonly status: "completed";
      readonly capturedAt: string;
      readonly summary: string;
    }
  | {
      readonly status: "failed";
      readonly capturedAt?: string;
      readonly summary: string;
    };

export type DeferredToolDeliverableResult = {
  readonly jobId: string;
  readonly kind: DeferredToolKind;
  readonly status: DeferredToolExecutionResult["status"];
  readonly capturedAt: string;
  readonly completedAt: string;
  readonly summary: string;
};

export type DeferredToolEnqueueInput = {
  readonly kind: DeferredToolKind;
  readonly toolCallId: string;
  readonly sessionId: string;
  readonly execute: () => Promise<DeferredToolExecutionResult>;
};

export type DeferredToolEnqueueResult =
  | {
      readonly status: "queued";
      readonly kind: DeferredToolKind;
      readonly jobId: string;
      readonly sessionId: string;
    }
  | {
      readonly status: "rejected";
      readonly kind: DeferredToolKind;
      readonly reason: "resource_in_flight";
    };

export type DeferredToolCoordinator = {
  readonly enqueue: (input: DeferredToolEnqueueInput) => DeferredToolEnqueueResult;
  readonly collectDeliverableResults: (input: {
    readonly sessionId: string;
    readonly activeSessionId: string | undefined;
    readonly now: string;
  }) => readonly DeferredToolDeliverableResult[];
  readonly acknowledgeDelivered: (jobIds: readonly string[]) => void;
  readonly cancelSession: (sessionId: string, reason: DeferredToolCancellationReason) => void;
  readonly waitForIdle: () => Promise<void>;
};

export type DeferredToolCancellationReason = "session_closed" | "shutdown" | "superseded";

type DeferredToolJobState =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "delivered"
  | "suppressed";

type DeferredToolJob = {
  readonly jobId: string;
  readonly kind: DeferredToolKind;
  readonly toolCallId: string;
  readonly sessionId: string;
  readonly requestedAt: string;
  state: DeferredToolJobState;
  completedAt?: string;
  capturedAt?: string;
  resultStatus?: DeferredToolExecutionResult["status"];
  summary?: string;
};

export type DeferredToolCoordinatorOptions = {
  readonly now?: () => string;
  readonly maxResultAgeMs?: number;
};

const defaultMaxResultAgeMs = 30_000;

export function createDeferredToolCoordinator(
  options: DeferredToolCoordinatorOptions = {}
): DeferredToolCoordinator {
  const now = options.now ?? (() => new Date().toISOString());
  const maxResultAgeMs = options.maxResultAgeMs ?? defaultMaxResultAgeMs;
  const jobs = new Map<string, DeferredToolJob>();
  const inFlightResources = new Set<DeferredToolKind>();
  const inFlightOperations = new Set<Promise<void>>();
  let nextJobNumber = 1;

  return {
    enqueue(input) {
      if (inFlightResources.has(input.kind)) {
        return {
          status: "rejected",
          kind: input.kind,
          reason: "resource_in_flight"
        };
      }

      const job: DeferredToolJob = {
        jobId: `deferred-job-${nextJobNumber++}`,
        kind: input.kind,
        toolCallId: input.toolCallId,
        sessionId: input.sessionId,
        requestedAt: now(),
        state: "running"
      };
      jobs.set(job.jobId, job);
      inFlightResources.add(input.kind);

      const operation = runDeferredToolJob(job, input.execute, now).finally(() => {
        inFlightResources.delete(input.kind);
        inFlightOperations.delete(operation);
      });
      inFlightOperations.add(operation);

      return {
        status: "queued",
        kind: input.kind,
        jobId: job.jobId,
        sessionId: job.sessionId
      };
    },
    collectDeliverableResults(input) {
      const deliverable: DeferredToolDeliverableResult[] = [];

      for (const job of jobs.values()) {
        const result = collectDeliverableJob(job, input, maxResultAgeMs);

        if (result !== undefined) {
          deliverable.push(result);
        } else if (job.state === "suppressed") {
          jobs.delete(job.jobId);
        }
      }

      return deliverable;
    },
    acknowledgeDelivered(jobIds) {
      for (const jobId of jobIds) {
        const job = jobs.get(jobId);

        if (job?.state === "completed" || job?.state === "failed") {
          jobs.delete(jobId);
        }
      }
    },
    cancelSession(sessionId) {
      for (const job of [...jobs.values()]) {
        if (
          job.sessionId === sessionId &&
          (job.state === "running" || job.state === "completed" || job.state === "failed")
        ) {
          jobs.delete(job.jobId);
        }
      }
    },
    async waitForIdle() {
      await Promise.all([...inFlightOperations]);
    }
  };
}

function collectDeliverableJob(
  job: DeferredToolJob,
  input: Parameters<DeferredToolCoordinator["collectDeliverableResults"]>[0],
  maxResultAgeMs: number
): DeferredToolDeliverableResult | undefined {
  if (job.sessionId !== input.sessionId || (job.state !== "completed" && job.state !== "failed")) {
    return undefined;
  }

  if (
    input.activeSessionId !== input.sessionId ||
    isExpired(job.completedAt, input.now, maxResultAgeMs) ||
    !hasDeliverablePayload(job)
  ) {
    job.state = "suppressed";

    return undefined;
  }

  return {
    jobId: job.jobId,
    kind: job.kind,
    status: job.resultStatus,
    capturedAt: job.capturedAt,
    completedAt: job.completedAt,
    summary: job.summary
  };
}

function hasDeliverablePayload(job: DeferredToolJob): job is DeferredToolJob & {
  readonly capturedAt: string;
  readonly completedAt: string;
  readonly resultStatus: DeferredToolExecutionResult["status"];
  readonly summary: string;
} {
  return (
    job.capturedAt !== undefined &&
    job.completedAt !== undefined &&
    job.resultStatus !== undefined &&
    job.summary !== undefined
  );
}

async function runDeferredToolJob(
  job: DeferredToolJob,
  execute: () => Promise<DeferredToolExecutionResult>,
  now: () => string
): Promise<void> {
  try {
    const result = await execute();

    if (job.state === "cancelled") {
      return;
    }

    job.completedAt = now();
    job.capturedAt = result.capturedAt ?? job.completedAt;
    job.resultStatus = result.status;
    job.summary = result.summary;
    job.state = result.status === "completed" ? "completed" : "failed";
  } catch (error) {
    if (job.state === "cancelled") {
      return;
    }

    job.completedAt = now();
    job.capturedAt = job.completedAt;
    job.resultStatus = "failed";
    job.summary = error instanceof Error ? error.message : String(error);
    job.state = "failed";
  }
}

function isExpired(completedAt: string | undefined, now: string, maxResultAgeMs: number): boolean {
  if (completedAt === undefined) {
    return true;
  }

  return Date.parse(completedAt) + maxResultAgeMs <= Date.parse(now);
}
