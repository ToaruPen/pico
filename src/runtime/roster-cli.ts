import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import type { StructuredAuditLog } from "../modules/audit/index.js";
import {
  initializeIdentityRegistry,
  type NativeIdentityRegistryOptions,
  type OwnerApprovalAssertion,
  openIdentityRegistry
} from "../modules/identity-registry/index.js";
import { createRosterTemplateWorkbook } from "../modules/identity-registry/workbook.js";

export type RosterCliResult = Readonly<Record<string, unknown>> &
  Readonly<{ ok: true; command: string }>;
export type RosterCliOptions = Readonly<{ audit?: StructuredAuditLog }>;

// eslint-disable-next-line complexity -- This is a flat dispatcher for the documented roster subcommands.
export async function runRosterCli(
  arguments_: readonly string[],
  options: RosterCliOptions = {}
): Promise<RosterCliResult> {
  const [command, ...rest] = arguments_;
  if (command === undefined) throw new Error("roster command is required");
  if (command === "help" || command === "--help") {
    return result("help", { usage: formatRosterCliHelp() });
  }
  if (command === "init") return runInit(rest, options.audit);
  if (command === "template") return runTemplate(rest);
  if (command === "status") {
    const parsed = parseCommand(rest, { database: { type: "string" } });
    return runOpened(
      command,
      optionalString(parsed.database),
      (service) => service.status(),
      options.audit
    );
  }
  if (command === "preview") {
    const parsed = parseCommand(rest, {
      input: { type: "string" },
      database: { type: "string" }
    });
    const input = requireOption(parsed.input, "--input");
    return runOpened(
      command,
      optionalString(parsed.database),
      async (service) => service.previewWorkbook(input),
      options.audit
    );
  }
  if (command === "apply") {
    const parsed = parseMutation(rest, { preview: { type: "string" } });
    const previewId = requireOption(parsed.preview, "--preview");
    return runOpened(
      command,
      optionalString(parsed.database),
      (service) => service.applyPreview(previewId, ownerApproval(parsed.ownerApproved)),
      options.audit
    );
  }
  if (command === "export") {
    const parsed = parseMutation(rest, { output: { type: "string" } });
    const outputPath = requireOption(parsed.output, "--output");
    return runOpened(
      command,
      optionalString(parsed.database),
      async (service) => {
        const buffer = await service.createExportWorkbook(ownerApproval(parsed.ownerApproved));
        await writeExclusive(outputPath, buffer);
        return { outputPath, identityCount: service.status().identityCount };
      },
      options.audit
    );
  }
  if (command === "add-alias" || command === "remove-alias") {
    const parsed = parseMutation(rest, {
      subject: { type: "string" },
      alias: { type: "string" }
    });
    const subject = requireOption(parsed.subject, "--subject");
    const alias = requireOption(parsed.alias, "--alias");
    return runOpened(
      command,
      optionalString(parsed.database),
      (service) => {
        const approval = ownerApproval(parsed.ownerApproved);
        if (command === "add-alias") service.addAlias(subject, alias, approval);
        else service.removeAlias(subject, alias, approval);
        return { subjectRef: subject };
      },
      options.audit
    );
  }
  if (command === "activate" || command === "deactivate") {
    const parsed = parseMutation(rest, { subject: { type: "string" } });
    const subject = requireOption(parsed.subject, "--subject");
    return runOpened(
      command,
      optionalString(parsed.database),
      (service) => {
        const approval = ownerApproval(parsed.ownerApproved);
        if (command === "activate") service.activate(subject, approval);
        else service.deactivate(subject, approval);
        return { subjectRef: subject };
      },
      options.audit
    );
  }
  throw new Error(`unknown roster command: ${command}`);
}

export function formatRosterCliHelp(): string {
  return [
    "Usage:",
    "  pico roster init --owner-approved [--database path]",
    "  pico roster template --output path.xlsx",
    "  pico roster status [--database path]",
    "  pico roster preview --input path.xlsx [--database path]",
    "  pico roster apply --preview id --owner-approved [--database path]",
    "  pico roster export --output path.xlsx --owner-approved [--database path]",
    "  pico roster add-alias --subject id --alias value --owner-approved [--database path]",
    "  pico roster remove-alias --subject id --alias value --owner-approved [--database path]",
    "  pico roster activate --subject id --owner-approved [--database path]",
    "  pico roster deactivate --subject id --owner-approved [--database path]"
  ].join("\n");
}

function runInit(
  arguments_: readonly string[],
  audit: StructuredAuditLog | undefined
): RosterCliResult {
  const parsed = parseMutation(arguments_, {});
  const approval = ownerApproval(parsed.ownerApproved);
  const service = initializeIdentityRegistry(
    nativeOptions(optionalString(parsed.database), audit),
    approval
  );
  try {
    return result("init", service.status());
  } finally {
    service.close();
  }
}

async function runTemplate(arguments_: readonly string[]): Promise<RosterCliResult> {
  const parsed = parseCommand(arguments_, { output: { type: "string" } });
  const outputPath = requireOption(parsed.output, "--output");
  await writeExclusive(outputPath, await createRosterTemplateWorkbook(new Date().toISOString()));
  return result("template", { outputPath });
}

async function runOpened(
  command: string,
  databasePath: string | undefined,
  run: (service: ReturnType<typeof openIdentityRegistry>) => unknown,
  audit: StructuredAuditLog | undefined
): Promise<RosterCliResult> {
  const service = openIdentityRegistry(nativeOptions(databasePath, audit));
  try {
    const value = await run(service);
    return result(command, value);
  } finally {
    service.close();
  }
}

function parseMutation(
  arguments_: readonly string[],
  options: Readonly<Record<string, { type: "string" }>>
): Record<string, string | boolean | undefined> {
  return parseCommand(arguments_, {
    ...options,
    database: { type: "string" },
    "owner-approved": { type: "boolean" }
  });
}

function parseCommand(
  arguments_: readonly string[],
  options: Readonly<Record<string, { type: "string" | "boolean" }>>
): Record<string, string | boolean | undefined> {
  const parsed = parseArgs({
    args: [...arguments_],
    allowPositionals: false,
    strict: true,
    options
  });
  return Object.fromEntries(
    Object.entries(parsed.values).map(([key, value]) => [toCamelCase(key), value])
  );
}

function toCamelCase(value: string): string {
  return value.replace(/-([a-z])/gu, (_match, character: string) => character.toUpperCase());
}

function ownerApproval(value: string | boolean | undefined): OwnerApprovalAssertion {
  if (value !== true) throw new Error("owner_approval_required");
  return Object.freeze({ ownerApproved: true });
}

function requireOption(value: string | boolean | undefined, name: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${name} is required`);
  return value;
}

function optionalString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nativeOptions(
  databasePath: string | undefined,
  audit: StructuredAuditLog | undefined
): NativeIdentityRegistryOptions {
  return {
    ...(databasePath === undefined ? {} : { databasePath }),
    ...(audit === undefined ? {} : { audit })
  };
}

async function writeExclusive(path: string, buffer: Buffer): Promise<void> {
  await writeFile(path, buffer, { flag: "wx", mode: 0o600 });
}

function result(command: string, value: unknown): RosterCliResult {
  const details =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  return Object.freeze({ ...details, ok: true, command });
}
