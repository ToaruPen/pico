import type { StructuredAuditLog } from "../audit/index.js";
import type { AutomatedFacilityMemoryDraft } from "./extractor.js";
import {
  assertNoIndividualChildLongMemoryFields,
  defineSessionMemoryCutoffInput,
  type SessionMemoryCutoffInput
} from "./index.js";

export const facilityMemoryScopeId = "facility:pico";

export type Mem0Message = {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
};

export type Mem0AddRequest = {
  readonly messages: readonly Mem0Message[];
  readonly scopeId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
};

export type Mem0AddResponse = {
  readonly memories: readonly {
    readonly id: string;
    readonly content?: string;
  }[];
};

export type Mem0SearchRequest = {
  readonly query: string;
  readonly scopeId: string;
  readonly limit: number;
};

export type Mem0SearchMemory = {
  readonly id: string;
  readonly content: string;
  readonly score?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type Mem0SearchResponse = {
  readonly memories: readonly Mem0SearchMemory[];
};

export type Mem0Client = {
  readonly add: (request: Mem0AddRequest) => Promise<Mem0AddResponse>;
  readonly search: (request: Mem0SearchRequest) => Promise<Mem0SearchResponse>;
  readonly delete: (memoryId: string) => Promise<void>;
};

export type Mem0MemoryProviderOptions = {
  readonly client: Mem0Client;
  readonly scopeId: string;
  readonly audit?: StructuredAuditLog;
};

export type Mem0SessionAddResult = {
  readonly memoryIds: readonly string[];
  readonly sourceSessionId: string;
};

export type Mem0MemoryProvider = {
  readonly addFacilityMemories: (
    cutoff: SessionMemoryCutoffInput,
    drafts: readonly AutomatedFacilityMemoryDraft[]
  ) => Promise<Mem0SessionAddResult>;
  readonly search: (query: string, limit: number) => Promise<readonly Mem0SearchMemory[]>;
  readonly delete: (memoryId: string) => Promise<void>;
};

type Mem0AuditEventInput = {
  readonly name: string;
  readonly summary: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
};

export function createMem0MemoryProvider(options: Mem0MemoryProviderOptions): Mem0MemoryProvider {
  const scopeId = requireMem0ScopeId(options.scopeId);

  return {
    async addFacilityMemories(cutoff, drafts) {
      const session = defineSessionMemoryCutoffInput(cutoff);
      assertNoIndividualChildLongMemoryFields(drafts);
      const memoryIds: string[] = [];

      for (const draft of drafts) {
        const response = await options.client.add({
          messages: [{ role: "user", content: `${draft.title}\n\n${draft.body}` }],
          scopeId,
          metadata: {
            pico_scope_id: scopeId,
            category: draft.category,
            tags: draft.tags,
            confidence: draft.confidence,
            source_session_id: session.sessionId,
            source_entry_ids: draft.sourceEntryIds,
            cutoff_at: session.cutoffAt,
            requested_by: session.requestedBy,
            policy_version: "session-cutoff-v1"
          }
        });

        memoryIds.push(...response.memories.map((memory) => requireMem0Id(memory.id)));
      }

      const frozenIds = Object.freeze(memoryIds);
      recordMem0AddAudit(options.audit, session, frozenIds);

      return Object.freeze({
        memoryIds: frozenIds,
        sourceSessionId: session.sessionId
      });
    },
    async search(query, limit) {
      const boundedLimit = requireMem0SearchLimit(limit);
      const response = await options.client.search({
        query: requireMem0Query(query),
        scopeId,
        limit: boundedLimit
      });
      const memories = Object.freeze(
        response.memories.slice(0, boundedLimit).map((memory) =>
          Object.freeze({
            id: requireMem0Id(memory.id),
            content: memory.content,
            ...(memory.score === undefined ? {} : { score: memory.score }),
            ...(memory.metadata === undefined ? {} : { metadata: memory.metadata })
          })
        )
      );

      recordMem0SearchAudit(options.audit, memories.length);
      return memories;
    },
    async delete(memoryId) {
      const id = requireMem0Id(memoryId);

      await options.client.delete(id);
      recordMem0DeleteAudit(options.audit, id);
    }
  };
}

function requireMem0ScopeId(value: string): string {
  const scopeId = value.trim();

  if (scopeId === "") {
    throw new Error("pico Mem0 scope id is required");
  }

  return scopeId;
}

function requireMem0Id(value: string): string {
  const id = value.trim();

  if (id === "") {
    throw new Error("pico Mem0 memory id is required");
  }

  return id;
}

function requireMem0Query(value: string): string {
  const query = value.trim();

  if (query === "") {
    throw new Error("pico Mem0 search query is required");
  }

  return query;
}

function requireMem0SearchLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error("pico Mem0 search limit is invalid");
  }

  return value;
}

function recordMem0AddAudit(
  audit: StructuredAuditLog | undefined,
  session: SessionMemoryCutoffInput,
  memoryIds: readonly string[]
): void {
  recordMem0AuditEvent(audit, {
    name: "long_memory.mem0.added",
    summary: "Validated facility memories were stored in the local Mem0 provider.",
    attributes: {
      "pico.memory.provider": "mem0",
      "pico.memory.session_id": session.sessionId,
      "pico.memory.source_entry_count": session.sourceEntryIds.length,
      "pico.memory.created_count": memoryIds.length
    }
  });
}

function recordMem0SearchAudit(audit: StructuredAuditLog | undefined, resultCount: number): void {
  recordMem0AuditEvent(audit, {
    name: "long_memory.mem0.searched",
    summary: "Local Mem0 facility memory was searched.",
    attributes: {
      "pico.memory.provider": "mem0",
      "pico.memory.result_count": resultCount
    }
  });
}

function recordMem0DeleteAudit(audit: StructuredAuditLog | undefined, memoryId: string): void {
  recordMem0AuditEvent(audit, {
    name: "long_memory.mem0.deleted",
    summary: "Local Mem0 facility memory was deleted.",
    attributes: {
      "pico.memory.provider": "mem0",
      "pico.memory.mem0_id": memoryId
    }
  });
}

function recordMem0AuditEvent(
  audit: StructuredAuditLog | undefined,
  input: Mem0AuditEventInput
): void {
  try {
    audit?.record({
      category: "memory_write",
      name: input.name,
      severity: "info",
      occurredAt: new Date().toISOString(),
      summary: input.summary,
      attributes: input.attributes
    });
  } catch {
    // The durable memory operation owns success or failure, not the optional audit sink.
  }
}
