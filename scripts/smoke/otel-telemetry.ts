#!/usr/bin/env jiti
import { pathToFileURL } from "node:url";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";
import { createStructuredAuditLog } from "../../src/modules/audit/index.js";
import {
  createOpenTelemetryProvider,
  type OpenTelemetryProviderOptions,
  type PicoTelemetry,
  type TelemetryHealthSnapshot
} from "../../src/modules/telemetry/index.js";

export type OtelTelemetrySmokeReport = {
  readonly status: "passed" | "failed";
  readonly eventCount: 1;
  readonly health: TelemetryHealthSnapshot;
};

export async function runOtelTelemetrySmoke(
  config: PicoConfig,
  createTelemetry: (
    options: OpenTelemetryProviderOptions
  ) => PicoTelemetry = createOpenTelemetryProvider
): Promise<OtelTelemetrySmokeReport> {
  const otel = config.telemetry.otel;
  if (!otel.enabled) {
    throw new Error("pico OTel telemetry smoke requires telemetry.otel.enabled=true");
  }

  const telemetry = createTelemetry({
    baseUrl: requireConfigValue(otel.baseUrl, "baseUrl"),
    serviceName: requireConfigValue(otel.serviceName, "serviceName"),
    timeoutMs: requireConfigValue(otel.timeoutMs, "timeoutMs"),
    metricExportIntervalMs: requireConfigValue(
      otel.metricExportIntervalMs,
      "metricExportIntervalMs"
    ),
    shutdownTimeoutMs: requireConfigValue(otel.shutdownTimeoutMs, "shutdownTimeoutMs")
  });
  const event = createStructuredAuditLog().record({
    category: "transport_event",
    name: "voice.runtime.stage",
    severity: "info",
    occurredAt: new Date().toISOString(),
    summary: "Pico voice runtime stage completed.",
    attributes: {
      "pico.voice.stage": "speech_gate",
      "pico.voice.stage_status": "ok",
      "pico.voice.stage_duration_ms": 0
    }
  });

  try {
    telemetry.record(event);
    await telemetry.forceFlush();
    const health = telemetry.health();
    return {
      status:
        health.logs.consecutiveFailures === 0 && health.metrics.consecutiveFailures === 0
          ? "passed"
          : "failed",
      eventCount: 1,
      health
    };
  } finally {
    await telemetry.shutdown();
  }
}

function requireConfigValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`pico telemetry OTel ${name} is required when enabled`);
  }

  return value;
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  const report = await runOtelTelemetrySmoke(loadPicoConfigFromEnvironment());
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
  process.exitCode = report.status === "passed" ? 0 : 1;
}
