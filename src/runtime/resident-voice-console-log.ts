import type { VoiceResidentConsoleEvent, VoiceResidentConsoleSink } from "./voice-resident.js";

export type ResidentVoiceConsoleLogOptions = {
  readonly maxTextLength?: number;
  readonly writeStdout?: (line: string) => void;
};

const defaultMaxTextLength = 240;

export function createResidentVoiceConsoleLog(
  options: ResidentVoiceConsoleLogOptions = {}
): VoiceResidentConsoleSink {
  const writeStdout = options.writeStdout ?? ((line) => process.stdout.write(line));
  const maxTextLength = options.maxTextLength ?? defaultMaxTextLength;

  return {
    record(event) {
      writeStdout(formatResidentVoiceConsoleEvent(event, maxTextLength));
    }
  };
}

export function formatResidentVoiceConsoleEvent(
  event: VoiceResidentConsoleEvent,
  maxTextLength: number
): string {
  const textBlock = formatTextBlock(truncateText(event.text, maxTextLength));

  if (event.kind === "staff_transcript") {
    return `[pico voice] ${event.occurredAt} input session=${event.sessionId}\n${textBlock}`;
  }

  if (event.kind === "wake_ack_input") {
    return `[pico voice] ${event.occurredAt} wake_ack_input session=${event.sessionId} trigger=${JSON.stringify(event.trigger)}\n${textBlock}`;
  }

  const label = event.kind === "wake_ack_response" ? "wake_ack" : "pi_agent";

  return `[pico voice] ${event.occurredAt} ${label} session=${event.sessionId} duration_ms=${event.durationMs}\n${textBlock}`;
}

function formatTextBlock(value: string): string {
  const lines = value.split(/\r?\n/);

  return `  text:\n${lines.map((line) => `    ${line}`).join("\n")}\n`;
}

function truncateText(value: string, maxLength: number): string {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new Error("resident voice console maxTextLength must be a positive integer");
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}
