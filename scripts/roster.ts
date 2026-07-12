import { createStructuredAuditLog } from "../src/modules/audit/index.js";
import { runRosterCli } from "../src/runtime/roster-cli.js";

try {
  const result = await runRosterCli(process.argv.slice(2), {
    audit: createStructuredAuditLog()
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (caught: unknown) {
  process.stderr.write(`${caught instanceof Error ? caught.message : "roster_failed"}\n`);
  process.exitCode = 1;
}
