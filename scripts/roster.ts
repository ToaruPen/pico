import { loadPicoConfigFromEnvironment, type PicoConfig } from "../src/config/index.js";
import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import { createOpenTelemetryAuditExporter } from "../src/modules/audit/otel.js";
import { type RosterCliResult, runRosterCli } from "../src/runtime/roster-cli.js";

try {
  await main();
} catch (caught: unknown) {
  process.stderr.write(`${caught instanceof Error ? caught.message : "roster_failed"}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const result = await runWithConfiguredAudit(loadPicoConfigFromEnvironment().audit.otel);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function runWithConfiguredAudit(otel: PicoConfig["audit"]["otel"]): Promise<RosterCliResult> {
  if (!otel.enabled) {
    return runRosterCli(process.argv.slice(2));
  }
  if (otel.endpoint === undefined) throw new Error("pico audit OTel endpoint is required");
  const audit = createStructuredAuditLog();
  const exporter = createOpenTelemetryAuditExporter({
    endpoint: otel.endpoint,
    serviceName: otel.serviceName ?? "pico",
    ...(otel.timeoutMs === undefined ? {} : { timeoutMs: otel.timeoutMs })
  });
  try {
    const result = await runRosterCli(process.argv.slice(2), { audit });
    for (const event of audit.entries()) await exporter.export(event);
    return result;
  } finally {
    await exporter.shutdown();
  }
}
