import { types } from "node:util";

import type { ResidentVoiceOperatorSink } from "./resident-voice-operator.js";
import type { VoiceRuntimeStage, VoiceStageStatus } from "./voice-stage-probe.js";

export type ResidentVoiceTerminalDisplayOptions = {
  readonly setLines: (lines: readonly string[]) => void;
  readonly maximumHistoryEntries?: number;
  readonly maximumPayloadBytes?: number;
  readonly maximumTextBytes?: number;
};

type PendingTool = {
  readonly toolName: string;
  readonly args: string;
};

type TextBudget = {
  readonly maximumBytes: number;
  readonly parts: string[];
  byteLength: number;
  truncated: boolean;
  replacingUnsafeRun: boolean;
};

type PayloadBudget = {
  nodes: number;
  readonly seen: WeakSet<object>;
};

type PayloadPrimitive =
  | string
  | number
  | boolean
  | bigint
  | undefined
  | symbol
  | ((...arguments_: never[]) => unknown);

type StageTiming = {
  readonly durationMs: number;
  readonly status: VoiceStageStatus;
  readonly trailingSilenceMs?: number;
};

const timingStages = [
  ["stt", "STT"],
  ["pi_time_to_first_text", "Pi初字"],
  ["pi_turn", "Pi"],
  ["tts_time_to_first_chunk", "TTS初音"],
  ["tts_playback", "再生"],
  ["ptt_release_to_playback_start", "PTT→再生"]
] as const satisfies readonly (readonly [VoiceRuntimeStage, string])[];
const defaultMaximumHistoryEntries = 8;
const defaultMaximumPayloadBytes = 2_048;
const defaultMaximumTextBytes = 4_096;
const maximumToolNameBytes = 256;
const maximumPendingTools = 32;
const maximumPayloadDepth = 6;
const maximumPayloadNodes = 128;
const maximumPayloadProperties = 32;
const maximumPayloadArrayItems = 32;
const residentVoiceWidgetKey = "pico-resident-voice";

export function createResidentVoiceTerminalOperator(input: {
  readonly mode: string;
  readonly setWidget: (
    key: string,
    lines: readonly string[],
    options: { readonly placement: "aboveEditor" }
  ) => void;
}): ResidentVoiceOperatorSink | undefined {
  if (input.mode !== "tui") {
    return undefined;
  }

  return createResidentVoiceTerminalDisplay({
    setLines: (lines) => {
      input.setWidget(residentVoiceWidgetKey, lines, { placement: "aboveEditor" });
    }
  });
}

export function createResidentVoiceTerminalDisplay(
  options: ResidentVoiceTerminalDisplayOptions
): ResidentVoiceOperatorSink {
  const maximumHistoryEntries = requireBoundedInteger(
    options.maximumHistoryEntries ?? defaultMaximumHistoryEntries,
    1,
    32,
    "resident voice terminal maximumHistoryEntries"
  );
  const maximumPayloadBytes = requireBoundedInteger(
    options.maximumPayloadBytes ?? defaultMaximumPayloadBytes,
    32,
    64 * 1024,
    "resident voice terminal maximumPayloadBytes"
  );
  const maximumTextBytes = requireBoundedInteger(
    options.maximumTextBytes ?? defaultMaximumTextBytes,
    32,
    64 * 1024,
    "resident voice terminal maximumTextBytes"
  );
  const history: string[] = [];
  const pendingTools = new Map<string, PendingTool>();
  const timings = new Map<VoiceRuntimeStage, StageTiming>();
  let assistantStopReason: string | undefined;

  const render = (): void => {
    const timingLine = formatTimingLine(timings);
    const pendingAssistantLine =
      assistantStopReason === undefined ? [] : [`Pico: [stop=${assistantStopReason}]`];
    const lines = [
      "Pico voice",
      ...history,
      ...pendingAssistantLine,
      ...(timingLine === undefined ? [] : [timingLine])
    ];

    try {
      options.setLines(lines);
    } catch {
      // A TUI refresh failure must not alter the resident voice turn.
    }
  };
  const appendHistory = (line: string): void => {
    history.push(line);
    if (history.length > maximumHistoryEntries) {
      history.splice(0, history.length - maximumHistoryEntries);
    }
  };

  return {
    // The discriminated union keeps every operator event transition visible in one place.
    // eslint-disable-next-line complexity
    record(event) {
      switch (event.kind) {
        case "turn_started":
          timings.clear();
          pendingTools.clear();
          assistantStopReason = undefined;
          break;
        case "staff_transcript":
          appendHistory(`Staff: ${formatOperatorText(event.text, maximumTextBytes)}`);
          break;
        case "pi_response": {
          const stopReason = assistantStopReason;
          assistantStopReason = undefined;
          appendHistory(
            `Pico: ${formatOperatorText(event.text, maximumTextBytes)}${
              stopReason === undefined ? "" : ` [stop=${stopReason}]`
            }`
          );
          break;
        }
        case "assistant_settled":
          assistantStopReason = formatOperatorText(event.stopReason, 128);
          break;
        case "tool_execution_start": {
          evictOldestPendingTool(pendingTools);
          pendingTools.set(event.toolCallId, {
            toolName: formatOperatorText(event.toolName, maximumToolNameBytes).trim(),
            args: formatPayload(event.args, maximumPayloadBytes)
          });
          break;
        }
        case "tool_execution_end": {
          const pending = pendingTools.get(event.toolCallId);
          pendingTools.delete(event.toolCallId);
          const name = formatOperatorText(
            pending?.toolName ?? event.toolName,
            maximumToolNameBytes
          ).trim();
          const arguments_ = pending?.args ?? "undefined";
          const result =
            "result" in event ? ` ${formatPayload(event.result, maximumPayloadBytes)}` : "";
          const status = event.errorCode === "cancelled" ? "cancelled" : event.status;
          const errorCode = event.errorCode === undefined ? "" : ` [${event.errorCode}]`;
          appendHistory(
            `Tool: ${name}(${arguments_}) -> ${status} ${formatDuration(
              event.durationMs
            )}${errorCode}${result}`
          );
          break;
        }
        case "stage":
          timings.set(event.stage, {
            durationMs: event.durationMs,
            status: event.status,
            ...(typeof event.attributes["pico.voice.trailing_silence_ms"] === "number"
              ? {
                  trailingSilenceMs: event.attributes["pico.voice.trailing_silence_ms"]
                }
              : {})
          });
          break;
      }

      render();
    }
  };
}

function formatTimingLine(
  timings: ReadonlyMap<VoiceRuntimeStage, StageTiming>
): string | undefined {
  const values: string[] = [];

  for (const [stage, label] of timingStages) {
    const timing = timings.get(stage);
    if (timing === undefined) {
      continue;
    }
    const status = timing.status === "ok" ? "" : ` [${timing.status}]`;
    values.push(`${label} ${formatDuration(timing.durationMs)}${status}`);

    if (stage === "tts_playback" && timing.trailingSilenceMs !== undefined) {
      values.push(`合成末尾無音 ${formatDuration(timing.trailingSilenceMs)}`);
    }
  }

  return values.length === 0 ? undefined : `時間: ${values.join(" | ")}`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${String(Math.round(durationMs))} ms`;
  }

  return `${(Math.round(durationMs / 10) / 100).toFixed(2)} s`;
}

function formatPayload(value: unknown, maximumBytes: number): string {
  const output = createTextBudget(maximumBytes);
  writePayloadValue(value, output, { nodes: 0, seen: new WeakSet() }, 0);
  return finishTextBudget(output);
}

function formatOperatorText(value: string, maximumBytes: number): string {
  const output = createTextBudget(maximumBytes);
  appendTerminalText(output, value);
  return finishTextBudget(output);
}

function writePayloadValue(
  value: unknown,
  output: TextBudget,
  budget: PayloadBudget,
  depth: number
): void {
  if (output.truncated) return;
  if (value === null) {
    appendTerminalText(output, "null");
    return;
  }
  if (typeof value === "object") {
    writePayloadObject(value, output, budget, depth);
    return;
  }

  writePayloadPrimitive(value as PayloadPrimitive, output);
}

function writePayloadPrimitive(value: PayloadPrimitive, output: TextBudget): void {
  if (typeof value === "string") {
    writeQuotedString(value, output);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    appendTerminalText(output, String(value));
    return;
  }
  if (value === undefined) {
    appendTerminalText(output, "undefined");
    return;
  }
  appendTerminalText(output, typeof value === "symbol" ? "[symbol]" : "[function]");
}

function writePayloadObject(
  value: object,
  output: TextBudget,
  budget: PayloadBudget,
  depth: number
): void {
  if (types.isProxy(value)) {
    appendTerminalText(output, "[Proxy]");
    return;
  }
  if (budget.seen.has(value)) {
    appendTerminalText(output, "[Circular]");
    return;
  }
  if (depth >= maximumPayloadDepth || budget.nodes >= maximumPayloadNodes) {
    markTextTruncated(output);
    return;
  }

  budget.nodes += 1;
  budget.seen.add(value);
  try {
    if (Array.isArray(value)) {
      writePayloadArray(value, output, budget, depth);
      return;
    }
    if (isPlainPayloadObject(value)) {
      writePayloadRecord(value, output, budget, depth);
      return;
    }
    if (value instanceof Uint8Array) {
      appendTerminalText(output, "[Uint8Array]");
      return;
    }
    appendTerminalText(output, "[object]");
  } finally {
    budget.seen.delete(value);
  }
}

function writePayloadArray(
  value: readonly unknown[],
  output: TextBudget,
  budget: PayloadBudget,
  depth: number
): void {
  appendTerminalText(output, "[");
  const itemCount = Math.min(value.length, maximumPayloadArrayItems);
  for (let index = 0; index < itemCount && !output.truncated; index += 1) {
    if (index > 0) appendTerminalText(output, ",");
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    writePayloadDescriptor(descriptor, output, budget, depth + 1);
  }
  if (value.length > itemCount) markTextTruncated(output);
  if (!output.truncated) appendTerminalText(output, "]");
}

function writePayloadRecord(
  value: Readonly<Record<string, unknown>>,
  output: TextBudget,
  budget: PayloadBudget,
  depth: number
): void {
  appendTerminalText(output, "{");
  let propertyCount = 0;

  for (const property in value) {
    const descriptor = readEnumerableOwnDescriptor(value, property);
    if (descriptor === undefined) continue;
    if (propertyCount >= maximumPayloadProperties) {
      markTextTruncated(output);
      break;
    }
    if (propertyCount > 0) appendTerminalText(output, ",");
    writeQuotedString(property, output);
    appendTerminalText(output, ":");
    writePayloadDescriptor(descriptor, output, budget, depth + 1);
    propertyCount += 1;
    if (output.truncated) break;
  }

  if (!output.truncated) appendTerminalText(output, "}");
}

function readEnumerableOwnDescriptor(
  value: Readonly<Record<string, unknown>>,
  property: string
): PropertyDescriptor | undefined {
  if (!Object.hasOwn(value, property)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  return descriptor?.enumerable === true ? descriptor : undefined;
}

function writePayloadDescriptor(
  descriptor: PropertyDescriptor | undefined,
  output: TextBudget,
  budget: PayloadBudget,
  depth: number
): void {
  if (descriptor === undefined) {
    appendTerminalText(output, "undefined");
    return;
  }
  if (!("value" in descriptor)) {
    appendTerminalText(output, "[accessor]");
    return;
  }
  writePayloadValue(descriptor.value, output, budget, depth);
}

function isPlainPayloadObject(value: object): value is Readonly<Record<string, unknown>> {
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function writeQuotedString(value: string, output: TextBudget): void {
  appendTerminalText(output, '"');
  for (const character of value) {
    if (output.truncated) return;
    if (character === '"' || character === "\\") {
      appendTerminalText(output, `\\${character}`);
    } else {
      appendTerminalText(output, character);
    }
  }
  appendTerminalText(output, '"');
}

function createTextBudget(maximumBytes: number): TextBudget {
  return {
    maximumBytes,
    parts: [],
    byteLength: 0,
    truncated: false,
    replacingUnsafeRun: false
  };
}

function appendTerminalText(output: TextBudget, value: string): void {
  for (const character of value) {
    if (output.truncated) return;
    const codePoint = character.codePointAt(0) ?? 0;
    if (isUnsafeTerminalCodePoint(codePoint)) {
      if (!output.replacingUnsafeRun) appendTerminalCharacter(output, " ");
      output.replacingUnsafeRun = true;
      continue;
    }
    output.replacingUnsafeRun = false;
    appendTerminalCharacter(output, character);
  }
}

function appendTerminalCharacter(output: TextBudget, character: string): void {
  const characterBytes = Buffer.byteLength(character, "utf8");
  if (output.byteLength + characterBytes > output.maximumBytes) {
    markTextTruncated(output);
    return;
  }
  output.parts.push(character);
  output.byteLength += characterBytes;
}

function markTextTruncated(output: TextBudget): void {
  output.truncated = true;
}

function finishTextBudget(output: TextBudget): string {
  if (!output.truncated) return output.parts.join("");
  const ellipsis = "…";
  const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8");

  while (output.byteLength + ellipsisBytes > output.maximumBytes) {
    const removed = output.parts.pop();
    if (removed === undefined) break;
    output.byteLength -= Buffer.byteLength(removed, "utf8");
  }
  return `${output.parts.join("")}${ellipsis}`;
}

function evictOldestPendingTool(pendingTools: Map<string, PendingTool>): void {
  if (pendingTools.size < maximumPendingTools) return;
  const oldest = pendingTools.keys().next();
  if (!oldest.done) pendingTools.delete(oldest.value);
}

function isUnsafeTerminalCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  );
}

function requireBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${String(minimum)} to ${String(maximum)}`);
  }

  return value;
}
