import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { PiAgentTurnClient, PiAgentTurnResponse } from "./voice-resident.js";

export type PiHostTurnClient = PiAgentTurnClient & {
  readonly close: () => void;
};

export type PiHostTurnClientOptions = {
  readonly preflightTimeoutMs?: number;
  readonly schedulePreflightTimeout?: (expire: () => void, timeoutMs: number) => () => void;
};

type ActiveTurn = {
  readonly chunks: string[];
  readonly expectedPrompt: string;
  readonly resolve: (value: PiAgentTurnResponse) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal | undefined;
  abortRequested: boolean;
  promptCandidate: boolean;
  started: boolean;
  cancelPreflight: () => void;
};

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
    }
  });
  pi.on("message_update", (event) => {
    const delta = readTextDelta(event);

    if (delta !== undefined && activeTurn?.started) {
      activeTurn.chunks.push(delta);
    }
  });
  pi.on("agent_settled", () => {
    if (!activeTurn?.started) {
      return;
    }

    finishActiveTurn((turn) => {
      if (turn.abortRequested) {
        turn.reject(new Error("Pi host turn was aborted"));
        return;
      }

      turn.resolve({ text: turn.chunks.join(""), settled: Promise.resolve() });
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
          chunks: [],
          expectedPrompt: input.text,
          resolve,
          reject,
          signal: input.signal,
          abortRequested: false,
          promptCandidate: false,
          started: false,
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
