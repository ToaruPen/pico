import type { StructuredAuditLog } from "../modules/audit/index.js";
import type { FacilityMemoryExtractor } from "../modules/long-memory/extractor.js";
import {
  openSessionMemoryCandidateStore,
  type SessionMemoryCandidateJob,
  type SessionMemoryCandidateJobErrorCode
} from "../modules/long-memory/index.js";
import {
  createSessionMemoryWorker,
  type SessionMemoryDrainReport,
  type SessionMemoryWorker
} from "../modules/long-memory/session-worker.js";

export type ResidentMemoryDrainWorkerOptions = {
  readonly databasePath: string;
  readonly extractor: FacilityMemoryExtractor;
  readonly audit?: StructuredAuditLog;
  readonly maxQueueDepth?: number;
  readonly recoverProcessingOlderThanMs?: number;
  readonly shutdownGraceMs?: number;
  readonly maxDrainJobs?: number;
  readonly now?: () => string;
  readonly signal?: AbortSignal;
};

export type ResidentMemoryDrainReport = SessionMemoryDrainReport & {
  readonly memoryWrittenCount: number;
  readonly writtenMemoryIds?: readonly number[];
  readonly retryScheduledCount?: number;
  readonly deadLetterCount: number;
  readonly lastErrorCode?: SessionMemoryCandidateJobErrorCode;
};

export type ResidentMemoryDrainWorker = Pick<
  SessionMemoryWorker,
  "enqueueCutoff" | "recoverStaleProcessingJobs" | "drainOnce" | "purgeExpiredDeadLetterPayloads"
> & {
  readonly drainUntilIdle: () => Promise<ResidentMemoryDrainReport>;
  readonly close: () => void;
};

export function createResidentMemoryDrainWorker(
  options: ResidentMemoryDrainWorkerOptions
): ResidentMemoryDrainWorker {
  let activeDrain:
    | {
        readonly promise: Promise<ResidentMemoryDrainReport>;
        readonly writtenMemoryIds: Set<number>;
      }
    | undefined;
  const store = openSessionMemoryCandidateStore(
    options.databasePath,
    defineCandidateStoreOptions(
      options,
      (session) => options.extractor.extract(session, options.signal),
      (records) => {
        for (const record of records) {
          activeDrain?.writtenMemoryIds.add(record.id);
        }
      }
    )
  );
  const worker = createConfiguredSessionMemoryWorker(store, options);
  const maxDrainJobs = options.maxDrainJobs ?? 100;
  let closed = false;

  return {
    enqueueCutoff: worker.enqueueCutoff,
    recoverStaleProcessingJobs: worker.recoverStaleProcessingJobs,
    drainOnce: worker.drainOnce,
    purgeExpiredDeadLetterPayloads: worker.purgeExpiredDeadLetterPayloads,
    drainUntilIdle() {
      if (activeDrain !== undefined) {
        return activeDrain.promise;
      }

      const writtenMemoryIds = new Set<number>();
      const beforeDeadLetters = store.countJobs(["dead_letter"]);
      const beforeRetryJobs = countRetryScheduledJobs();
      let processedCount = 0;
      let attemptedCount = 0;
      let recoveredCount = 0;
      let lastErrorCode: SessionMemoryCandidateJobErrorCode | undefined;

      const drainJobs = async (): Promise<ResidentMemoryDrainReport> => {
        while (attemptedCount < maxDrainJobs) {
          const attemptsBefore = new Map(
            store.listJobs().map((job) => [job.id, job.attemptCount] as const)
          );

          try {
            const result = await worker.drainOnce();

            recoveredCount += result.recoveredCount;

            if (result.processedJob === undefined) {
              return createReport(processedCount, recoveredCount, lastErrorCode);
            }

            processedCount += 1;
            attemptedCount += 1;

            if (store.countJobs(["queued", "processing"]) === 0) {
              return createReport(processedCount, recoveredCount, lastErrorCode);
            }
          } catch (error) {
            const transitionedJob = findLastTransitionedJob(store.listJobs(), attemptsBefore);

            if (transitionedJob?.lastErrorCode === undefined) {
              throw error;
            }

            lastErrorCode = transitionedJob.lastErrorCode;
            attemptedCount += 1;
          }
        }

        return createReport(processedCount, recoveredCount, lastErrorCode);
      };

      const drain = drainJobs();
      const drainState = { promise: drain, writtenMemoryIds };
      activeDrain = drainState;
      const clearActiveDrain = (): void => {
        if (activeDrain === drainState) {
          activeDrain = undefined;
        }
      };
      void drain.then(clearActiveDrain, clearActiveDrain);

      return drain;

      function createReport(
        processed: number,
        recovered: number,
        lastErrorCode?: SessionMemoryCandidateJobErrorCode
      ): ResidentMemoryDrainReport {
        const retryScheduledCount = Math.max(0, countRetryScheduledJobs() - beforeRetryJobs);
        const writtenIds = [...writtenMemoryIds];
        const report = {
          processedCount: processed,
          recoveredCount: recovered,
          idle: store.countJobs(["queued", "processing"]) === 0,
          memoryWrittenCount: writtenIds.length,
          deadLetterCount: store.countJobs(["dead_letter"]) - beforeDeadLetters
        };

        return {
          ...report,
          ...(writtenIds.length === 0 ? {} : { writtenMemoryIds: Object.freeze(writtenIds) }),
          ...(retryScheduledCount === 0 ? {} : { retryScheduledCount }),
          ...(lastErrorCode === undefined ? {} : { lastErrorCode })
        };
      }

      function countRetryScheduledJobs(): number {
        return store
          .listJobs()
          .filter((job) => job.status === "queued" && job.lastErrorCode !== undefined).length;
      }
    },
    close() {
      if (closed) {
        return;
      }

      closed = true;
      store.close();
    }
  };
}

function findLastTransitionedJob(
  jobs: readonly SessionMemoryCandidateJob[],
  attemptsBefore: ReadonlyMap<number, number>
): SessionMemoryCandidateJob | undefined {
  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    const job = jobs[index];

    if (
      job !== undefined &&
      job.lastErrorCode !== undefined &&
      job.attemptCount !== (attemptsBefore.get(job.id) ?? 0)
    ) {
      return job;
    }
  }

  return undefined;
}

function defineCandidateStoreOptions(
  options: ResidentMemoryDrainWorkerOptions,
  processAutomatedSession: NonNullable<
    Parameters<typeof openSessionMemoryCandidateStore>[1]["processAutomatedSession"]
  >,
  onAutomatedMemoriesWritten: NonNullable<
    Parameters<typeof openSessionMemoryCandidateStore>[1]["onAutomatedMemoriesWritten"]
  >
): Parameters<typeof openSessionMemoryCandidateStore>[1] {
  return {
    processAutomatedSession,
    onAutomatedMemoriesWritten,
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    ...(options.now === undefined ? {} : { now: options.now })
  };
}

function createConfiguredSessionMemoryWorker(
  store: ReturnType<typeof openSessionMemoryCandidateStore>,
  options: ResidentMemoryDrainWorkerOptions
): SessionMemoryWorker {
  return createSessionMemoryWorker({
    store,
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    ...(options.maxQueueDepth === undefined ? {} : { maxQueueDepth: options.maxQueueDepth }),
    ...(options.recoverProcessingOlderThanMs === undefined
      ? {}
      : { recoverProcessingOlderThanMs: options.recoverProcessingOlderThanMs }),
    ...(options.shutdownGraceMs === undefined ? {} : { shutdownGraceMs: options.shutdownGraceMs }),
    ...(options.maxDrainJobs === undefined ? {} : { maxDrainJobs: options.maxDrainJobs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
}
