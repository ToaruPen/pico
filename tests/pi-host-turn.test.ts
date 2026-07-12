import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createPiHostTurnClient } from "../src/runtime/pi-host-turn.js";

type CapturedHandler = (event: unknown, context: ExtensionContext) => unknown;

type PiHostHarness = {
  readonly api: {
    readonly on: (event: string, handler: CapturedHandler) => void;
    readonly sendUserMessage: (content: unknown) => void;
  };
  readonly sentMessages: unknown[];
  readonly emit: (event: string, value: unknown, context: ExtensionContext) => Promise<void>;
};

function createPiHostHarness(): PiHostHarness {
  const handlers = new Map<string, CapturedHandler[]>();
  const sentMessages: unknown[] = [];

  return {
    api: {
      on(event, handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      sendUserMessage(content) {
        sentMessages.push(content);
      }
    },
    sentMessages,
    async emit(event, value, context) {
      for (const handler of handlers.get(event) ?? []) {
        await handler(value, context);
      }
    }
  };
}

function createPiContext(options: {
  readonly idle?: boolean;
  readonly abortCalls: string[];
  readonly shutdownCalls?: string[];
}): ExtensionContext {
  return {
    isIdle: () => options.idle ?? true,
    abort: () => {
      options.abortCalls.push("abort");
    },
    shutdown: () => {
      options.shutdownCalls?.push("shutdown");
    }
  } as ExtensionContext;
}

function textDelta(delta: string): unknown {
  return {
    type: "message_update",
    message: {
      role: "assistant",
      content: []
    },
    assistantMessageEvent: {
      type: "text_delta",
      delta
    }
  };
}

async function acceptTurn(
  harness: PiHostHarness,
  context: ExtensionContext,
  prompt: string
): Promise<void> {
  await harness.emit(
    "before_agent_start",
    {
      type: "before_agent_start",
      prompt,
      systemPrompt: "system",
      systemPromptOptions: { cwd: process.cwd() }
    },
    context
  );
  await harness.emit("agent_start", { type: "agent_start" }, context);
}

describe("Pi host resident turn client", () => {
  it("sends literal voice input into the existing Pi session and resolves after settled", async () => {
    const harness = createPiHostHarness();
    const abortCalls: string[] = [];
    const context = createPiContext({ abortCalls });
    const client = createPiHostTurnClient(harness.api as never);

    await harness.emit("session_start", { type: "session_start" }, context);
    const response = client.prompt({
      sessionId: "facility-session-1",
      text: "/status"
    });

    expect(harness.sentMessages).toEqual(["/status"]);

    await acceptTurn(harness, context, "/status");
    await harness.emit("message_update", textDelta("応答"), context);
    await harness.emit("message_update", textDelta("です"), context);
    await harness.emit("agent_settled", { type: "agent_settled" }, context);

    await expect(response).resolves.toEqual({ text: "応答です" });
    expect(abortCalls).toEqual([]);
  });

  it("rejects a second voice turn while the first Pi turn is active", async () => {
    const harness = createPiHostHarness();
    const context = createPiContext({ abortCalls: [] });
    const client = createPiHostTurnClient(harness.api as never);

    await harness.emit("session_start", { type: "session_start" }, context);
    const first = client.prompt({ sessionId: "facility-session-1", text: "一件目" });

    await expect(
      client.prompt({ sessionId: "facility-session-2", text: "二件目" })
    ).rejects.toThrow("Pi host turn is already active");

    await acceptTurn(harness, context, "一件目");
    await harness.emit("agent_settled", { type: "agent_settled" }, context);
    await expect(first).resolves.toEqual({ text: "" });
  });

  it("refuses to inject a voice turn while Pi is not idle", async () => {
    const harness = createPiHostHarness();
    const context = createPiContext({ idle: false, abortCalls: [] });
    const client = createPiHostTurnClient(harness.api as never);

    await harness.emit("session_start", { type: "session_start" }, context);

    await expect(
      client.prompt({ sessionId: "facility-session-1", text: "重ねないで" })
    ).rejects.toThrow("Pi host is not idle");
    expect(harness.sentMessages).toEqual([]);
  });

  it("aborts the active Pi turn once and rejects it after Pi settles", async () => {
    const harness = createPiHostHarness();
    const abortCalls: string[] = [];
    const context = createPiContext({ abortCalls });
    const client = createPiHostTurnClient(harness.api as never);
    const abortController = new AbortController();

    await harness.emit("session_start", { type: "session_start" }, context);
    const response = client.prompt({
      sessionId: "facility-session-1",
      text: "止めて",
      signal: abortController.signal
    });

    await acceptTurn(harness, context, "止めて");

    abortController.abort();
    abortController.abort();

    expect(abortCalls).toEqual(["abort"]);

    await harness.emit("agent_settled", { type: "agent_settled" }, context);
    await expect(response).rejects.toThrow("Pi host turn was aborted");
  });

  it("ignores unrelated Pi events and rejects a voice input that never starts", async () => {
    const harness = createPiHostHarness();
    const shutdownCalls: string[] = [];
    const context = createPiContext({ abortCalls: [], shutdownCalls });
    let expirePreflight: (() => void) | undefined;
    const client = createPiHostTurnClient(harness.api as never, {
      schedulePreflightTimeout: (expire) => {
        expirePreflight = expire;
        return () => {
          expirePreflight = undefined;
        };
      }
    });

    await harness.emit("session_start", { type: "session_start" }, context);
    const response = client.prompt({ sessionId: "facility-session-1", text: "音声入力" });

    await harness.emit(
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "別の入力",
        systemPrompt: "system",
        systemPromptOptions: { cwd: process.cwd() }
      },
      context
    );
    await harness.emit("agent_start", { type: "agent_start" }, context);
    await harness.emit("message_update", textDelta("別turnの応答"), context);
    await harness.emit("agent_settled", { type: "agent_settled" }, context);

    expirePreflight?.();

    await expect(response).rejects.toThrow("Pi host turn preflight failed");
    expect(shutdownCalls).toEqual(["shutdown"]);

    await acceptTurn(harness, context, "音声入力");
    await harness.emit("message_update", textDelta("遅着応答"), context);
    await harness.emit("agent_settled", { type: "agent_settled" }, context);

    await expect(
      client.prompt({ sessionId: "facility-session-2", text: "次の入力" })
    ).rejects.toThrow("Pi host turn client is closed");
  });

  it("rejects an active turn and future turns when the Pi session shuts down", async () => {
    const harness = createPiHostHarness();
    const abortCalls: string[] = [];
    const context = createPiContext({ abortCalls });
    const client = createPiHostTurnClient(harness.api as never);

    await harness.emit("session_start", { type: "session_start" }, context);
    const response = client.prompt({ sessionId: "facility-session-1", text: "処理中" });

    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);

    await expect(response).rejects.toThrow("Pi host turn client is closed");
    expect(abortCalls).toEqual(["abort"]);
    await expect(
      client.prompt({ sessionId: "facility-session-2", text: "終了後" })
    ).rejects.toThrow("Pi host turn client is closed");
  });
});
