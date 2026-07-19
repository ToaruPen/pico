# Resident Ephemeral Conversation Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Pico resident while giving each timed interaction an isolated, non-persistent Pi AgentSession.

**Architecture:** The Pi CLI host runs with `--no-session`; Pico decides interaction lifetime; the existing Pi SDK adapter creates one in-memory child AgentSession per Pico session ID and disposes it after farewell. Startup snapshots the Pi-selected model, clamped thinking level, and active tools so child sessions preserve host capabilities without a Pico-owned tool policy.

**Tech Stack:** TypeScript 6, Vitest, `@earendil-works/pi-coding-agent` 0.80.6, Pi extension API

---

### Task 1: Make the host session non-persistent

**Files:**
- Modify: `src/runtime/pico-cli.ts`
- Modify: `tests/pico-cli.test.ts`

- [x] **Step 1: Write the failing CLI test**

Change the no-argument expectation to require:

```ts
expect(createPicoCliPlan([])).toEqual({
  kind: "pi",
  args: ["--no-session", "--extension", "./src/index.ts", "--pico"]
});
```

- [x] **Step 2: Verify RED**

Run: `npm test -- tests/pico-cli.test.ts`
Expected: FAIL because `--no-session` is absent.

- [x] **Step 3: Add the minimal CLI argument**

Return the exact argument array asserted above and update help text to say the Pi host is ephemeral.

- [x] **Step 4: Verify GREEN**

Run: `npm test -- tests/pico-cli.test.ts`
Expected: PASS.

### Task 2: Capture immutable Pi startup settings

**Files:**
- Modify: `src/runtime/pico-startup.ts`
- Modify: `tests/pico-startup.test.ts`

- [x] **Step 1: Write the failing startup test**

Extend the harness with `getThinkingLevel()` and `getActiveTools()`. Assert that `createController`
receives this second argument after model selection:

```ts
{
  model: { provider: "openai-codex", id: "gpt-5.6-sol" },
  thinkingLevel: "medium",
  activeToolNames: ["read", "stackchan_say"]
}
```

Also assert that `activeToolNames` is frozen and detached from the source array.

- [x] **Step 2: Verify RED**

Run: `npm test -- tests/pico-startup.test.ts`
Expected: FAIL because `createController` receives only `ExtensionContext`.

- [x] **Step 3: Implement the startup snapshot**

Define and pass:

```ts
export type PicoStartupAgentSettings = {
  readonly model: NonNullable<ExtensionContext["model"]>;
  readonly thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  readonly activeToolNames: readonly string[];
};
```

Create it only after `setModel()` and `setThinkingLevel()`, using `pi.getThinkingLevel()` and a
frozen copy of `pi.getActiveTools()`.

- [x] **Step 4: Verify GREEN**

Run: `npm test -- tests/pico-startup.test.ts`
Expected: PASS.

### Task 3: Let the Pi SDK adapter inherit startup settings

**Files:**
- Modify: `src/runtime/pi-agent-turn.ts`
- Modify: `tests/pi-agent-turn.test.ts`

- [x] **Step 1: Write failing adapter tests**

Add one test that passes an explicit model object, `thinkingLevel: "high"`,
`activeToolNames: ["read", "stackchan_say"]`, and `perceptionMode: "standard"`. Assert the SDK
factory receives:

```ts
{
  cwd: "/workspace/pico",
  model,
  thinkingLevel: "high",
  tools: ["read", "stackchan_say"]
}
```

Add a second test proving that standard perception tools are registered even when the resident
deferred coordinator exists.

- [x] **Step 2: Verify RED**

Run: `npm test -- tests/pi-agent-turn.test.ts`
Expected: FAIL because these explicit session inputs are not accepted or forwarded.

- [x] **Step 3: Implement explicit child-session inputs**

Extend `PiAgentTurnClientOptions` with optional `model`, `thinkingLevel`, `activeToolNames`, and
`perceptionMode`. Pass `cwd` plus the explicit values to `createAgentSession`; preserve the current
direct-harness defaults when the values are absent. Use `activeToolNames` instead of the direct
resident allowlist when supplied, then enforce the resulting active set after extension binding.

- [x] **Step 4: Verify GREEN and existing disposal coverage**

Run: `npm test -- tests/pi-agent-turn.test.ts`
Expected: all existing reuse, abort, keyed disposal, and dispose-all tests plus the new tests PASS.

### Task 4: Wire production resident voice to child sessions

**Files:**
- Modify: `src/index.ts`
- Modify: `src/runtime/resident-voice-service.ts`
- Modify: `tests/extension.test.ts`
- Modify: `tests/pi-subagent-capability.test.ts`

- [x] **Step 1: Write failing production-boundary assertions**

Require the production extension to use `createPiAgentTurnClient`, not `createPiHostTurnClient`, and
require the resident service to receive a `createPiAgent` factory. Keep the existing assertion that
Pico loads into a real SDK session.

- [x] **Step 2: Verify RED**

Run: `npm test -- tests/extension.test.ts tests/pi-subagent-capability.test.ts`
Expected: FAIL because production still sends resident input through the parent host session.

- [x] **Step 3: Implement the production factory wiring**

In `src/index.ts`, construct `createPiAgentTurnClient` with the startup model, thinking level,
active tool names, and `perceptionMode: "standard"`. In `resident-voice-service.ts`, pass that factory
to `runResidentVoiceWithProviders`; the runner continues to own deferred-tool construction and the
voice runtime continues to call `disposeSession()` after farewell.

- [x] **Step 4: Verify GREEN**

Run: `npm test -- tests/extension.test.ts tests/pi-subagent-capability.test.ts tests/resident-voice-service.test.ts tests/voice-resident.test.ts`
Expected: PASS.

### Task 5: Align source-of-truth documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-12-pi-host-architecture-recovery-design.md`
- Verify: `docs/superpowers/specs/2026-07-13-pi-owned-memory-boundary-design.md`

- [x] **Step 1: Mark the superseded single-session statements**

State that Pi still owns every AgentSession, while Pico interaction timing selects a non-persistent
Pi child-session lease. Remove production requirements that voice messages enter the host parent
session and that production must not call `createAgentSession()`.

- [x] **Step 2: Preserve the memory boundary**

Verify the documentation still forbids Pico-owned memory config, extraction, provider clients,
workers, stores, and lifecycle hooks.

- [x] **Step 3: Update operator startup guidance**

Document `--no-session --pico`, per-interaction child sessions, farewell-before-dispose ordering,
and the fact that the Pi process remains resident even though conversation context does not.

- [x] **Step 4: Run structural searches**

Run:

```bash
rg -n "pi.sendUserMessage|createPiHostTurnClient|createPiAgentTurnClient|--no-session|SessionManager.inMemory|disposeSession" src tests README.md AGENTS.md docs/superpowers/specs
```

Expected: parent-host turn handling is absent from the production entry; memory ownership remains
outside Pico.

### Task 6: Verify the complete change

**Files:**
- Verify all modified files

- [x] **Step 1: Format**

Run: `just format`
Expected: modified source and docs are formatted.

- [x] **Step 2: Run focused static gates**

Run: `just typecheck && just lint && just ast`
Expected: PASS.

- [x] **Step 3: Run the TypeScript suite**

Run: `just test`
Expected: PASS.

- [x] **Step 4: Run sidecar gates separately**

Run: `just apple-speech-check && just macos-control-check`
Expected: PASS. Generated ignored `.build` artifacts are not product-source changes.

- [x] **Step 5: Run the full source gate without generated Swift artifacts**

Run: `npm run check`
Expected: PASS.

- [x] **Step 6: Inspect final scope**

Run: `git status --short && git diff --check && git diff --stat`
Expected: only the session-boundary implementation, tests, and its source-of-truth docs are changed.
Do not commit until the user explicitly requests it.
