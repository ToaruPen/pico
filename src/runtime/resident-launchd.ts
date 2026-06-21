import { dirname, join } from "node:path";

export type ResidentLaunchdServiceOptions = {
  readonly repoRoot: string;
  readonly homeDirectory: string;
  readonly configPath: string;
  readonly nodePath: string;
  readonly pathEnvironment: string;
  readonly label?: string;
};

export type ResidentLaunchdService = {
  readonly label: string;
  readonly plistPath: string;
  readonly picoDirectory: string;
  readonly logDirectory: string;
  readonly standardOutputPath: string;
  readonly standardErrorPath: string;
  readonly plist: string;
};

export type ResidentLaunchctlAction =
  | "bootstrap"
  | "bootout"
  | "restart"
  | "start"
  | "status"
  | "stop";

export type ResidentLaunchdOperation =
  | "install"
  | "print-plist"
  | "restart"
  | "start"
  | "status"
  | "stop"
  | "uninstall";

export type ResidentLaunchctlCommandPlan = {
  readonly command: "launchctl";
  readonly args: readonly string[];
};

export type ResidentLaunchdOperationStep =
  | {
      readonly kind: "command";
      readonly command: "launchctl";
      readonly args: readonly string[];
      readonly allowedExitCodes?: readonly number[];
    }
  | {
      readonly kind: "mkdir";
      readonly path: string;
      readonly mode?: number;
    }
  | {
      readonly kind: "output";
      readonly content: string;
    }
  | {
      readonly kind: "removeFile";
      readonly path: string;
    }
  | {
      readonly kind: "writeFile";
      readonly path: string;
      readonly content: string;
    };

const defaultLabel = "dev.toarupen.pico.resident-voice";

export function requireResidentLaunchdPlatform(platform: NodeJS.Platform): void {
  if (platform !== "darwin") {
    throw new Error("resident:voice:launchd is supported only on macOS (darwin)");
  }
}

export function defineResidentLaunchdService(
  options: ResidentLaunchdServiceOptions
): ResidentLaunchdService {
  const label = requireNonEmpty(options.label ?? defaultLabel, "resident launchd label");
  const repoRoot = requireNonEmpty(options.repoRoot, "resident launchd repoRoot");
  const homeDirectory = requireNonEmpty(options.homeDirectory, "resident launchd homeDirectory");
  const configPath = requireNonEmpty(options.configPath, "resident launchd configPath");
  const nodePath = requireNonEmpty(options.nodePath, "resident launchd nodePath");
  const pathEnvironment = requireNonEmpty(
    options.pathEnvironment,
    "resident launchd pathEnvironment"
  );
  const picoDirectory = join(homeDirectory, ".pico");
  const logDirectory = join(picoDirectory, "resident-voice", "normal", "processes");
  const standardOutputPath = join(logDirectory, "resident-voice.out.log");
  const standardErrorPath = join(logDirectory, "resident-voice.err.log");

  const service = {
    label,
    plistPath: join(homeDirectory, "Library", "LaunchAgents", `${label}.plist`),
    picoDirectory,
    logDirectory,
    standardOutputPath,
    standardErrorPath
  };

  return {
    ...service,
    plist: buildResidentLaunchdPlist({
      ...service,
      repoRoot,
      configPath,
      nodePath,
      pathEnvironment
    })
  };
}

export function createResidentLaunchctlCommandPlan(
  service: Pick<ResidentLaunchdService, "label" | "plistPath">,
  action: ResidentLaunchctlAction,
  userId: number
): ResidentLaunchctlCommandPlan {
  const domain = `gui/${requirePositiveInteger(userId, "resident launchd userId")}`;
  const serviceTarget = `${domain}/${service.label}`;

  if (action === "bootstrap") {
    return {
      command: "launchctl",
      args: ["bootstrap", domain, service.plistPath]
    };
  }

  if (action === "restart") {
    return {
      command: "launchctl",
      args: ["kickstart", "-k", serviceTarget]
    };
  }

  if (action === "start") {
    return {
      command: "launchctl",
      args: ["kickstart", serviceTarget]
    };
  }

  return {
    command: "launchctl",
    args: [launchctlVerb(action), serviceTarget]
  };
}

export function createResidentLaunchdOperationPlan(
  service: ResidentLaunchdService,
  operation: ResidentLaunchdOperation,
  userId: number
): readonly ResidentLaunchdOperationStep[] {
  if (operation === "install") {
    return [
      { kind: "mkdir", path: service.picoDirectory, mode: 0o700 },
      { kind: "mkdir", path: service.logDirectory, mode: 0o700 },
      { kind: "mkdir", path: dirname(service.plistPath) },
      { kind: "writeFile", path: service.plistPath, content: service.plist },
      commandStep(createResidentLaunchctlCommandPlan(service, "bootstrap", userId))
    ];
  }

  if (operation === "uninstall") {
    return [
      commandStep(createResidentLaunchctlCommandPlan(service, "bootout", userId), {
        allowedExitCodes: [0, 3]
      }),
      { kind: "removeFile", path: service.plistPath }
    ];
  }

  if (operation === "print-plist") {
    return [{ kind: "output", content: service.plist }];
  }

  return [commandStep(createResidentLaunchctlCommandPlan(service, operation, userId))];
}

function commandStep(
  plan: ResidentLaunchctlCommandPlan,
  options?: { readonly allowedExitCodes?: readonly number[] }
): ResidentLaunchdOperationStep {
  return {
    kind: "command",
    command: plan.command,
    args: plan.args,
    allowedExitCodes: options?.allowedExitCodes ?? [0]
  };
}

function buildResidentLaunchdPlist(input: {
  readonly label: string;
  readonly repoRoot: string;
  readonly configPath: string;
  readonly nodePath: string;
  readonly pathEnvironment: string;
  readonly standardOutputPath: string;
  readonly standardErrorPath: string;
}): string {
  const jitiCliPath = join(input.repoRoot, "node_modules", "jiti", "lib", "jiti-cli.mjs");
  const residentVoiceScriptPath = join(input.repoRoot, "scripts", "resident", "voice.ts");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlist(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapePlist(input.nodePath)}</string>
    <string>${escapePlist(jitiCliPath)}</string>
    <string>${escapePlist(residentVoiceScriptPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapePlist(input.repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PICO_CONFIG_PATH</key>
    <string>${escapePlist(input.configPath)}</string>
    <key>PICO_VOICE_PROBE_STDOUT</key>
    <string>summary</string>
    <key>PICO_RESIDENT_VOICE_LOG_MODE</key>
    <string>normal</string>
    <key>PATH</key>
    <string>${escapePlist(input.pathEnvironment)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapePlist(input.standardOutputPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(input.standardErrorPath)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
}

function launchctlVerb(
  action: Exclude<ResidentLaunchctlAction, "bootstrap" | "restart" | "start">
): string {
  if (action === "bootout" || action === "stop") {
    return "bootout";
  }

  return "print";
}

function escapePlist(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function requireNonEmpty(value: string, label: string): string {
  if (value.trim() === "") {
    throw new Error(`${label} is required`);
  }

  return value;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return value;
}
