import type { StructuredAuditLog } from "../audit/index.js";
import { defineSessionMemoryCutoffInput, type SessionMemoryCutoffInput } from "./index.js";

export type Mem0Message = {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
};

export type Mem0AddRequest = {
  readonly messages: readonly Mem0Message[];
  readonly scopeId: string;
  readonly metadata: {
    readonly source_session_id: string;
    readonly source_entry_ids: readonly string[];
    readonly cutoff_at: string;
    readonly requested_by: string;
  };
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
};

export type Mem0SearchResponse = {
  readonly memories: readonly {
    readonly id: string;
    readonly content: string;
    readonly score?: number;
  }[];
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
  readonly addSessionCutoff: (cutoff: SessionMemoryCutoffInput) => Promise<Mem0SessionAddResult>;
  readonly search: (query: string) => Promise<Mem0SearchResponse["memories"]>;
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
    async addSessionCutoff(cutoff) {
      const session = defineSessionMemoryCutoffInput(cutoff);
      const response = await options.client.add({
        messages: session.entries.map((entry) => ({
          role: toMem0MessageRole(entry.role),
          content: entry.content
        })),
        scopeId,
        metadata: {
          source_session_id: session.sessionId,
          source_entry_ids: session.sourceEntryIds,
          cutoff_at: session.cutoffAt,
          requested_by: session.requestedBy
        }
      });
      const memoryIds = Object.freeze(response.memories.map((memory) => requireMem0Id(memory.id)));

      recordMem0Audit(options.audit, session, memoryIds);

      return Object.freeze({
        memoryIds,
        sourceSessionId: session.sessionId
      });
    },
    async search(query) {
      const response = await options.client.search({
        query: requireMem0Query(query),
        scopeId
      });
      const memories = Object.freeze(
        response.memories.map((memory) =>
          Object.freeze({
            id: requireMem0Id(memory.id),
            content: memory.content,
            ...(memory.score === undefined ? {} : { score: memory.score })
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

function toMem0MessageRole(
  role: SessionMemoryCutoffInput["entries"][number]["role"]
): Mem0Message["role"] {
  return role === "staff" ? "user" : role;
}

function recordMem0Audit(
  audit: StructuredAuditLog | undefined,
  session: SessionMemoryCutoffInput,
  memoryIds: readonly string[]
): void {
  recordMem0AuditEvent(audit, {
    name: "long_memory.mem0.added",
    summary: "Session cutoff was submitted to the local Mem0 memory provider.",
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
    summary: "Local Mem0 memory provider was searched.",
    attributes: {
      "pico.memory.provider": "mem0",
      "pico.memory.result_count": resultCount
    }
  });
}

function recordMem0DeleteAudit(audit: StructuredAuditLog | undefined, memoryId: string): void {
  recordMem0AuditEvent(audit, {
    name: "long_memory.mem0.deleted",
    summary: "Local Mem0 memory was deleted.",
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
    // Memory operations should not fail because the audit sink is unavailable.
  }
}
