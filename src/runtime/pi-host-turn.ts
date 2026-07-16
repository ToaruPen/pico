import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { PiAgentTurnClient, PiVoiceTurnProgress } from "./voice-resident.js";

export type PiHostTurnClient = PiAgentTurnClient & {
  readonly close: () => void;
};

export type PiHostTurnClientOptions = {
  readonly preflightTimeoutMs?: number;
  readonly schedulePreflightTimeout?: (expire: () => void, timeoutMs: number) => () => void;
};

type ActiveTurn = {
  readonly preToolChunks: string[];
  readonly finalChunks: string[];
  readonly expectedPrompt: string;
  readonly beforeFirstTool: ((preface: string) => Promise<void>) | undefined;
  readonly onProgress: ((event: PiVoiceTurnProgress) => void) | undefined;
  readonly resolve: (value: { readonly text: string }) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal | undefined;
  abortRequested: boolean;
  promptCandidate: boolean;
  started: boolean;
  toolObserved: boolean;
  gatePromise: Promise<void> | undefined;
  gateError: Error | undefined;
  cancelPreflight: () => void;
};

const missingPrefaceAcknowledgement = "わかった。今から始めるね。";

export function createPiHostTurnClient(
  pi: Pick<ExtensionAPI, "on" | "sendUserMessage">,
  options: PiHostTurnClientOptions = {}
): PiHostTurnClient {
  const schedulePreflightTimeout =
    options.schedulePreflightTimeout ?? defaultSchedulePreflightTimeout;
  const preflightTimeoutMs = options.preflightTimeoutMs ?? 30_000;
  let context: ExtensionContext | undefined;
  let activeTurn: ActiveTurn | undefined;
  let closed = false;

  const removeAbortListener = (turn: ActiveTurn): void => {
    turn.signal?.removeEventListener("abort", abortActiveTurn);
  };
  const finishActiveTurn = (finish: (turn: ActiveTurn) => void): void => {
    const turn = activeTurn;

    if (turn === undefined) {
      return;
    }

    activeTurn = undefined;
    turn.cancelPreflight();
    removeAbortListener(turn);
    finish(turn);
  };
  const abortActiveTurn = (): void => {
    if (activeTurn === undefined || activeTurn.abortRequested) {
      return;
    }

    activeTurn.abortRequested = true;
    context?.abort();
  };
  const close = (): void => {
    if (closed) {
      return;
    }

    closed = true;
    abortActiveTurn();
    finishActiveTurn((turn) => {
      turn.reject(new Error("Pi host turn client is closed"));
    });
    context = undefined;
  };

  pi.on("session_start", (_event, currentContext) => {
    if (!closed) {
      context = currentContext;
    }
  });
  pi.on("before_agent_start", (event) => {
    if (activeTurn !== undefined && !activeTurn.started) {
      activeTurn.promptCandidate = event.prompt === activeTurn.expectedPrompt;
    }
  });
  pi.on("agent_start", () => {
    if (activeTurn?.promptCandidate) {
      activeTurn.started = true;
      activeTurn.cancelPreflight();

      if (!activeTurn.abortRequested) {
        activeTurn.onProgress?.({ phase: "thinking" });
      }
    }
  });
  pi.on("message_update", (event) => {
    const delta = readTextDelta(event);

    if (delta !== undefined && activeTurn?.started && !activeTurn.abortRequested) {
      (activeTurn.toolObserved ? activeTurn.finalChunks : activeTurn.preToolChunks).push(delta);
    }
  });
  pi.on("tool_execution_start", (event) => {
    if (activeTurn?.started && !activeTurn.abortRequested) {
      activeTurn.onProgress?.({ phase: "preparing", toolName: event.toolName });
    }
  });
  pi.on("tool_call", async (event) => {
    const turn = activeTurn;

    if (turn === undefined || !turn.started) {
      return;
    }

    if (isAbortRequested(turn)) {
      return { block: true, reason: "Pico voice turn was aborted" };
    }

    turn.toolObserved = true;
    turn.gatePromise ??= runToolStartGate(turn, abortActiveTurn);

    try {
      await turn.gatePromise;
    } catch {
      return { block: true, reason: "Pico pre-action acknowledgement failed" };
    }

    if (turn.abortRequested) {
      return { block: true, reason: "Pico voice turn was aborted" };
    }

    turn.onProgress?.({ phase: "working", toolName: event.toolName });

    return undefined;
  });
  pi.on("tool_execution_end", (event) => {
    if (activeTurn?.started && !activeTurn.abortRequested) {
      activeTurn.onProgress?.({
        phase: "tool_finished",
        toolName: event.toolName,
        succeeded: !event.isError
      });
    }
  });
  pi.on("agent_settled", () => {
    if (!activeTurn?.started) {
      return;
    }

    finishActiveTurn((turn) => {
      if (turn.abortRequested) {
        turn.reject(turn.gateError ?? new Error("Pi host turn was aborted"));
        return;
      }

      turn.onProgress?.({ phase: "finalizing" });
      turn.resolve({
        text: (turn.toolObserved ? turn.finalChunks : turn.preToolChunks).join("")
      });
    });
  });
  pi.on("session_shutdown", close);

  return {
    prompt(input) {
      if (closed) {
        return Promise.reject(new Error("Pi host turn client is closed"));
      }

      if (context === undefined) {
        return Promise.reject(new Error("Pi host session has not started"));
      }

      if (!context.isIdle()) {
        return Promise.reject(new Error("Pi host is not idle"));
      }

      if (activeTurn !== undefined) {
        return Promise.reject(new Error("Pi host turn is already active"));
      }

      if (input.signal?.aborted) {
        return Promise.reject(new Error("Pi host turn was aborted"));
      }

      return new Promise((resolve, reject) => {
        const turn: ActiveTurn = {
          preToolChunks: [],
          finalChunks: [],
          expectedPrompt: input.text,
          beforeFirstTool: input.beforeFirstTool,
          onProgress: input.onProgress,
          resolve,
          reject,
          signal: input.signal,
          abortRequested: false,
          promptCandidate: false,
          started: false,
          toolObserved: false,
          gatePromise: undefined,
          gateError: undefined,
          cancelPreflight: () => undefined
        };
        activeTurn = turn;
        turn.cancelPreflight = schedulePreflightTimeout(() => {
          if (activeTurn !== turn || turn.started) {
            return;
          }

          const shutdownContext = context;
          closed = true;
          finishActiveTurn((currentTurn) => {
            currentTurn.reject(new Error("Pi host turn preflight failed"));
          });
          context = undefined;
          shutdownContext?.shutdown();
        }, preflightTimeoutMs);
        input.signal?.addEventListener("abort", abortActiveTurn, { once: true });

        try {
          pi.sendUserMessage(input.text);
        } catch (error) {
          finishActiveTurn((currentTurn) => {
            currentTurn.reject(error instanceof Error ? error : new Error(String(error)));
          });
        }
      });
    },
    disposeAll: close,
    close
  };
}

async function runToolStartGate(turn: ActiveTurn, abortActiveTurn: () => void): Promise<void> {
  if (turn.abortRequested) {
    throw new Error("Pi host turn was aborted");
  }

  const preface = turn.preToolChunks.join("").trim() || missingPrefaceAcknowledgement;

  try {
    await turn.beforeFirstTool?.(preface);
  } catch (error) {
    turn.gateError = error instanceof Error ? error : new Error(String(error));
    abortActiveTurn();
    throw turn.gateError;
  }
}

function isAbortRequested(turn: ActiveTurn): boolean {
  return turn.abortRequested;
}

function defaultSchedulePreflightTimeout(expire: () => void, timeoutMs: number): () => void {
  const timeout = setTimeout(expire, timeoutMs);
  timeout.unref();

  return () => clearTimeout(timeout);
}

function readTextDelta(event: {
  readonly assistantMessageEvent: {
    readonly type: string;
    readonly delta?: unknown;
  };
}): string | undefined {
  return event.assistantMessageEvent.type === "text_delta" &&
    typeof event.assistantMessageEvent.delta === "string"
    ? event.assistantMessageEvent.delta
    : undefined;
}
