import { definePicoConfig, type PicoConfig } from "../src/config/index.js";

type EnabledLongMemoryTestConfigOptions = {
  readonly timedSession?: boolean;
  readonly otelAudit?: boolean;
};

export function defineEnabledLongMemoryTestConfig(
  databasePath: string,
  options: EnabledLongMemoryTestConfigOptions = {}
): PicoConfig {
  return definePicoConfig({
    ...(options.timedSession === true
      ? { session: { ending: { mode: "timed" as const, durationMs: 1 } } }
      : {}),
    memory: {
      longMemory: {
        enabled: true,
        databasePath,
        extraction: {
          provider: "pi_model",
          piProvider: "openai-codex",
          api: "openai-codex-responses",
          model: "gpt-5.4",
          thinkingLevel: "high",
          timeoutMs: 60_000
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
