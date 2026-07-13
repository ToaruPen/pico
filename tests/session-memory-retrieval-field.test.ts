import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runSessionMemoryRetrievalField,
  sessionMemoryRetrievalFieldExitCode
} from "../scripts/field/session-memory-retrieval.js";
import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import { defineEnabledLongMemoryTestConfig } from "./long-memory-config-fixture.js";

describe("session memory retrieval field harness", () => {
  it("validates cutoff through a separate extension memory search without leaking text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-session-memory-retrieval-field-"));
    const audit = createStructuredAuditLog();

    try {
      const report = await runSessionMemoryRetrievalField(
        enabledConfig(directory),
        { PICO_ENABLE_LIVE_SESSION_MEMORY_RETRIEVAL: "1" },
        {
          databasePath: join(directory, "long-memory.sqlite"),
          createRunId: () => "retrieval-run-1",
          searchQuery: "AUDIT_MUST_NOT_CONTAIN_QUERY",
          createSearchAudit: () => audit,
          createExtractor: () => ({
            extract: (cutoff) =>
              Promise.resolve([
                {
                  title: "Rainy day supplies",
                  body: "AUDIT_MUST_NOT_CONTAIN_QUERY AUDIT_MUST_NOT_CONTAIN_MEMORY_BODY",
                  category: "facility_knowledge",
                  tags: ["AUDIT_MUST_NOT_CONTAIN_QUERY"],
                  sourceEntryIds: cutoff.sourceEntryIds,
                  confidence: 0.9
                }
              ])
          }),
          createAuditExporter: () => ({
            export: () => Promise.resolve(),
            shutdown: () => Promise.resolve()
          })
        }
      );

      expect(report).toMatchObject({
        status: "passed",
        provider: "session+sqlite+pi-extension",
        details: {
          sourceEntryCount: 2,
          workerProcessedCount: 1,
          activeMemoryCount: 1,
          retrievalCount: 1,
          matchingProvenanceCount: 1,
          searchAuditEventCount: 1,
          databasePath: "<injected-database-path>"
        }
      });
      expect(sessionMemoryRetrievalFieldExitCode(report)).toBe(0);
      expect(JSON.stringify(audit.entries())).not.toContain("AUDIT_MUST_NOT_CONTAIN_QUERY");
      expect(JSON.stringify(audit.entries())).not.toContain("AUDIT_MUST_NOT_CONTAIN_MEMORY_BODY");
      expect(JSON.stringify(report)).not.toContain("AUDIT_MUST_NOT_CONTAIN_QUERY");
      expect(JSON.stringify(report)).not.toContain("AUDIT_MUST_NOT_CONTAIN_MEMORY_BODY");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses to run a real extraction without the explicit live gate", async () => {
    const report = await runSessionMemoryRetrievalField(enabledConfig(".pico-local/test"), {});

    expect(report).toEqual({
      status: "skipped",
      provider: "session+sqlite+pi-extension",
      reason: "Set PICO_ENABLE_LIVE_SESSION_MEMORY_RETRIEVAL=1 to run the live field test."
    });
    expect(sessionMemoryRetrievalFieldExitCode(report)).toBe(0);
  });

  it("fails when the separate extension search cannot match automated provenance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pico-session-memory-retrieval-field-"));

    try {
      const report = await runSessionMemoryRetrievalField(
        enabledConfig(directory),
        { PICO_ENABLE_LIVE_SESSION_MEMORY_RETRIEVAL: "1" },
        {
          databasePath: join(directory, "long-memory.sqlite"),
          searchQuery: "no-match-query",
          createExtractor: () => ({
            extract: (cutoff) =>
              Promise.resolve([
                {
                  title: "Rainy day supplies",
                  body: "Prepare craft supplies before arrival.",
                  category: "facility_knowledge",
                  tags: ["rain"],
                  sourceEntryIds: cutoff.sourceEntryIds,
                  confidence: 0.9
                }
              ])
          }),
          createAuditExporter: () => ({
            export: () => Promise.resolve(),
            shutdown: () => Promise.resolve()
          })
        }
      );

      expect(report).toEqual({
        status: "failed",
        provider: "session+sqlite+pi-extension",
        reason: "pico session memory retrieval field requires a matching automated memory"
      });
      expect(sessionMemoryRetrievalFieldExitCode(report)).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function enabledConfig(directory: string) {
  return defineEnabledLongMemoryTestConfig(join(directory, "long-memory.sqlite"), {
    timedSession: true,
    otelAudit: true
  });
}
