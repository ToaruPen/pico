import { readFile } from "node:fs/promises";

import type { PicoModule } from "../../orchestrator/contracts.js";

export type FacilityContext = {
  readonly facility: {
    readonly name: string;
    readonly locale?: string;
  };
  readonly schedules: readonly FacilitySchedule[];
  readonly rules: readonly FacilityRule[];
  readonly rooms: readonly FacilityRoom[];
  readonly notes: readonly FacilityNote[];
};

export type FacilitySchedule = {
  readonly id: string;
  readonly title: string;
  readonly days: readonly string[];
  readonly time?: string;
};

export type FacilityRule = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
};

export type FacilityRoom = {
  readonly id: string;
  readonly name: string;
  readonly notes?: string;
};

export type FacilityNote = {
  readonly id: string;
  readonly text: string;
};

export function createContextModule(): PicoModule {
  return {
    metadata: {
      kind: "context",
      status: "available",
      summary: "Provides structured facility context for schedules, rules, rooms, and notes.",
      capabilities: [
        {
          id: "context.describe_scope",
          description: "Describe the facility context categories pico is allowed to use."
        }
      ]
    }
  };
}

export async function loadFacilityContextFile(path: string): Promise<FacilityContext> {
  const contents = await readFile(path, "utf8");

  try {
    return parseFacilityContext(JSON.parse(contents) as unknown);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("pico facility context")) {
      throw error;
    }

    throw new Error("pico facility context file is malformed", { cause: error });
  }
}

export function parseFacilityContext(value: unknown): FacilityContext {
  const context = requireContextRecord(value);

  rejectIndividualChildFields(context);
  requireKnownKeys(context, ["facility", "schedules", "rules", "rooms", "notes"]);

  return {
    facility: parseFacility(context.facility),
    schedules: parseContextItems(context.schedules, parseSchedule),
    rules: parseContextItems(context.rules, parseRule),
    rooms: parseContextItems(context.rooms, parseRoom),
    notes: parseContextItems(context.notes, parseNote)
  };
}

function parseFacility(value: unknown): FacilityContext["facility"] {
  const facility = requireContextRecord(value);
  requireKnownKeys(facility, ["name", "locale"]);
  const locale = optionalContextString(facility.locale);

  return {
    name: requireContextString(facility.name),
    ...(locale === undefined ? {} : { locale })
  };
}

function parseSchedule(value: unknown): FacilitySchedule {
  const schedule = requireContextRecord(value);
  requireKnownKeys(schedule, ["id", "title", "days", "time"]);
  const time = optionalContextString(schedule.time);

  return {
    id: requireContextString(schedule.id),
    title: requireContextString(schedule.title),
    days: parseStringList(schedule.days),
    ...(time === undefined ? {} : { time })
  };
}

function parseRule(value: unknown): FacilityRule {
  const rule = requireContextRecord(value);
  requireKnownKeys(rule, ["id", "title", "description"]);

  return {
    id: requireContextString(rule.id),
    title: requireContextString(rule.title),
    description: requireContextString(rule.description)
  };
}

function parseRoom(value: unknown): FacilityRoom {
  const room = requireContextRecord(value);
  requireKnownKeys(room, ["id", "name", "notes"]);
  const notes = optionalContextString(room.notes);

  return {
    id: requireContextString(room.id),
    name: requireContextString(room.name),
    ...(notes === undefined ? {} : { notes })
  };
}

function parseNote(value: unknown): FacilityNote {
  const note = requireContextRecord(value);
  requireKnownKeys(note, ["id", "text"]);

  return {
    id: requireContextString(note.id),
    text: requireContextString(note.text)
  };
}

function parseContextItems<T>(value: unknown, parseItem: (item: unknown) => T): readonly T[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error("pico facility context file is malformed");
  }

  return value.map(parseItem);
}

function parseStringList(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error("pico facility context file is malformed");
  }

  return value.map(requireContextString);
}

function rejectIndividualChildFields(context: Record<string, unknown>): void {
  for (const key of Object.keys(context)) {
    if (isIndividualChildField(key)) {
      throw new Error("pico facility context must not contain individual child profile data");
    }
  }
}

function requireKnownKeys(record: Record<string, unknown>, knownKeys: readonly string[]): void {
  const known = new Set(knownKeys);

  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new Error("pico facility context file is malformed");
    }
  }
}

function isIndividualChildField(key: string): boolean {
  const normalized = key.toLowerCase();

  return (
    normalized.includes("childprofile") ||
    normalized.includes("childtracking") ||
    normalized.includes("childscore") ||
    normalized.includes("individualchild") ||
    normalized === "profiles" ||
    normalized === "tracking" ||
    normalized === "scoring"
  );
}

function optionalContextString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requireContextString(value);
}

function requireContextString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("pico facility context file is malformed");
  }

  const trimmed = value.trim();

  if (trimmed === "") {
    throw new Error("pico facility context file is malformed");
  }

  return trimmed;
}

function requireContextRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("pico facility context file is malformed");
  }

  return value as Record<string, unknown>;
}
