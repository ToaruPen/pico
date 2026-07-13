import { definePicoConfig, type PicoConfig } from "../src/config/index.js";

type EnabledLongMemoryTestConfigOptions = {
  readonly timedSession?: boolean;
  readonly otelAudit?: boolean;
  readonly model?: string;
};

export function defineEnabledLongMemoryTestConfig(
  historyDatabasePath: string,
  options: EnabledLongMemoryTestConfigOptions = {}
): PicoConfig {
  return definePicoConfig({
    ...(options.timedSession === true
      ? { session: { ending: { mode: "timed" as const, durationMs: 1 } } }
      : {}),
    memory: {
      mem0: {
        enabled: true,
        historyDbPath: historyDatabasePath,
        vectorStore: {
          provider: "qdrant",
          localBaseUrl: "http://127.0.0.1:6333",
          collectionName: "pico_test_facility_memory"
        },
        worker: {
          provider: "pi_model",
          piProvider: "openai-codex",
          api: "openai-codex-responses",
          model: options.model ?? "arbitrary-worker-model",
          thinkingLevel: "high",
          timeoutMs: 60_000
        },
        embedder: {
          provider: "sidecar",
          localBaseUrl: "http://127.0.0.1:18081",
          model: "test-embedder",
          embeddingDims: 3,
          timeoutMs: 30_000
        }
      }
    },
    ...(options.otelAudit === true
      ? {
          audit: {
            otel: {
              enabled: true,
              endpoint: "http://127.0.0.1:4318/v1/logs",
              serviceName: "pico-test",
              timeoutMs: 1_000
            }
          }
        }
      : {})
  });
}
