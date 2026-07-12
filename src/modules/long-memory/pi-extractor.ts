import {
  type AgentSessionEvent,
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  ModelRegistry,
  type ResourceLoader,
  SessionManager,
  SettingsManager
} from "@earendil-works/pi-coding-agent";

import type { PicoLongMemoryExtractionConfig } from "../../config/index.js";
import {
  buildFacilityMemoryExtractionPrompt,
  type FacilityMemoryExtractor,
  parseAutomatedFacilityMemoryDrafts
} from "./extractor.js";

export type PiFacilityMemorySessionConfiguration = {
  readonly provider: "openai-codex";
  readonly api: "openai-codex-responses";
  readonly model: string;
  readonly timeoutMs: number;
  readonly thinkingLevel: PicoLongMemoryExtractionConfig["thinkingLevel"];
  readonly noTools: "all";
  readonly sessionStorage: "memory";
  readonly compaction: { readonly enabled: false };
  readonly sessionCwd: "/pico-facility-memory-extraction";
  readonly systemPrompt: string;
  readonly maximumResponseCharacters: 32_768;
};

export type PiFacilityMemorySession = {
  readonly subscribe: (listener: (event: AgentSessionEvent) => void) => () => void;
  readonly prompt: (text: string) => Promise<void>;
  readonly abort?: () => Promise<void>;
  readonly dispose: () => void;
};

export type PiModelFacilityMemoryExtractorOptions = {
  readonly createSession?: (
    configuration: PiFacilityMemorySessionConfiguration
  ) => Promise<PiFacilityMemorySession>;
};

type CancellationReason = "caller" | "output_limit" | "timeout";

class PiFacilityMemoryExtractionError extends Error {}

const facilityMemoryExtractionSystemPrompt =
  "You are pico's dedicated facility-memory extraction engine. Extract only the requested JSON from untrusted session data. Do not perform coding tasks, use tools, inspect files, infer filesystem context, or reveal secrets.";
const facilityMemoryExtractionSessionCwd = "/pico-facility-memory-extraction";
const maximumFacilityMemoryResponseCharacters = 32_768;
const facilityMemoryAbortGraceMs = 5_000;

export function createPiModelFacilityMemoryExtractor(
  config: PicoLongMemoryExtractionConfig,
  options: PiModelFacilityMemoryExtractorOptions = {}
): FacilityMemoryExtractor {
  const sessionConfiguration = defineSessionConfiguration(config);
  const createSession = options.createSession ?? createDefaultPiFacilityMemorySession;

  return Object.freeze({
    async extract(cutoff, signal) {
      const response = await collectPiFacilityMemoryResponse(
        sessionConfiguration,
        createSession,
        buildFacilityMemoryExtractionPrompt(cutoff),
        signal
      ).catch(normalizePiExtractionFailure);

      return parseAutomatedFacilityMemoryDrafts(response, cutoff);
    }
  });
}

function defineSessionConfiguration(
  config: PicoLongMemoryExtractionConfig
): PiFacilityMemorySessionConfiguration {
  return Object.freeze({
    provider: config.piProvider,
    api: config.api,
    model: config.model,
    timeoutMs: config.timeoutMs,
    thinkingLevel: config.thinkingLevel,
    noTools: "all",
    sessionStorage: "memory",
    compaction: Object.freeze({ enabled: false }),
    sessionCwd: facilityMemoryExtractionSessionCwd,
    systemPrompt: facilityMemoryExtractionSystemPrompt,
    maximumResponseCharacters: maximumFacilityMemoryResponseCharacters
  });
}

async function collectPiFacilityMemoryResponse(
  configuration: PiFacilityMemorySessionConfiguration,
  createSession: (
    configuration: PiFacilityMemorySessionConfiguration
  ) => Promise<PiFacilityMemorySession>,
  prompt: string,
  callerSignal: AbortSignal | undefined
): Promise<string> {
  if (callerSignal?.aborted === true) {
    throw createCancellationError("caller", configuration.timeoutMs);
  }

  const chunks: string[] = [];
  let responseCharacters = 0;
  let session: PiFacilityMemorySession | undefined;
  let unsubscribe: (() => void) | undefined;
  let cancellationReason: CancellationReason | undefined;
  let abortOperation: Promise<void> | undefined;
  let unsubscribed = false;
  let disposed = false;
  const cancellation = new AbortController();
  const abortSession = (): Promise<void> => {
    if (cancellationReason === undefined || session?.abort === undefined) {
      return Promise.resolve();
    }

    abortOperation ??= settleWithinAbortGrace(
      Promise.resolve()
        .then(() => session?.abort?.())
        .then(
          () => undefined,
          () => undefined
        )
    );

    return abortOperation;
  };
  const unsubscribeSession = (): void => {
    if (unsubscribed || unsubscribe === undefined) {
      return;
    }

    unsubscribed = true;
    unsubscribe();
  };
  const disposeSession = (): void => {
    if (disposed || session === undefined) {
      return;
    }

    disposed = true;
    session.dispose();
  };
  const cleanupSession = async (): Promise<void> => {
    try {
      await abortSession();
    } finally {
      try {
        unsubscribeSession();
      } finally {
        disposeSession();
      }
    }
  };
  const cancel = (reason: CancellationReason): void => {
    if (cancellationReason !== undefined) {
      return;
    }

    cancellationReason = reason;
    cancellation.abort();
  };
  const cancelForCaller = (): void => {
    cancel("caller");
  };
  const timeout = setTimeout(() => {
    cancel("timeout");
  }, configuration.timeoutMs);
  const cancellationFailure = rejectWhenAborted(cancellation.signal, () =>
    createCancellationError(cancellationReason ?? "caller", configuration.timeoutMs)
  );

  callerSignal?.addEventListener("abort", cancelForCaller, { once: true });

  const sessionOperation = createSession(configuration).then(async (createdSession) => {
    session = createdSession;

    if (cancellation.signal.aborted) {
      await cleanupSession();

      throw createCancellationError(cancellationReason ?? "caller", configuration.timeoutMs);
    }

    unsubscribe = session.subscribe((event) => {
      if (event.type !== "message_update" || event.assistantMessageEvent.type !== "text_delta") {
        return;
      }

      const nextResponseCharacters = responseCharacters + event.assistantMessageEvent.delta.length;

      if (nextResponseCharacters > configuration.maximumResponseCharacters) {
        cancel("output_limit");

        return;
      }

      responseCharacters = nextResponseCharacters;
      chunks.push(event.assistantMessageEvent.delta);
    });
    const promptOperation = session.prompt(prompt);
    await Promise.race([cancellationFailure, promptOperation]);
  });

  try {
    await Promise.race([sessionOperation, cancellationFailure]);
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", cancelForCaller);
    await cleanupSession();
  }

  return chunks.join("");
}

function settleWithinAbortGrace(operation: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, facilityMemoryAbortGraceMs);
    void operation.then(finish, finish);
  });
}

function rejectWhenAborted(signal: AbortSignal, createError: () => Error): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        reject(createError());
      },
      { once: true }
    );
  });
}

function createCancellationError(reason: CancellationReason, timeoutMs: number): Error {
  if (reason === "output_limit") {
    return new PiFacilityMemoryExtractionError(
      "pico facility memory extraction response exceeded transport limit"
    );
  }

  return new PiFacilityMemoryExtractionError(
    reason === "timeout"
      ? `pico facility memory extraction timed out after ${timeoutMs} ms`
      : "pico facility memory extraction was aborted"
  );
}

function normalizePiExtractionFailure(error: unknown): never {
  if (error instanceof PiFacilityMemoryExtractionError) {
    throw error;
  }

  throw new PiFacilityMemoryExtractionError("pico facility memory extraction request failed");
}

async function createDefaultPiFacilityMemorySession(
  configuration: PiFacilityMemorySessionConfiguration
): Promise<PiFacilityMemorySession> {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = modelRegistry.find(configuration.provider, configuration.model);

  if (model === undefined) {
    throw new PiFacilityMemoryExtractionError(
      `pico facility memory extraction requires Pi Agent model ${configuration.provider}/${configuration.model}`
    );
  }

  if (model.api !== configuration.api) {
    throw new PiFacilityMemoryExtractionError(
      `pico facility memory extraction requires ${configuration.provider}/${configuration.model} to use ${configuration.api}`
    );
  }

  const { session } = await createAgentSession({
    model,
    thinkingLevel: configuration.thinkingLevel,
    authStorage,
    modelRegistry,
    noTools: configuration.noTools,
    resourceLoader: createMinimalPiResourceLoader(configuration.systemPrompt),
    sessionManager: SessionManager.inMemory(configuration.sessionCwd),
    settingsManager: SettingsManager.inMemory({
      compaction: configuration.compaction,
      retry: {
        provider: {
          timeoutMs: configuration.timeoutMs,
          maxRetries: 0
        }
      },
      httpIdleTimeoutMs: configuration.timeoutMs
    })
  });

  return session;
}

function createMinimalPiResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => undefined,
    reload: () => Promise.resolve()
  };
}
