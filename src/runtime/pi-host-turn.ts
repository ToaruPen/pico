import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { PiAgentTurnClient } from "./voice-resident.js";

export type PiHostTurnClient = PiAgentTurnClient & {
  readonly close: () => void;
};

type ActiveTurn = {
  readonly chunks: string[];
  readonly resolve: (value: { readonly text: string }) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal | undefined;
  abortRequested: boolean;
};

export function createPiHostTurnClient(
  pi: Pick<ExtensionAPI, "on" | "sendUserMessage">
): PiHostTurnClient {
  let context: ExtensionContext | undefined;
  let activeTurn: ActiveTurn | undefined;
  let closed = false;

  const removeAbortListener = (turn: ActiveTurn): void => {
    turn.signal?.removeEventListener("abort", abortActiveTurn);
  };
  const finishActiveTurn = (
    finish: (turn: ActiveTurn) => void
  ): void => {
    const turn = activeTurn;

    if (turn === undefined) {
      return;
    }

    activeTurn = undefined;
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
  pi.on("message_update", (event) => {
    const delta = readTextDelta(event);

    if (delta !== undefined) {
      activeTurn?.chunks.push(delta);
    }
  });
  pi.on("agent_settled", () => {
    finishActiveTurn((turn) => {
      if (turn.abortRequested) {
        turn.reject(new Error("Pi host turn was aborted"));
        return;
      }

      turn.resolve({ text: turn.chunks.join("") });
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
          resolve,
          reject,
          signal: input.signal,
          abortRequested: false
        };
        activeTurn = turn;
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
