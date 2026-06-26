import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadPicoConfigFromEnvironment, type PicoConfig } from "../config/index.js";
import {
  createSessionLifecycle,
  type SessionEntryInput,
  type SessionLifecycle,
  type SessionStartTrigger,
  type SessionStartTriggerKind
} from "../modules/session/index.js";

const picoSessionParameters = Type.Object({
  action: Type.Union([
    Type.Literal("start"),
    Type.Literal("append"),
    Type.Literal("read"),
    Type.Literal("cutoff")
  ]),
  sessionId: Type.Optional(Type.String()),
  triggerKind: Type.Optional(
    Type.Union([
      Type.Literal("wake_name"),
      Type.Literal("greeting"),
      Type.Literal("bell"),
      Type.Literal("button_trigger"),
      Type.Literal("line_command"),
      Type.Literal("schedule"),
      Type.Literal("tool_event")
    ])
  ),
  label: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
  role: Type.Optional(
    Type.Union([Type.Literal("staff"), Type.Literal("assistant"), Type.Literal("system")])
  ),
  content: Type.Optional(Type.String())
});

type PicoSessionToolParameters = {
  readonly action: "start" | "append" | "read" | "cutoff";
  readonly sessionId?: string;
  readonly triggerKind?: SessionStartTriggerKind;
  readonly label?: string;
  readonly source?: string;
  readonly role?: SessionEntryInput["role"];
  readonly content?: string;
};

export type PicoSessionToolOptions = {
  readonly lifecycle?: SessionLifecycle;
  readonly loadConfig?: () => PicoConfig;
  readonly allowCutoff?: boolean;
};

export function createPicoSessionTool(
  options: PicoSessionToolOptions = {}
): ToolDefinition<typeof picoSessionParameters> {
  const lifecycle =
    options.lifecycle ??
    createSessionLifecycle({
      ending: (options.loadConfig?.() ?? loadPicoConfigFromEnvironment()).session.ending
    });

  return {
    name: "pico_session",
    label: "Pico Session",
    description:
      "Manage pico interaction sessions. Start from a trusted trigger, append session entries, read session state, or produce a cutoff after the timed ending.",
    promptSnippet: "Use pico_session to manage pico interaction session lifecycle state.",
    promptGuidelines: [
      "Use pico_session start only when a trusted session trigger is present.",
      "Use pico_session append for staff and assistant utterances that belong to the active session.",
      options.allowCutoff === false
        ? "Do not use pico_session cutoff in resident runtime; the resident process owns memory enqueue and cutoff acknowledgement."
        : "Use pico_session cutoff only after the session has ended."
    ],
    parameters: picoSessionParameters,
    executionMode: "sequential",
    execute(_toolCallId, parameters) {
      return Promise.resolve(executePicoSessionTool(lifecycle, parameters, options));
    }
  };
}

function executePicoSessionTool(
  lifecycle: SessionLifecycle,
  parameters: PicoSessionToolParameters,
  options: PicoSessionToolOptions
): AgentToolResult<Record<string, never>> {
  switch (parameters.action) {
    case "start": {
      return textResult({
        action: parameters.action,
        session: lifecycle.start(requireStartTrigger(parameters))
      });
    }

    case "append": {
      return textResult({
        action: parameters.action,
        entry: lifecycle.appendEntry(requireSessionId(parameters), requireSessionEntry(parameters))
      });
    }

    case "read": {
      return textResult({
        action: parameters.action,
        session: lifecycle.read(requireSessionId(parameters))
      });
    }

    case "cutoff": {
      if (options.allowCutoff === false) {
        throw new Error("pico_session cutoff is disabled for resident runtime");
      }

      const sessionId = requireSessionId(parameters);
      const cutoff = lifecycle.cutoff(sessionId);
      lifecycle.acknowledgeCutoff(sessionId);

      return textResult({
        action: parameters.action,
        cutoff
      });
    }
  }
}

function requireStartTrigger(parameters: PicoSessionToolParameters): SessionStartTrigger {
  return {
    kind: requireTriggerKind(parameters.triggerKind),
    label: requireText(parameters.label, "pico_session start requires label"),
    source: requireText(parameters.source, "pico_session start requires source")
  };
}

function requireSessionEntry(parameters: PicoSessionToolParameters): SessionEntryInput {
  return {
    role: requireEntryRole(parameters.role),
    content: requireText(parameters.content, "pico_session append requires content")
  };
}

function requireSessionId(parameters: PicoSessionToolParameters): string {
  return requireText(parameters.sessionId, `pico_session ${parameters.action} requires sessionId`);
}

function requireTriggerKind(value: SessionStartTriggerKind | undefined): SessionStartTriggerKind {
  if (value === undefined) {
    throw new Error("pico_session start requires triggerKind");
  }

  return value;
}

function requireEntryRole(value: SessionEntryInput["role"] | undefined): SessionEntryInput["role"] {
  if (value === undefined) {
    throw new Error("pico_session append requires role");
  }

  return value;
}

function requireText(value: string | undefined, message: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(message);
  }

  return value.trim();
}

function textResult(value: unknown): AgentToolResult<Record<string, never>> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: {}
  };
}
