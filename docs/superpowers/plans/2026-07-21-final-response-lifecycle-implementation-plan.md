# Final Response Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start canonical final-response TTS before Pi-level settlement hooks finish while preserving cancellation, session, farewell, and memory boundaries.

**Architecture:** The Pi adapter publishes one conservative final response and exposes a separate settlement promise while retaining active-turn ownership. The resident runtime overlaps playback with settlement and waits for both before idle. The generation abort listener is detached at response publication so post-publication F2 stops audio without cancelling Pi settlement.

**Tech Stack:** TypeScript, Pi AgentSession SDK, Vitest, resident control state machine, AivisSpeech playback pipeline, OpenTelemetry stage probe

---

### Task 1: Add the response-plus-settlement adapter contract

**Files:**
- Modify: `src/runtime/voice-resident.ts`
- Modify: `src/runtime/pi-agent-turn.ts`
- Test: `tests/pi-agent-turn.test.ts`

- [ ] **Step 1: Write the failing early-response test**

Use the existing deterministic session harness. Hold `session.prompt()` open after emitting a final `agent_end`, then assert:

```ts
const response = await client.prompt(input);
expect(response.text).toBe("最終回答です。");
expect(settlementFinished).toBe(false);
```

The returned response must include a still-pending `settled` promise.

- [ ] **Step 2: Verify Red**

Run: `npx vitest run tests/pi-agent-turn.test.ts`

Expected: test times out or remains pending because current `prompt` waits for SDK settlement.

- [ ] **Step 3: Define the minimal public result**

Change the boundary to:

```ts
export type PiAgentTurnResponse = {
  readonly text: string;
  readonly settled: Promise<void>;
};
```

Keep `prompt` itself async because session creation may fail before a response boundary exists.

- [ ] **Step 4: Implement response publication without releasing ownership**

Create a prompt-local response promise. Resolve it from a final `agent_end` only once. Continue subscription, tool settlement, abort cleanup, and `releaseTurn()` from the SDK prompt settlement operation. Attach a rejection observer to `settled` so the period before the caller awaits it cannot create an unhandled rejection.

- [ ] **Step 5: Verify Green for the early response case**

Run: `npx vitest run tests/pi-agent-turn.test.ts -t "publishes the final response before prompt settlement"`

Expected: pass.

### Task 2: Enforce the conservative final-response boundary

**Files:**
- Modify: `src/runtime/pi-agent-turn.ts`
- Test: `tests/pi-agent-turn.test.ts`

- [ ] **Step 1: Add the SDK queued-message contract to the harness**

Extend `PiAgentSdkSession` with only:

```ts
readonly agent: {
  readonly hasQueuedMessages: () => boolean;
};
```

Do not expose compaction state or add a parallel retry state machine.

- [ ] **Step 2: Write failing tool/retry/follow-up cases**

Assert no early response for tool-use output, `willRetry: true`, or an `agent_end` whose extension handler has queued a follow-up. Then emit the final no-queue `stop` response and assert exactly one publication.

- [ ] **Step 3: Write the non-stop compatibility case**

Emit a successful non-`stop` assistant response, complete `session.prompt`, and assert the text is returned after settlement rather than discarded.

- [ ] **Step 4: Implement the admission predicate**

Publish early only for `stop`, `willRetry === false`, no SDK queued messages, no abort, and no prior publication. Preserve the current last-final-assistant output and terminal error handling for the settlement fallback path.

- [ ] **Step 5: Verify Green and commit**

Run: `npx vitest run tests/pi-agent-turn.test.ts`

Expected: all adapter lifecycle, tool, retry, disposal, and compatibility tests pass.

Commit: `feat: expose final response before Pi settlement`

### Task 3: Split pre- and post-response cancellation

**Files:**
- Modify: `src/runtime/pi-agent-turn.ts`
- Modify: `src/runtime/voice-resident.ts`
- Test: `tests/pi-agent-turn.test.ts`
- Test: `tests/voice-resident.test.ts`

- [ ] **Step 1: Write failing adapter abort-boundary tests**

Assert an abort before response publication calls `session.abort()` once. In a second test, publish the response, abort the same generation signal, and assert `session.abort()` is not called while `response.settled` remains pending.

- [ ] **Step 2: Verify Red**

Run: `npx vitest run tests/pi-agent-turn.test.ts -t "abort"`

Expected: post-publication abort still reaches the SDK session.

- [ ] **Step 3: Detach Pi abort at publication**

Remove the installed prompt abort listener immediately before resolving the response promise. Settlement keeps its event subscription and active-turn claim.

- [ ] **Step 4: Write failing resident overlap and F2 tests**

Assert playback begins while settlement is pending. For pre-publication F2, assert Pi and the resident generation cancel. For post-publication F2, assert playback stops, capture resumes, settlement is not aborted, and the controller becomes idle only after settlement completes.

- [ ] **Step 5: Overlap playback and settlement minimally**

After response publication, start the existing TTS pipeline and await playback plus `response.settled` as independently owned operations. Do not add another resident state enum. Reuse the existing turn operation and cancellation convergence.

- [ ] **Step 6: Verify Green and commit**

Run: `npx vitest run tests/pi-agent-turn.test.ts tests/voice-resident.test.ts`

Expected: all focused tests pass.

Commit: `fix: preserve Pi settlement after speech cancellation`

### Task 4: Define post-response failure, disposal, and farewell convergence

**Files:**
- Modify: `src/runtime/voice-resident.ts`
- Modify: `src/runtime/pi-agent-turn.ts`
- Test: `tests/voice-resident.test.ts`
- Test: `tests/pi-agent-turn.test.ts`

- [ ] **Step 1: Write the settlement-rejection test**

Publish a response, complete playback once, then reject settlement. Assert no second TTS request, existing failed-turn accounting increments once, `pi_turn` records error, capture/echo boundaries resume, and the runtime returns to a stable control state.

- [ ] **Step 2: Write disposal and farewell boundary tests**

Assert `disposeSession` waits for the active settlement claim. Assert an ended interaction does not start farewell Pi/TTS work until the preceding turn's playback and settlement both converge.

- [ ] **Step 3: Implement shared convergence without new states**

Keep the full playback/settlement operation in `turn.operation`. Record response text and start playback at response readiness; record final `pi_turn` status after settlement. If settlement rejects after response, do not replay or fail the resident process solely because speech was already delivered.

- [ ] **Step 4: Apply the same contract to farewell**

Make farewell playback overlap its response settlement and await both before session disposal. F2 after farewell response publication cancels farewell playback but not Pi settlement.

- [ ] **Step 5: Verify Green and commit**

Run: `npx vitest run tests/pi-agent-turn.test.ts tests/voice-resident.test.ts`

Expected: all tests pass.

Commit: `fix: converge spoken responses with Pi settlement`

### Task 5: Add minimal phase telemetry and run PR 3 gates

**Files:**
- Modify: `src/runtime/voice-stage-probe.ts`
- Modify: `src/runtime/pi-agent-turn.ts`
- Modify: `src/runtime/voice-resident.ts`
- Test: `tests/voice-stage-probe.test.ts`
- Test: `tests/pi-agent-turn.test.ts`
- Modify: `docs/superpowers/specs/2026-07-19-resident-voice-opentelemetry-design.md`
- Modify: `docs/superpowers/specs/2026-07-19-resident-tts-pipeline-design.md`

- [ ] **Step 1: Write failing telemetry tests**

Assert `pi_final_response_ready` is accepted as a persisted summary stage and is recorded at publication. Assert `pi_turn` remains pending until settlement. Confirm both attribute maps reject transcript, response, provider, plugin, and session fields.

- [ ] **Step 2: Verify Red**

Run: `npx vitest run tests/voice-stage-probe.test.ts tests/pi-agent-turn.test.ts`

Expected: unknown-stage failure.

- [ ] **Step 3: Implement the single new stage**

Add `pi_final_response_ready` and record it once from prompt start to response availability. Keep `pi_time_to_first_text` and `pi_turn` semantics unchanged.

- [ ] **Step 4: Update accepted specs**

Document canonical final-response playback before settlement and retain the prohibition on speaking provisional deltas. Explicitly state that Mem0 ownership and reasoning effort are unchanged.

- [ ] **Step 5: Run focused and static gates**

Run: `npx vitest run tests/pi-agent-turn.test.ts tests/voice-resident.test.ts tests/voice-stage-probe.test.ts tests/tts-playback-pipeline.test.ts`

Run: `just typecheck`

Run: `just lint`

Run: `just ast`

Run: `just format`

Run: `git diff --check`

Expected: all commands exit 0.

- [ ] **Step 6: Commit telemetry and docs**

Commit: `docs: define final response settlement timing`

