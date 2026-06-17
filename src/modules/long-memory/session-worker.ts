import type { StructuredAuditLog } from "../audit/index.js";
import type {
  SessionMemoryCandidateJob,
  SessionMemoryCandidateStore,
  SessionMemoryCutoffInput
} from "./index.js";

export type SessionMemoryWorkerOptions = {
  readonly store: SessionMemoryCandidateStore;
  readonly audit?: StructuredAuditLog;
  readonly maxQueueDepth?: number;
  readonly recoverProcessingOlderThanMs?: number;
  readonly maxDrainJobs?: number;
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
};

const defaultMaxQueueDepth = 100;
const defaultRecoverProcessingOlderThanMs = 5 * 60 * 1000;
const defaultMaxDrainJobs = 100;
const maxNodeTimeoutMs = 2_147_483_647;

export function createSessionMemoryWorker(
  options: SessionMemoryWorkerOptions
): SessionMemoryWorker {
  const maxQueueDepth = requirePositiveInteger(
    options.maxQueueDepth ?? defaultMaxQueueDepth,
    "pico session memory worker maxQueueDepth"
  );
  const recoverProcessingOlderThanMs = requirePositiveInteger(
    options.recoverProcessingOlderThanMs ?? defaultRecoverProcessingOlderThanMs,
    "pico session memory worker recoverProcessingOlderThanMs"
  );
  const maxDrainJobs = requirePositiveInteger(
    options.maxDrainJobs ?? defaultMaxDrainJobs,
    "pico session memory worker maxDrainJobs"
  );
  const now = options.now ?? (() => new Date().toISOString());

  const recoverStaleProcessingJobs = (): readonly SessionMemoryCandidateJob[] => {
    const recoveredAt = requireIsoTimestamp(now(), "pico session memory worker timestamp");
    const staleBefore = new Date(
      Date.parse(recoveredAt) - recoverProcessingOlderThanMs
    ).toISOString();
    const recovered = options.store.recoverStaleProcessingJobs({
      staleBefore,
      recoveredAt
    });

    if (recovered.length > 0) {
      recordWorkerAudit(options.audit, "long_memory.worker.processing_recovered", recoveredAt, {
        "pico.memory.recovered_count": recovered.length
      });
    }

    return recovered;
  };

  const drainOnce = async (): Promise<SessionMemoryDrainOnceResult> => {
    const recovered = recoverStaleProcessingJobs();
    const processedJob = await options.store.processNextJob();
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
      const activeDepth = options.store.countJobs(["queued", "processing"]);

      if (activeDepth >= maxQueueDepth) {
        const occurredAt = requireIsoTimestamp(now(), "pico session memory worker timestamp");
        recordWorkerAudit(options.audit, "long_memory.worker.backpressure", occurredAt, {
          "pico.memory.queue_depth": activeDepth,
          "pico.memory.max_queue_depth": maxQueueDepth,
          "pico.memory.session_id": cutoff.sessionId
        });
        throw new Error("pico session memory worker queue depth limit reached");
      }

      const job = options.store.enqueueSessionCutoff(cutoff);
      recordWorkerAudit(options.audit, "long_memory.worker.cutoff_enqueued", job.queuedAt, {
        "pico.memory.candidate_job_id": job.id,
        "pico.memory.session_id": job.sessionId,
        "pico.memory.queue_depth": activeDepth + 1
      });

      return job;
    },
    recoverStaleProcessingJobs,
    drainOnce,
    async drainUntilIdle() {
      let processedCount = 0;
      let recoveredCount = 0;

      while (processedCount < maxDrainJobs) {
        const result = await drainOnce();

        recoveredCount += result.recoveredCount;

        if (result.processedJob === undefined) {
          return {
            processedCount,
            recoveredCount,
            idle: options.store.countJobs(["queued", "processing"]) === 0
          };
        }

        processedCount += 1;

        if (options.store.countJobs(["queued", "processing"]) === 0) {
          return {
            processedCount,
            recoveredCount,
            idle: true
          };
        }
      }

      return {
        processedCount,
        recoveredCount,
        idle: options.store.countJobs(["queued", "processing"]) === 0
      };
    }
  };
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > maxNodeTimeoutMs) {
    throw new Error(`${label} must be a positive integer <= ${maxNodeTimeoutMs}`);
  }

  return value;
}

function requireIsoTimestamp(value: string, label: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} is invalid`);
  }

  return value;
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
