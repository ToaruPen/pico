import type { StructuredAuditLog } from "../audit/index.js";
import type {
  SessionMemoryCandidateJob,
  SessionMemoryCandidateQueue,
  SessionMemoryCandidateStore,
  SessionMemoryCutoffInput
} from "./index.js";

export type SessionMemoryWorkerOptions = {
  readonly store: SessionMemoryCandidateStore;
  readonly audit?: StructuredAuditLog;
  readonly maxQueueDepth?: number;
  readonly recoverProcessingOlderThanMs?: number;
  readonly shutdownGraceMs?: number;
  readonly maxDrainJobs?: number;
  readonly now?: () => string;
  readonly signal?: AbortSignal;
};

export type SessionMemoryEnqueueWorkerOptions = {
  readonly queue: SessionMemoryCandidateQueue;
  readonly audit?: StructuredAuditLog;
  readonly maxQueueDepth?: number;
  readonly now?: () => string;
};

export type SessionMemoryDrainOnceResult = {
  readonly recoveredCount: number;
  readonly processedJob: SessionMemoryCandidateJob | undefined;
};

export type SessionMemoryDrainReport = {
  readonly processedCount: number;
  readonly recoveredCount: number;
  readonly idle: boolean;
};

export type SessionMemoryWorker = {
  readonly enqueueCutoff: (cutoff: SessionMemoryCutoffInput) => SessionMemoryCandidateJob;
  readonly recoverStaleProcessingJobs: () => readonly SessionMemoryCandidateJob[];
  readonly drainOnce: () => Promise<SessionMemoryDrainOnceResult>;
  readonly drainUntilIdle: () => Promise<SessionMemoryDrainReport>;
  readonly purgeExpiredDeadLetterPayloads: () => number;
};

export type SessionMemoryEnqueueWorker = Pick<SessionMemoryWorker, "enqueueCutoff">;

type SessionMemoryEnqueueTarget = {
  readonly enqueueSessionCutoff: (input: SessionMemoryCutoffInput) => SessionMemoryCandidateJob;
  readonly countJobs: (statuses: readonly ("queued" | "processing")[]) => number;
};

const defaultMaxQueueDepth = 100;
const defaultMaxDrainJobs = 100;
const defaultShutdownGraceMs = 5_000;
const maxNodeTimeoutMs = 2_147_483_647;
const shutdownGraceExpired = Symbol("shutdownGraceExpired");

export function createSessionMemoryWorker(
  options: SessionMemoryWorkerOptions
): SessionMemoryWorker {
  const maxQueueDepth = requirePositiveInteger(
    options.maxQueueDepth ?? defaultMaxQueueDepth,
    "pico session memory worker maxQueueDepth"
  );
  const recoverProcessingOlderThanMs =
    options.recoverProcessingOlderThanMs === undefined
      ? undefined
      : requirePositiveInteger(
          options.recoverProcessingOlderThanMs,
          "pico session memory worker recoverProcessingOlderThanMs"
        );
  const maxDrainJobs = requirePositiveInteger(
    options.maxDrainJobs ?? defaultMaxDrainJobs,
    "pico session memory worker maxDrainJobs"
  );
  const shutdownGraceMs = requirePositiveInteger(
    options.shutdownGraceMs ?? defaultShutdownGraceMs,
    "pico session memory worker shutdownGraceMs"
  );
  const now = options.now ?? (() => new Date().toISOString());
  const isAborted = (): boolean => options.signal?.aborted === true;

  const recoverStaleProcessingJobs = (): readonly SessionMemoryCandidateJob[] => {
    if (recoverProcessingOlderThanMs === undefined) {
      return [];
    }

    const recoveredAt = requireIsoTimestamp(now(), "pico session memory worker timestamp");
    const staleBefore = new Date(
      Date.parse(recoveredAt) - recoverProcessingOlderThanMs
    ).toISOString();
    const recovered = options.store
      .recoverStaleProcessingJobs({
        staleBefore,
        recoveredAt
      })
      .filter((job) => job.status === "queued");

    if (recovered.length > 0) {
      recordWorkerAudit(options.audit, "long_memory.worker.processing_recovered", recoveredAt, {
        "pico.memory.recovered_count": recovered.length
      });
    }

    return recovered;
  };

  const drainOnce = async (): Promise<SessionMemoryDrainOnceResult> => {
    if (isAborted()) {
      return {
        recoveredCount: 0,
        processedJob: undefined
      };
    }

    const recovered = recoverStaleProcessingJobs();

    if (isAborted()) {
      return {
        recoveredCount: recovered.length,
        processedJob: undefined
      };
    }

    const processingOwnersBefore = new Map(
      options.store
        .listJobs()
        .filter((job) => job.status === "processing")
        .map((job) => [job.id, job.processingStartedAt] as const)
    );
    const processingOperation = options.store.processNextJob();
    const processingJob = options.store
      .listJobs()
      .find(
        (job) =>
          job.status === "processing" &&
          job.processingStartedAt !== processingOwnersBefore.get(job.id)
      );
    const processingResult = await waitForInFlightTransition({
      operation: processingOperation,
      processingJob,
      signal: options.signal,
      shutdownGraceMs,
      invalidateOwnership: options.store.invalidateProcessingOwnership
    });
    const processedJob = processingResult === shutdownGraceExpired ? undefined : processingResult;
    const occurredAt = requireIsoTimestamp(now(), "pico session memory worker timestamp");

    recordWorkerAudit(options.audit, "long_memory.worker.drain_once", occurredAt, {
      "pico.memory.recovered_count": recovered.length,
      "pico.memory.processed_count": processedJob === undefined ? 0 : 1
    });

    return {
      recoveredCount: recovered.length,
      processedJob
    };
  };

  return {
    enqueueCutoff(cutoff) {
      return enqueueWithBackpressure({
        cutoff,
        target: options.store,
        maxQueueDepth,
        audit: options.audit,
        now
      });
    },
    recoverStaleProcessingJobs,
    drainOnce,
    purgeExpiredDeadLetterPayloads() {
      return options.store.purgeExpiredDeadLetterPayloads({
        now: requireIsoTimestamp(now(), "pico session memory worker timestamp")
      });
    },
    async drainUntilIdle() {
      let processedCount = 0;
      let recoveredCount = 0;
      const createDrainReport = (): SessionMemoryDrainReport => ({
        processedCount,
        recoveredCount,
        idle: options.store.countJobs(["queued", "processing"]) === 0
      });

      while (processedCount < maxDrainJobs) {
        if (isAborted()) {
          return createDrainReport();
        }

        const result = await drainOnce();

        recoveredCount += result.recoveredCount;

        if (result.processedJob === undefined) {
          return createDrainReport();
        }

        processedCount += 1;

        if (isAborted()) {
          return createDrainReport();
        }

        if (options.store.countJobs(["queued", "processing"]) === 0) {
          return createDrainReport();
        }
      }

      return createDrainReport();
    }
  };
}

function waitForInFlightTransition<T>(input: {
  readonly operation: Promise<T>;
  readonly processingJob: SessionMemoryCandidateJob | undefined;
  readonly signal: AbortSignal | undefined;
  readonly shutdownGraceMs: number;
  readonly invalidateOwnership: SessionMemoryCandidateStore["invalidateProcessingOwnership"];
}): Promise<T | typeof shutdownGraceExpired> {
  const signal = input.signal;
  const processingJob = input.processingJob;

  if (
    signal === undefined ||
    processingJob === undefined ||
    processingJob.processingStartedAt === undefined
  ) {
    return input.operation;
  }

  const jobId = processingJob.id;
  const processingStartedAt = processingJob.processingStartedAt;

  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout | undefined;
    let graceStarted = false;
    let settled = false;

    const cleanup = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      signal.removeEventListener("abort", startGrace);
    };
    const finish = (result: T | typeof shutdownGraceExpired): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    function startGrace(): void {
      if (graceStarted || settled) {
        return;
      }

      graceStarted = true;
      timeout = setTimeout(() => {
        try {
          input.invalidateOwnership({ jobId, processingStartedAt });
          finish(shutdownGraceExpired);
        } catch (error) {
          fail(error);
        }
      }, input.shutdownGraceMs);
    }

    input.operation.then(finish, fail);
    signal.addEventListener("abort", startGrace, { once: true });

    if (signal.aborted) {
      startGrace();
    }
  });
}

export function createSessionMemoryEnqueueWorker(
  options: SessionMemoryEnqueueWorkerOptions
): SessionMemoryEnqueueWorker {
  const maxQueueDepth = requirePositiveInteger(
    options.maxQueueDepth ?? defaultMaxQueueDepth,
    "pico session memory worker maxQueueDepth"
  );
  const now = options.now ?? (() => new Date().toISOString());

  return {
    enqueueCutoff(cutoff) {
      return enqueueWithBackpressure({
        cutoff,
        target: options.queue,
        maxQueueDepth,
        audit: options.audit,
        now
      });
    }
  };
}

function enqueueWithBackpressure(input: {
  readonly cutoff: SessionMemoryCutoffInput;
  readonly target: SessionMemoryEnqueueTarget;
  readonly maxQueueDepth: number;
  readonly audit: StructuredAuditLog | undefined;
  readonly now: () => string;
}): SessionMemoryCandidateJob {
  const activeDepth = input.target.countJobs(["queued", "processing"]);

  if (activeDepth >= input.maxQueueDepth) {
    const occurredAt = requireIsoTimestamp(input.now(), "pico session memory worker timestamp");
    recordWorkerAudit(input.audit, "long_memory.worker.backpressure", occurredAt, {
      "pico.memory.queue_depth": activeDepth,
      "pico.memory.max_queue_depth": input.maxQueueDepth,
      "pico.memory.session_id": input.cutoff.sessionId
    });
    throw new Error("pico session memory worker queue depth limit reached");
  }

  const job = input.target.enqueueSessionCutoff(input.cutoff);
  recordWorkerAudit(input.audit, "long_memory.worker.cutoff_enqueued", job.queuedAt, {
    "pico.memory.candidate_job_id": job.id,
    "pico.memory.session_id": job.sessionId,
    "pico.memory.queue_depth": activeDepth + 1
  });

  return job;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > maxNodeTimeoutMs) {
    throw new Error(`${label} must be a positive integer <= ${maxNodeTimeoutMs}`);
  }

  return value;
}

function requireIsoTimestamp(value: string, label: string): string {
  const timestampMs = Date.parse(value);

  if (Number.isNaN(timestampMs)) {
    throw new Error(`${label} is invalid`);
  }

  return new Date(timestampMs).toISOString();
}

function recordWorkerAudit(
  audit: StructuredAuditLog | undefined,
  name: string,
  occurredAt: string,
  attributes: Record<string, string | number | boolean>
): void {
  try {
    audit?.record({
      category: "memory_write",
      name,
      severity: "info",
      occurredAt,
      summary: "Session memory worker lifecycle event.",
      attributes
    });
  } catch {
    // Worker progress must not depend on an audit sink.
  }
}
