import type { PicoModule } from "../../orchestrator/contracts.js";

export type ShortTermMemoryRole = "staff" | "assistant" | "system";

export type ShortTermMemoryInput = {
  readonly role: ShortTermMemoryRole;
  readonly content: string;
};

export type ShortTermMemoryEntry = ShortTermMemoryInput & {
  readonly id: string;
};

export type ShortTermMemoryStore = {
  readonly append: (input: ShortTermMemoryInput) => ShortTermMemoryEntry;
  readonly read: () => ShortTermMemoryEntry[];
  readonly clear: () => void;
};

export function createMemoryModule(): PicoModule {
  return {
    metadata: {
      kind: "memory",
      status: "available",
      summary: "Holds short-term interaction continuity without durable child profiling.",
      capabilities: [
        {
          id: "memory.describe_boundary",
          description: "Describe short-term memory boundaries and non-durable behavior."
        }
      ]
    }
  };
}

export function createShortTermMemoryStore(): ShortTermMemoryStore {
  let nextId = 1;
  let entries: ShortTermMemoryEntry[] = [];

  return {
    append(input) {
      const entry = {
        id: `memory-${nextId}`,
        role: requireMemoryRole(input.role),
        content: requireMemoryContent(input.content)
      };

      nextId += 1;
      entries = [...entries, entry];

      return cloneMemoryEntry(entry);
    },
    read() {
      return entries.map(cloneMemoryEntry);
    },
    clear() {
      entries = [];
    }
  };
}

function cloneMemoryEntry(entry: ShortTermMemoryEntry): ShortTermMemoryEntry {
  return Object.freeze({ ...entry });
}

function requireMemoryRole(value: unknown): ShortTermMemoryRole {
  if (value === "staff" || value === "assistant" || value === "system") {
    return value;
  }

  throw new Error("pico short-term memory role is invalid");
}

function requireMemoryContent(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("pico short-term memory content is required");
  }

  const trimmed = value.trim();

  if (trimmed === "") {
    throw new Error("pico short-term memory content is required");
  }

  return trimmed;
}
