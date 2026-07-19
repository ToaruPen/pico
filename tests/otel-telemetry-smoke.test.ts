import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { runOtelTelemetrySmoke } from "../scripts/smoke/otel-telemetry.js";
import type { PicoConfig } from "../src/config/index.js";
import type { AuditEvent } from "../src/modules/audit/index.js";
import type { PicoTelemetry } from "../src/modules/telemetry/index.js";

describe("OTel telemetry smoke", () => {
  it("exports one metadata-only voice stage and reports signal health", async () => {
    const records: AuditEvent[] = [];
    let flushes = 0;
    let shutdowns = 0;
    const telemetry: PicoTelemetry = {
      record: (event) => records.push(event),
      forceFlush: () => {
        flushes += 1;
        return Promise.resolve();
      },
      shutdown: () => {
        shutdowns += 1;
        return Promise.resolve();
      },
      health: () => ({
        logs: { consecutiveFailures: 0, lastSuccessAt: "2026-07-19T02:00:00.000Z" },
        metrics: { consecutiveFailures: 0, lastSuccessAt: "2026-07-19T02:00:00.000Z" }
      })
    };

    const report = await runOtelTelemetrySmoke(enabledConfig(), () => telemetry);

    expect(report).toMatchObject({ status: "passed", eventCount: 1 });
    expect(records[0]).toMatchObject({
      name: "voice.runtime.stage",
      attributes: {
        "pico.voice.stage": "speech_gate",
        "pico.voice.stage_status": "ok"
      }
    });
    expect(JSON.stringify(records)).not.toContain("transcript");
    expect(flushes).toBe(1);
    expect(shutdowns).toBe(1);
  });

  it("ships a loopback-only Collector example and repository commands", () => {
    const collector = readFileSync("config/otel-collector.example.yaml", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as unknown;
    const justfile = readFileSync("Justfile", "utf8");

    expect(collector).toContain("endpoint: 127.0.0.1:4318");
    expect(collector).toContain("endpoint: 127.0.0.1:9464");
    expect(collector).toContain("memory_limiter");
    expect(collector).toContain("batch");
    expect(readPackageScript(packageJson, "smoke:otel-telemetry")).toBe(
      "jiti scripts/smoke/otel-telemetry.ts"
    );
    expect(justfile).toContain("smoke-otel-telemetry:");
  });
});

function enabledConfig(): PicoConfig {
  return {
    telemetry: {
      otel: {
        enabled: true,
        baseUrl: "http://127.0.0.1:4318",
        serviceName: "pico-test",
        timeoutMs: 100,
        metricExportIntervalMs: 1_000,
        shutdownTimeoutMs: 100
      }
    }
  } as PicoConfig;
}

function readPackageScript(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null || !("scripts" in value)) {
    return undefined;
  }
  const scripts = value.scripts;
  return typeof scripts === "object" && scripts !== null && name in scripts
    ? scripts[name as keyof typeof scripts]
    : undefined;
}
