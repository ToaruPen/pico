import type { ResidentIoMessage } from "./resident-io-protocol.js";

export type ResidentHealthEvent = Extract<ResidentIoMessage, { kind: "health_event" }>;

export type ResidentHealthPublicationGate = {
  readonly accept: (event: ResidentHealthEvent, nowMs: number) => boolean;
};

const healthyPublicationIntervalMs = 60_000;

export function createResidentHealthPublicationGate(): ResidentHealthPublicationGate {
  let lastPublishedAtMs: number | undefined;
  let lastPublishedState: ResidentHealthEvent["state"] | undefined;
  let lastPublishedRestartCount: number | undefined;

  return {
    accept(event, nowMs) {
      const shouldPublish =
        lastPublishedAtMs === undefined ||
        event.state !== "running" ||
        event.state !== lastPublishedState ||
        event.restartCount !== lastPublishedRestartCount ||
        nowMs - lastPublishedAtMs >= healthyPublicationIntervalMs;

      if (!shouldPublish) return false;
      lastPublishedAtMs = nowMs;
      lastPublishedState = event.state;
      lastPublishedRestartCount = event.restartCount;
      return true;
    }
  };
}
