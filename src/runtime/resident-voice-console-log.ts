import type { VoiceResidentLogEvent, VoiceResidentLogSink } from "./voice-resident.js";

export type ResidentVoiceConsoleLogOptions = {
  readonly writeStdout?: (line: string) => void;
};

export function createResidentVoiceConsoleLog(
  options: ResidentVoiceConsoleLogOptions = {}
): VoiceResidentLogSink {
  const writeStdout = options.writeStdout ?? ((line) => process.stdout.write(line));

  return {
    record(event) {
      writeStdout(formatResidentVoiceConsoleEvent(event));
    }
  };
}

export function formatResidentVoiceConsoleEvent(event: VoiceResidentLogEvent): string {
  const duration =
    event.kind === "pi_agent_response" ? ` duration_ms=${event.durationMs}` : "";

  return `[pico voice] ${event.occurredAt} ${event.kind} session=${event.sessionId}${duration}\n`;
}
