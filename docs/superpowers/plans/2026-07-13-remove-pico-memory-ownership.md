# Remove Pico Memory Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all short-term and durable-memory ownership from Pico while preserving its resident audio and address/attention lifecycle.

**Architecture:** Pi core remains the owner of conversation sessions, transcripts, context, history, tools, and subagents. Durable memory is an independently installed Pi-level plugin; Pico does not configure, register, proxy, or call it. Pico keeps only process-local interaction state needed for wake/PTT activation, inactivity timing, farewell, deferred-tool cancellation, and Pi SDK session disposal.

**Tech Stack:** TypeScript, Pi Coding Agent extension SDK, TypeBox, Vitest, Biome, ESLint, ast-grep, npm, Just, GitHub CLI

---

## File structure

The implementation keeps these ownership units:

- `src/modules/session/index.ts`: interaction-control state only; no transcript or memory cutoff.
- `src/runtime/voice-resident.ts`: resident interaction ending and terminal cleanup.
- `src/runtime/resident-voice-runner.ts`: provider assembly without a memory worker.
- `src/index.ts`: Pico extension registration without memory/session tools.
- `src/config/index.ts`: Pico-owned runtime config without a memory section.

The implementation removes these obsolete ownership units:

- `src/modules/memory/`
- `src/modules/long-memory/`
- `src/runtime/memory-tool.ts`
- `src/runtime/session-tool.ts`
- `scripts/resident/memory.ts`
- `scripts/smoke/mem0-runtime.ts`
- `scripts/smoke/embedding-sidecar.ts`
- `scripts/sidecars/jina-embedding-sidecar.py`
- all tests and fixtures dedicated to the removed units

## Task 1: Lock the extension and configuration boundary

**Files:**
- Modify: `tests/extension.test.ts`
- Modify: `tests/registry.test.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/justfile.test.ts`
- Modify: `tests/pi-agent-turn.test.ts`
- Modify: `src/index.ts`
- Modify: `src/orchestrator/contracts.ts`
- Modify: `src/modules/future.ts`
- Modify: `src/config/index.ts`
- Modify: `src/runtime/pi-agent-turn.ts`
- Delete: `src/modules/memory/index.ts`
- Delete: `src/runtime/memory-tool.ts`
- Delete: `src/runtime/session-tool.ts`
- Delete: `tests/memory.test.ts`
- Delete: `tests/memory-tool.test.ts`

- [ ] **Step 1: Write failing ownership-boundary tests**

Update the extension and registry assertions to require no Pico memory/session tools or module metadata:

```ts
expect(capture.tools.map((tool) => tool.name).sort()).toEqual([
  "pico_camera_scene_description",
  "pico_camera_snapshot",
  "pico_person_detection"
]);

expect(picoExtensionMetadata.modules.map((module) => module.kind)).not.toContain("memory");
expect(picoExtensionMetadata.futureModules.map((module) => module.kind)).not.toContain(
  "long_memory"
);
expect(residentPiAgentToolNames).not.toContain("pico_memory_search");
expect(residentPiAgentToolNames).not.toContain("pico_session");
```

Add strict top-level config coverage proving Pico rejects the removed section:

```ts
expect(() =>
  definePicoConfig({
    memory: {
      mem0: { enabled: false }
    }
  })
).toThrow("pico config has unknown field memory");
```

Change the structural test from checking memory runner absence to checking all Pico-owned entry points:

```ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = process.cwd();

for (const removedPath of [
  "src/modules/memory",
  "src/runtime/memory-tool.ts",
  "src/runtime/session-tool.ts"
]) {
  expect(existsSync(resolve(repositoryRoot, removedPath))).toBe(false);
}
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run tests/extension.test.ts tests/registry.test.ts tests/config.test.ts tests/justfile.test.ts tests/pi-agent-turn.test.ts
```

Expected: FAIL because memory metadata, `pico_memory_search`, `pico_session`, and `memory.mem0` still exist.

- [ ] **Step 3: Remove extension, registry, tool, and config ownership**

Delete the memory/session tool registration and runtime options from `src/index.ts`. The final runtime options contain only Pico-owned runtime controls:

```ts
export type PicoExtensionRuntimeOptions = {
  readonly loadConfig?: () => PicoConfig;
  readonly voiceProbe?: VoiceStageProbe;
  readonly perceptionMode?: "standard" | "resident_deferred";
  readonly deferredTools?: {
    readonly sessionId: string;
    readonly coordinator: Pick<DeferredToolCoordinator, "enqueue">;
  };
};

export function registerPicoExtensionWithRuntime(
  pi: ExtensionAPI,
  options: PicoExtensionRuntimeOptions = {}
): void {
  registerPerceptionRuntimeTools(pi, options);
  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => ({
    systemPrompt: buildPicoExtensionSystemPrompt(event.systemPrompt)
  }));
}
```

Remove `memory` from `PicoModuleKind`, remove `long_memory` from `FuturePicoModuleKind`, and remove their registrations/imports. Delete the four obsolete source/test units listed above.

Remove `PicoConfig.memory`, all `PicoMem0*` types, `defineMemorySection()`, Mem0 parser helpers, defaults, and memory path resolution. Add `requireKnownConfigFields(root, "pico config", ["pico", "session", "audit", "camera", "vision", "voice"])` at the start of `definePicoConfig()` so stale `memory:` YAML fails at startup rather than being ignored.

Remove `pico_memory_search` and `pico_session` from the direct resident field-harness tool list. Do not add a replacement memory tool name.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
npx vitest run tests/extension.test.ts tests/registry.test.ts tests/config.test.ts tests/justfile.test.ts tests/pi-agent-turn.test.ts
```

Expected: PASS with no memory/session tool or memory config ownership.

- [ ] **Step 5: Confirm removed identifiers have no production owner**

Run:

```bash
rg -n "createMemoryModule|pico_memory_search|createPicoSessionTool|PicoMem0|memory\.mem0" src config package.json Justfile
```

Expected: no matches.

- [ ] **Step 6: Commit the boundary removal**

```bash
git add src tests config
git commit -m "refactor(memory): remove Pico memory tools and config"
```

## Task 2: Reduce session state to interaction control

**Files:**
- Modify: `tests/session.test.ts`
- Modify: `src/modules/session/index.ts`

- [ ] **Step 1: Replace transcript/cutoff tests with interaction-state tests**

Require the public record and lifecycle to expose no conversation content:

```ts
it("keeps only interaction-control state", () => {
  const lifecycle = createSessionLifecycle({
    ending: { mode: "timed", durationMs: 1_000 }
  });
  const session = lifecycle.start({ kind: "wake_name", label: "ピコ", source: "voice" });

  expect(session).toEqual({
    id: "session-1",
    state: "active",
    startedAt: expect.any(String),
    endedAt: undefined,
    trigger: { kind: "wake_name", label: "ピコ", source: "voice" }
  });
  expect(session).not.toHaveProperty("entries");
});
```

Require explicit terminal removal:

```ts
it("removes only an ended interaction", () => {
  const lifecycle = createSessionLifecycle({
    ending: { mode: "timed", durationMs: 1_000 }
  });
  const session = lifecycle.start({ kind: "wake_name", label: "ピコ", source: "voice" });

  expect(() => lifecycle.remove(session.id)).toThrow("pico session has not ended");
  lifecycle.end(session.id);
  lifecycle.remove(session.id);
  expect(lifecycle.read(session.id)).toBeUndefined();
});
```

Keep deterministic tests for one-active-session, `refreshActivity()`, inactivity ending, idempotent `end()`, immutable snapshots, audit safety, timer `unref()`, and maximum timer bounds. Remove tests for entries, cutoff payload, acknowledgement, and ended-session retention.

- [ ] **Step 2: Run the session tests and verify RED**

Run:

```bash
npx vitest run tests/session.test.ts
```

Expected: FAIL because `SessionRecord.entries`, `appendEntry()`, `cutoff()`, and `acknowledgeCutoff()` still exist while `remove()` does not.

- [ ] **Step 3: Implement the minimal lifecycle contract**

Use this final public shape:

```ts
export type SessionRecord = {
  readonly id: string;
  readonly state: SessionState;
  readonly startedAt: string;
  readonly endedAt: string | undefined;
  readonly trigger: SessionStartTrigger;
};

export type SessionLifecycle = {
  readonly start: (trigger: SessionStartTrigger) => SessionRecord;
  readonly read: (id: string) => SessionRecord | undefined;
  readonly refreshActivity: (id: string) => SessionRecord;
  readonly end: (id: string) => SessionRecord;
  readonly remove: (id: string) => void;
};
```

Delete `SessionEntry*`, `SessionCutoff`, `endedSessionRetentionMs`, entry arrays, cleanup timers, and cutoff methods. `remove()` must require `ended`, clear any remaining timer, and delete the map entry. Audit attributes retain the session ID and trigger kind but remove `pico.session.entry_count`.

- [ ] **Step 4: Run the session tests and verify GREEN**

Run:

```bash
npx vitest run tests/session.test.ts
```

Expected: PASS with no transcript-bearing state.

- [ ] **Step 5: Commit the interaction lifecycle**

```bash
git add src/modules/session/index.ts tests/session.test.ts
git commit -m "refactor(session): keep interaction state only"
```

## Task 3: Remove memory processing from resident voice

**Files:**
- Modify: `tests/voice-resident.test.ts`
- Modify: `tests/resident-voice-runner.test.ts`
- Modify: `tests/resident-voice-audit-log.test.ts`
- Modify: `tests/voice-stage-probe.test.ts`
- Modify: `src/runtime/voice-resident.ts`
- Modify: `src/runtime/resident-voice-runner.ts`
- Modify: `src/runtime/resident-voice-audit-log.ts`
- Modify: `src/runtime/voice-stage-probe.ts`

- [ ] **Step 1: Write failing resident lifecycle tests**

Add a timed-ending test that proves no transcript or memory worker participates:

```ts
import { describe, expect, it, vi } from "vitest";

it("finalizes an ended interaction without memory processing", async () => {
  const lifecycle = createSessionLifecycle({ ending: { mode: "timed", durationMs: 1 } });
  const disposeSession = vi.fn();
  const cancelSession = vi.fn();

  const result = await runVoiceResidentRuntime({
    now: fixedNow(),
    frames: [sampleNearEndFrame("mic-trigger"), sampleNearEndFrame("mic-turn")],
    utteranceWindow: perFrameCompatibleUtteranceWindow(),
    triggerPhrases: ["ピコ"],
    sessionLifecycle: lifecycle,
    echoControl: createIdleEchoControl(),
    stt: (() => {
      const texts = ["ピコ", "この会話は終わりです。"];
      return {
        warmup: () => {
          throw new Error("warmup is not part of resident runtime");
        },
        transcribe: () => Promise.resolve(successfulTranscript(texts.shift() ?? ""))
      };
    })(),
    tts: createSuccessfulTts("はい。"),
    playback: { play: () => Promise.resolve() },
    piAgent: {
      prompt: () => {
        lifecycle.end("session-1");
        return Promise.resolve({ text: "はい。" });
      },
      disposeSession
    },
    deferredTools: {
      collectDeliverableResults: () => [],
      cancelSession
    }
  });

  expect(result).not.toHaveProperty("processedCutoffs");
  expect(result).not.toHaveProperty("failedCutoffs");
  expect(disposeSession).toHaveBeenCalledWith("session-1");
  expect(cancelSession).toHaveBeenCalledWith("session-1", "session_closed");
  expect(lifecycle.read("session-1")).toBeUndefined();
});
```

Add shutdown coverage requiring all cleanup owners to run even when one fails, while the lifecycle record is removed and the first error remains the aggregate cause. Remove fixtures and assertions for `memoryWorker`, `processedCutoffs`, `failedCutoffs`, `session_cutoff_memory`, and entry counts.

- [ ] **Step 2: Run the resident tests and verify RED**

Run:

```bash
npx vitest run tests/voice-resident.test.ts tests/resident-voice-runner.test.ts tests/resident-voice-audit-log.test.ts tests/voice-stage-probe.test.ts
```

Expected: FAIL because resident startup requires `memory.mem0`, utterances are copied into session entries, and ended sessions call `memoryWorker.processCutoff()`.

- [ ] **Step 3: Implement memory-free resident finalization**

Remove `VoiceResidentMemoryWorker`, the `memoryWorker` option, memory close handling, cutoff counters, and the `session_cutoff_memory` probe stage.

Replace entry append operations with activity refresh only:

```ts
function refreshActiveInteraction(lifecycle: SessionLifecycle, sessionId: string): boolean {
  if (lifecycle.read(sessionId)?.state !== "active") {
    return false;
  }

  lifecycle.refreshActivity(sessionId);
  return true;
}
```

Finalize every ended interaction through one function:

```ts
async function finalizeEndedInteractions(
  options: VoiceResidentRuntimeOptions,
  pendingEndedSessionIds: Set<string>,
  counters: VoiceResidentCounters,
  now: () => string,
  farewelledSessionIds: Set<string>
): Promise<void> {
  for (const sessionId of [...pendingEndedSessionIds]) {
    const session = options.sessionLifecycle.read(sessionId);
    if (session?.state !== "ended") {
      pendingEndedSessionIds.delete(sessionId);
      continue;
    }

    await runOptionalFarewell(session, options, counters, now, farewelledSessionIds);
    cancelDeferredToolSession(options.deferredTools, sessionId, "session_closed");
    await disposeSessionQuietly(options.piAgent, sessionId);
    options.sessionLifecycle.remove(sessionId);
    pendingEndedSessionIds.delete(sessionId);
  }
}
```

Change `disposeSessionQuietly()` to return `Promise<void>` and await a possibly asynchronous
`piAgent.disposeSession()` while suppressing only that per-session cleanup failure. This makes terminal
record removal occur after disposal settles.

Shutdown must always end an active interaction and run this finalizer. Preserve the existing cleanup-error aggregation for Pi agent disposal, deferred idle waiting, echo flush, and speech-activity close.

Remove Mem0 imports, worker creation/injection, and the memory metric stage from `resident-voice-runner.ts`.

- [ ] **Step 4: Run the resident tests and verify GREEN**

Run:

```bash
npx vitest run tests/voice-resident.test.ts tests/resident-voice-runner.test.ts tests/resident-voice-audit-log.test.ts tests/voice-stage-probe.test.ts
```

Expected: PASS with timed and shutdown finalization independent of memory configuration.

- [ ] **Step 5: Confirm utterance text has no Pico lifecycle sink**

Run:

```bash
rg -n "appendEntry|SessionEntry|SessionCutoff|sourceEntryIds|session_cutoff_memory|memoryWorker" src/runtime src/modules/session
```

Expected: no matches.

- [ ] **Step 6: Commit resident finalization**

```bash
git add src/runtime tests/voice-resident.test.ts tests/resident-voice-runner.test.ts tests/resident-voice-audit-log.test.ts tests/voice-stage-probe.test.ts
git commit -m "refactor(voice): decouple interaction ending from memory"
```

## Task 4: Remove Mem0 runtime, dependencies, and operational surfaces

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `Justfile`
- Modify: `TOOLS.md`
- Modify: `config/pico.example.yaml`
- Modify: `scripts/smoke/milestone-suite.ts`
- Modify: `tests/milestone-smoke.test.ts`
- Modify: `tests/audit.test.ts`
- Modify: `tests/audit-otel-exporter.test.ts`
- Modify: `src/modules/audit/index.ts`
- Delete: `src/modules/long-memory/index.ts`
- Delete: `src/modules/long-memory/extractor.ts`
- Delete: `src/modules/long-memory/mem0.ts`
- Delete: `src/modules/long-memory/mem0-runtime.ts`
- Delete: `src/modules/long-memory/pi-extractor.ts`
- Delete: `src/modules/long-memory/worker.ts`
- Delete: `scripts/resident/memory.ts`
- Delete: `scripts/smoke/mem0-runtime.ts`
- Delete: `scripts/smoke/embedding-sidecar.ts`
- Delete: `scripts/sidecars/jina-embedding-sidecar.py`
- Delete: `tests/long-memory-config-fixture.ts`
- Delete: `tests/long-memory-extractor.test.ts`
- Delete: `tests/long-memory-mem0.test.ts`
- Delete: `tests/long-memory-mem0-runtime.test.ts`
- Delete: `tests/mem0-runtime-smoke.test.ts`
- Delete: `tests/embedding-sidecar-smoke.test.ts`

- [ ] **Step 1: Write failing operational-boundary tests**

Make milestone smoke independent of memory by expecting only non-memory sections and using a generic audit event:

```ts
expect(report.sections.map((section) => section.id)).not.toEqual(
  expect.arrayContaining(["mem0_runtime", "memory_mem0", "embedding_sidecar"])
);

const auditEvent = {
  category: "session_lifecycle" as const,
  name: "session.started",
  severity: "info" as const,
  occurredAt: "2026-07-13T00:00:00.000Z",
  summary: "Pico interaction session started.",
  attributes: { source: "milestone_smoke" }
};
```

Update audit tests so `memory_write` is not an allowed Pico category and generic audit/OTel behavior remains covered.

Extend the structural absence assertion from Task 1 with the operational units removed in this task:

```ts
for (const removedPath of ["src/modules/long-memory", "scripts/resident/memory.ts"]) {
  expect(existsSync(resolve(repositoryRoot, removedPath))).toBe(false);
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run tests/milestone-smoke.test.ts tests/audit.test.ts tests/audit-otel-exporter.test.ts
```

Expected: FAIL because milestone smoke and audit fixtures still contain Pico memory ownership.

- [ ] **Step 3: Delete runtime and operational ownership**

Delete the long-memory, sidecar, smoke, and dedicated test files listed above. Remove `mem0ai` and `@qdrant/js-client-rest` plus their scripts from `package.json`, then regenerate the lockfile:

```bash
npm install
```

Remove memory recipes from `Justfile`, memory provider/embedder routing from `TOOLS.md`, and the entire `memory:` block from `config/pico.example.yaml`.

Remove memory sections and dependencies from milestone smoke while preserving audit/OTel coverage with a generic runtime event. Remove the unused `memory_write` audit category and memory-specific event summaries.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run tests/milestone-smoke.test.ts tests/audit.test.ts tests/audit-otel-exporter.test.ts
```

Expected: PASS without memory runtime fixtures.

- [ ] **Step 5: Verify the dependency graph and executable surface**

Run:

```bash
npm ls mem0ai @qdrant/js-client-rest better-sqlite3
rg -n "mem0|qdrant|embedding-sidecar|memory:resident|smoke:mem0-runtime" package.json package-lock.json Justfile TOOLS.md config scripts src
```

Expected: `npm ls` reports no installed packages and `rg` reports no Pico-owned runtime/config references.

- [ ] **Step 6: Commit runtime deletion**

```bash
git add package.json package-lock.json Justfile TOOLS.md config scripts src/modules tests
git commit -m "refactor(memory): remove Mem0 runtime ownership"
```

## Task 5: Align source-of-truth and historical documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-06-09-pico-agent-design.md`
- Modify: `docs/superpowers/specs/2026-06-18-voice-resident-runtime-design.md`
- Modify: `docs/superpowers/specs/2026-07-12-pi-host-architecture-recovery-design.md`
- Modify: `docs/superpowers/research/2026-06-09-pico-module-dependency-survey.md`
- Modify: `docs/field-tests/README.md`
- Modify: `docs/superpowers/plans/2026-06-09-pico-foundation-implementation-plan.md`
- Modify: `docs/superpowers/plans/2026-06-12-mem0-memory-stack.md`
- Modify: `docs/superpowers/plans/2026-06-18-voice-resident-runtime.md`
- Modify: `docs/superpowers/plans/2026-07-12-pi-host-architecture-recovery.md`
- Modify: `docs/field-tests/2026-06-14-pi-agent-launch.md`
- Modify: `docs/field-tests/2026-06-14-pi-agent-timed-cutoff.md`
- Modify: `docs/field-tests/2026-06-15-tapo-rtsp-vlm.md`
- Modify: `docs/field-tests/2026-06-16-integrated-field-test.md`
- Delete: `docs/superpowers/specs/2026-07-13-mem0-only-long-memory-design.md`
- Delete: `docs/superpowers/research/2026-07-13-mem0-only-memory-architecture.md`
- Delete: `docs/superpowers/plans/2026-07-13-mem0-only-long-memory.md`

- [ ] **Step 1: Update AGENTS.md as the highest-priority source**

Replace the ownership statements with:

```md
- Pi owns the production process, parent conversation session, conversation
  context and history, model loop, tools, subagents, normal cancellation, and
  all memory capabilities. Pico owns facility audio, address/attention rules,
  TTS/echo control, and facility runtime restrictions.
- Durable memory, when enabled, is provided by a separately installed Pi-level
  plugin. That plugin owns provider configuration, extraction, persistence,
  retrieval, mutation, retention, and lifecycle. Pico does not register,
  configure, wrap, proxy, or call memory tools or providers, and Pico
  interaction ending has no memory side effect.
```

Add the boundary:

```md
- Do not add short-term or durable-memory stores, extraction workers,
  memory-search tools, Mem0/Qdrant clients, or cutoff-memory hooks to Pico.
```

Keep the product-level prohibition on child tracking, scoring, and profiling, but remove wording that requires a Pico memory validator.

- [ ] **Step 2: Update current documents and retire rejected architecture**

Update current specs/research/README/field-test README to use the same ownership terms as the approved design. Remove `memory` and `long_memory` from the Pico module tree and remove Pico-owned Mem0/Qdrant/worker/smoke instructions.

Delete the three rejected 2026-07-13 Mem0-only documents. Keep already-deleted SQLite/autonomous-memory documents deleted.

- [ ] **Step 3: Preserve historical evidence with explicit supersession banners**

Use this banner at the top of historical plans and field reports that mention Pico memory ownership:

```md
> Historical record: memory-related ownership in this document was superseded
> by [Pi 所有 memory 責務境界設計](../specs/2026-07-13-pi-owned-memory-boundary-design.md).
> Current Pico has no short-term or durable-memory implementation.
```

For `docs/field-tests/*.md`, use this exact path instead:

```md
> Historical record: memory-related ownership in this document was superseded
> by [Pi 所有 memory 責務境界設計](../superpowers/specs/2026-07-13-pi-owned-memory-boundary-design.md).
> Current Pico has no short-term or durable-memory implementation.
```

Do not rewrite historical test results as though the old runtime never existed.

- [ ] **Step 4: Check documentation consistency**

Run:

```bash
rg -n "Pico.*(owns|所有).*Mem0|pico_memory_search|memory\.mem0|session_cutoff_memory|long_memory.*(available|planned)" AGENTS.md README.md docs/superpowers/specs docs/superpowers/research docs/field-tests/README.md
rg -n "2026-07-13-mem0-only-long-memory|2026-07-13-mem0-only-memory-architecture" docs
```

Expected: no current-source contradiction or link to a deleted current document. Historical records may contain old commands only beneath a supersession banner.

- [ ] **Step 5: Commit documentation alignment**

```bash
git add AGENTS.md README.md docs
git commit -m "docs(memory): move memory ownership to Pi"
```

## Task 6: Clean local configuration and verify the complete runtime

**Files:**
- Modify if present and untracked: `config/pico.local.yaml`

- [ ] **Step 1: Remove the stale local Pico memory block**

Delete only the top-level `memory:` block from `config/pico.local.yaml`. Preserve `pico.model`, voice, camera, vision, session, and audit settings. Do not move Mem0 settings into another file in this repository.

- [ ] **Step 2: Format and run the complete local gate**

Run:

```bash
just format
just check
npx secretlint .
```

Expected: all formatting, typecheck, lint, ast-grep, tests, and secret scanning pass.

- [ ] **Step 3: Run absence and dependency checks**

Run:

```bash
test ! -e src/modules/memory
test ! -e src/modules/long-memory
test ! -e src/runtime/memory-tool.ts
test ! -e src/runtime/session-tool.ts
npm ls mem0ai @qdrant/js-client-rest better-sqlite3
rg -n "pico_memory_search|memory\.mem0|session_cutoff_memory|memoryWorker|appendEntry|SessionCutoff" src config package.json Justfile
```

Expected: all `test` commands exit zero, dependency tree is empty, and `rg` has no matches.

- [ ] **Step 4: Start the actual Pi extension with the real local YAML**

Run:

```bash
PICO_CONFIG_PATH="$PWD/config/pico.local.yaml" npm run smoke:pi-runtime
```

Expected:

```json
{"loaded":true,"identity":"pico"}
```

Then run an actual non-persistent Pi CLI turn with the Pico extension:

```bash
PICO_CONFIG_PATH="$PWD/config/pico.local.yaml" node_modules/.bin/pi --no-approve --no-session --extension ./src/index.ts -p "Reply with the exact text: pico runtime ready"
```

Expected: the Pi process starts without `memory:` config, loads Pico, completes the turn, and emits no Mem0/Qdrant/Undici error.

- [ ] **Step 5: Review the final diff against origin/main**

Run:

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git status --short
```

Expected: no whitespace errors, final diff removes both legacy memory and Mem0 replacement, and the worktree is clean after commits.

## Task 7: Update issues and converge PR #97

**Files:**
- GitHub Issue: `#96`
- GitHub Issue: `#94`
- GitHub Pull Request: `#97`

- [ ] **Step 1: Push the completed branch**

Run:

```bash
git push origin codex/mem0-only-memory
```

Expected: remote head advances to the final verified commit.

- [ ] **Step 2: Reframe #96 as the removal task completed by this PR**

Set the title to:

```text
Tech debt: Picoからmemory ownershipを除去する
```

Replace the body with:

```md
## Background

PR #95 introduced a Pico-owned durable-memory slice. PR #97 initially replaced the custom SQLite/FTS engine with an embedded Mem0/Qdrant runtime, but actual Pi validation exposed that this still made a Pi plugin own and embed another plugin-level capability.

## Decision

Pi core owns conversation sessions, transcripts, context, history, tools, and subagents. Durable memory, when enabled, is an independently installed Pi-level plugin. Pico owns facility audio, address/attention, TTS/echo, and facility runtime restrictions only.

## Scope

- preserve deletion of the legacy SQLite/FTS store, candidate queue, custom worker, and memory LaunchAgent
- remove Pico short-term memory, long-memory modules, Mem0/Qdrant integration, extraction worker, embedding sidecar, and memory smokes
- remove `pico_memory_search`, `pico_session`, and `memory.*` Pico YAML
- stop copying staff/assistant utterances into Pico session state
- retain only ephemeral activation, inactivity timing, farewell, deferred cancellation, and Pi SDK session cleanup
- align current source documents and mark historical evidence as superseded

## Boundaries

- no compatibility alias, adapter, fallback, placeholder, or direct Pico-to-memory-plugin callback
- no model-name lock-in
- no Pico-side privacy filter or natural-language classifier
- child tracking, scoring, and profiling remain prohibited product behavior
- retention/decay research moves to the independent Pi-level memory plugin boundary in #94

## Acceptance criteria

- [ ] Pico source/config/package/scripts contain no memory provider, store, worker, search tool, Mem0, or Qdrant owner
- [ ] Pico session state contains no transcript or cutoff payload
- [ ] resident timed ending and shutdown complete without memory configuration
- [ ] legacy SQLite/FTS/queue/LaunchAgent paths remain deleted
- [ ] `just check` and secret scanning pass
- [ ] actual Pi extension smoke and actual non-persistent Pi turn pass with the real local YAML
- [ ] PR #97 has green required checks, no unresolved actionable review threads, and a clean merge state

## References

- `docs/superpowers/specs/2026-07-13-pi-owned-memory-boundary-design.md`
- `docs/superpowers/plans/2026-07-13-remove-pico-memory-ownership.md`
```

Keep `Closes #96` in PR #97 because the PR now implements this exact issue.

- [ ] **Step 3: Move #94 retention/decay research to the Pi-level plugin boundary**

Set the title to:

```text
Research: Pi-level Mem0 pluginのretention/decayを設計する
```

Replace the body with:

```md
## Status and ownership

Research retained; implementation scope transferred out of Pico.

Pico has no short-term or durable-memory implementation after #96/#97. If Mem0 is enabled, it is installed as an independent Pi-level plugin. That plugin—not Pico—owns provider configuration, extraction, storage, search, history, retention, decay, and deletion.

## Research summary

調査日: 2026-07-13

- [Mem0 Memory Decay](https://docs.mem0.ai/platform/features/memory-decay) is a project-level opt-in search-time soft ranking bias, not deletion or TTL.
- [Platform vs OSS](https://docs.mem0.ai/platform/platform-vs-oss) separates managed project features from the self-hosted engine.
- [Mem0 OSS REST API](https://docs.mem0.ai/open-source/features/rest-api) exposes add/search/update/delete/history operations.
- [Mem0 add semantics](https://docs.mem0.ai/core-concepts/memory-operations/add) documents exact-payload storage with `infer:false` and no deduplication.
- [Selective Memory Retention for Long-Horizon LLM Agents](https://arxiv.org/abs/2606.29178) combines utility, access, redundancy, and specificity instead of using age alone.
- [From Recall to Forgetting](https://arxiv.org/abs/2604.20006) treats reuse of invalidated facts as a distinct failure mode.
- [LongMemEval-V2](https://arxiv.org/abs/2605.12493) separates stable state, dynamic state, workflow knowledge, and environment gotchas.
- [Zep temporal knowledge graph](https://arxiv.org/abs/2501.13956) separates current facts from history through temporal validity.

## Direction for the independent plugin

1. Keep relevance primary; do not let age or access frequency dominate search by itself.
2. Separate search-time soft decay, supersession, retention, and physical deletion.
3. Keep stable facility knowledge until corrected, relocated, or retired; do not delete it only because it is old.
4. Prefer explicit expiry for temporary operational facts.
5. Use Mem0 public update/delete/history operations as the state boundary; do not create a second SQLite database, dual-write path, fallback, queue, or Pico adapter.
6. Validate Platform and OSS capabilities separately before implementing decay or expiration.

## Product boundaries

- no child tracking, evaluation, scoring, or profiling
- no durable records tied to an individual child or containing health, disability, abuse, or family circumstances
- no Privacy Filter, reversible masking, or natural-language denylist in Pico
- no worker model lock-in

## Evaluation requirements

- stable facility facts remain retrievable despite age
- expired or superseded operational facts do not appear in normal search
- access frequency does not permanently outrank relevance
- golden queries measure Precision@K, NDCG@K, obsolete-fact reuse, and noise stress
- deletion is verified through Mem0 search/get/history contracts
- observation reports exclude memory bodies, raw transcripts, queries, and credentials

## Repository scope

This issue is research/reference material only in the Pico repository. Implementation begins only in the repository or package that owns the independent Pi-level memory plugin. Do not add a Pico memory interface, adapter, callback, placeholder, or fallback.
```

Keep the existing `enhancement`, `memory`, `out-of-scope`, and `priority-medium` labels.

- [ ] **Step 4: Rewrite PR metadata for the final diff**

Set the PR title to:

```text
Remove memory ownership from Pico
```

The PR body must state:

```md
## Summary
- remove Pico-owned short-term memory, long-memory, Mem0/Qdrant integration, extraction workers, and memory tools
- keep only resident audio/address/attention interaction state; Pi owns conversation context and history
- make durable memory an independent Pi-level plugin concern without a Pico adapter or fallback
- preserve removal of the legacy SQLite/FTS queue and memory LaunchAgent

## Verification
- `just check`
- `npx secretlint .`
- actual Pi extension smoke with the real local YAML
- actual non-persistent Pi CLI turn
- dependency and source-absence checks
```

Keep `Closes #96` because #96 is rewritten to describe the completed removal.

- [ ] **Step 5: Wait for fresh required checks and review**

Run:

```bash
gh pr checks 97 --watch
gh pr view 97 --json mergeable,mergeStateStatus,reviews,statusCheckRollup
```

Expected: Pico quality gates, Apple Speech gates, GitGuardian, and CodeRabbit succeed; mergeability is `MERGEABLE` and merge state is `CLEAN`.

- [ ] **Step 6: Address actionable review feedback**

For each current unresolved review thread, verify the claim against the approved spec and implementation before changing code. Apply only in-scope corrections, rerun the smallest focused test followed by `just check`, commit, push, and reply with evidence. Do not restore memory ownership, compatibility aliases, fallback providers, or Pico-side privacy classifiers.

- [ ] **Step 7: Confirm convergence**

Run:

```bash
gh pr checks 97
gh pr view 97 --json isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
git status --short --branch
```

Expected: PR is ready, required checks are green, no current unresolved actionable review threads remain, merge state is `CLEAN`, and the local branch matches its remote.
