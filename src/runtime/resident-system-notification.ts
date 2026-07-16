import { spawn } from "node:child_process";

export function buildMacOsNotificationAppleScript(message: string): string {
  return `display notification "${escapeAppleScriptString(message)}" with title "Pico"`;
}

export function sendMacOsResidentNotification(message: string): void {
  const child = spawn("osascript", ["-e", buildMacOsNotificationAppleScript(message)], {
    stdio: "ignore"
  });
  child.once("error", () => undefined);
}

function escapeAppleScriptString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
