# VLM Provider Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route one bounded scene image explicitly to either the existing Ollama VLM or the active image-capable Pi Agent model, with Tapo or StackChan as the selected camera source.

**Architecture:** Keep the existing Ollama scene-description client. Add a scene route config and a capture-only service result; for `provider: agent`, the perception tool returns text plus image content to the current AgentSession. No second session, direct cloud SDK, provider registry, or fallback path is introduced.

**Tech Stack:** TypeScript 6, Vitest, Pi Agent tool image results, Sharp, existing RTSP and StackChan adapters.

---

Repository policy forbids commits unless the user explicitly requests them. Replace each normal commit step with a diff/status checkpoint.

## Task 1: Add explicit scene route config

**Files:**
- Modify: `src/config/index.ts`
- Modify: `config/pico.example.yaml`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write failing tests**

Test all closed-union values:

```ts
vision: {
  sceneDescription: {
    provider: "agent",
    source: "stackchan",
    timeoutMs: 30_000,
    maxImageEdgePixels: 512
  }
}
```

Reject unknown provider/source, `source: stackchan` without `camera.stackchan`, and
`provider: ollama` without `vision.ollama`.

- [ ] **Step 2: Verify RED**

Run `npx vitest run tests/config.test.ts`; expect unknown `sceneDescription`.

- [ ] **Step 3: Implement validation**

Add:

```ts
export type PicoSceneDescriptionConfig = {
  readonly provider: "ollama" | "agent";
  readonly source: "tapo" | "stackchan";
  readonly timeoutMs: number;
  readonly maxImageEdgePixels: number;
};
```

An absent `vision.sceneDescription` section fails immediately with the fixed route-omission
result, before any camera capture or VLM request. A present section must explicitly contain both
`provider` and `source`; an incomplete section fails configuration validation. There is no
implicit `ollama` + `tapo` route.

- [ ] **Step 4: Verify GREEN**

Run focused config tests and typecheck.

## Task 2: Generalize scene frame capture without changing Ollama behavior

**Files:**
- Modify: `src/runtime/perception-service.ts`
- Test: `tests/perception-service.test.ts`

- [ ] **Step 1: Write failing frame-source tests**

Add `captureSceneFrame()` result coverage for Tapo and StackChan. The passed result contains bytes
in memory but errors and public result metadata never contain a camera URL, capture path, token, or
image base64.

- [ ] **Step 2: Verify RED**

Run `npx vitest run tests/perception-service.test.ts`; expect missing route support.

- [ ] **Step 3: Implement source dispatch**

Create one internal `captureConfiguredSceneFrame()` exhaustive switch:

```ts
switch (config.vision.sceneDescription.source) {
  case "tapo":
    return captureTapoSceneFrame(...);
  case "stackchan":
    return captureStackChanSceneFrame(...);
}
```

Inject the StackChan capture adapter for tests. Production creates a bounded one-call adapter and
closes it in `finally`.

- [ ] **Step 4: Preserve Ollama**

Feed the captured frame through the existing resize and `createOllamaSceneDescriptionClient()`.
Keep current strict schema parsing and source metadata.

- [ ] **Step 5: Verify GREEN**

Run perception-service and existing vision/Ollama tests.

## Task 3: Return an image tool result for the agent route

**Files:**
- Modify: `src/runtime/perception-tool.ts`
- Modify: `src/runtime/perception-service.ts`
- Test: `tests/perception-tool.test.ts`

- [ ] **Step 1: Write the failing tool test**

For `provider: agent`, expect:

```ts
expect(result.content).toEqual([
  { type: "text", text: expect.stringContaining("Describe only visible") },
  { type: "image", data: Buffer.from(jpeg).toString("base64"), mimeType: "image/jpeg" }
]);
```

Assert `result.details` contains only source ID, byte count, and capture time.

- [ ] **Step 2: Verify RED**

Run `npx vitest run tests/perception-tool.test.ts`; expect a text-only result.

- [ ] **Step 3: Implement agent route**

Expose a bounded safety instruction from the vision module and a capture-only service operation.
The tool selects behavior from an explicitly configured `vision.sceneDescription.provider`:

- `ollama`: current text JSON result
- `agent`: text instruction plus image content

Do not infer an Ollama/Tapo route when the field is absent. Do not include image data in details.
The standard scene tool should answer natural active-conversation requests such as
「これ見える？」without an extra confirmation dialog.

- [ ] **Step 4: Fail closed for deferred agent routing**

When the deferred tool resolves an `agent` route, return a bounded failure explaining that agent
image routing requires the standard scene tool. Do not call Ollama.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx vitest run tests/perception-tool.test.ts tests/perception-service.test.ts tests/vision.test.ts
```

Expected: PASS.

## Task 4: Enforce image-capable agent models at startup

**Files:**
- Modify: `src/runtime/pico-startup.ts`
- Test: `tests/pico-startup.test.ts`

- [ ] **Step 1: Write failing model capability tests**

With `provider: agent`, a model whose `input` is `["text"]` must fail before controller creation.
A model with `["text", "image"]` must proceed. Ollama routing must not require agent image support.

- [ ] **Step 2: Verify RED**

Run `npx vitest run tests/pico-startup.test.ts`; expect the text-only model case to proceed.

- [ ] **Step 3: Add the capability gate**

After exact model resolution/authentication and before controller creation:

```ts
if (
  config.vision.sceneDescription.provider === "agent" &&
  !model.input.includes("image")
) {
  throw new PicoStartupUserError("configured Pico model does not support image input");
}
```

- [ ] **Step 4: Verify GREEN**

Run startup tests and typecheck.

## Task 5: Validate routes and document operation

**Files:**
- Modify: `scripts/smoke/camera-vlm-scene.ts`
- Modify: `tests/camera-vlm-scene-smoke.test.ts`
- Modify: `TOOLS.md`

- [ ] **Step 1: Write failing smoke tests**

The smoke plan must report selected provider and source without provider credentials or image
content. Agent mode verifies capture preparation; the full Pi field run verifies actual model
vision.

- [ ] **Step 2: Implement bounded smoke reporting**

Keep provider/source as explicit report metadata. Do not infer or attempt another route.

- [ ] **Step 3: Run local gates**

Run:

```bash
npx vitest run tests/config.test.ts tests/perception-service.test.ts \
  tests/perception-tool.test.ts tests/pico-startup.test.ts \
  tests/camera-vlm-scene-smoke.test.ts
npm run typecheck
npm run lint
npm run ast
```

- [ ] **Step 4: Run real Codex image validation**

Use `provider: agent`, `source: stackchan`, and the configured
`openai-codex/gpt-5.6-sol`. Capture one user-requested frame, verify the assistant receives the
image tool result and returns a bounded Japanese scene description, and confirm no image/base64
appears in shared logs.

- [ ] **Step 5: Final gates**

Run:

```bash
just check
npx secretlint .
git diff --check
```

Expected: all pass.
