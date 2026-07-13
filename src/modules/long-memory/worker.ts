import type { FacilityMemoryExtractor } from "./extractor.js";
import type { SessionMemoryCutoffInput } from "./index.js";
import type { Mem0MemoryProvider, Mem0SessionAddResult } from "./mem0.js";

export type FacilityMemoryWorker = {
  readonly processCutoff: (
    cutoff: SessionMemoryCutoffInput,
    signal?: AbortSignal
  ) => Promise<Mem0SessionAddResult>;
};

export function createFacilityMemoryWorker(input: {
  readonly extractor: FacilityMemoryExtractor;
  readonly provider: Mem0MemoryProvider;
}): FacilityMemoryWorker {
  return Object.freeze({
    async processCutoff(cutoff, signal) {
      const drafts = await input.extractor.extract(cutoff, signal);

      return input.provider.addFacilityMemories(cutoff, drafts);
    }
  });
}
