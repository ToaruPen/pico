import { loadPicoConfigFromEnvironment, type PicoConfig } from "../src/config/index.js";
import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import { createOpenTelemetryProvider } from "../src/modules/telemetry/index.js";
import { type RosterCliResult, runRosterCli } from "../src/runtime/roster-cli.js";

try {
  await main();
} catch (caught: unknown) {
  process.stderr.write(`${caught instanceof Error ? caught.message : "roster_failed"}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const result = await runWithConfiguredAudit(loadPicoConfigFromEnvironment().telemetry.otel);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function runWithConfiguredAudit(
  otel: PicoConfig["telemetry"]["otel"]
): Promise<RosterCliResult> {
  if (!otel.enabled) {
    return runRosterCli(process.argv.slice(2));
  }
  const audit = createStructuredAuditLog();
  const telemetry = createOpenTelemetryProvider({
    baseUrl: requireTelemetryValue(otel.baseUrl, "baseUrl"),
    serviceName: requireTelemetryValue(otel.serviceName, "serviceName"),
    timeoutMs: requireTelemetryValue(otel.timeoutMs, "timeoutMs"),
    metricExportIntervalMs: requireTelemetryValue(
      otel.metricExportIntervalMs,
      "metricExportIntervalMs"
    ),
    shutdownTimeoutMs: requireTelemetryValue(otel.shutdownTimeoutMs, "shutdownTimeoutMs")
  });
  try {
    const result = await runRosterCli(process.argv.slice(2), { audit });
    for (const event of audit.entries()) telemetry.record(event);
    await telemetry.forceFlush();
    return result;
  } finally {
    await telemetry.shutdown();
  }
}

function requireTelemetryValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`pico telemetry OTel ${name} is required when enabled`);
  }

  return value;
}
