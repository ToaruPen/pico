# StackChan VLM Security Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve natural camera questions through the selected Pi model while removing implicit routing, raw MCP error disclosure, persistent StackChan captures, and unsafe capture-file types.

**Architecture:** Keep `provider: agent` as the standard one-image tool path without an additional confirmation dialog. Make the scene route explicitly optional and fail closed before capture when it is absent. Contain all StackChan MCP failures at the adapter boundary, and consume only direct regular capture files with non-blocking no-follow open, bounded reads, and deletion after the read completes.

**Tech Stack:** TypeScript, Pi AgentSession tools, MCP TypeScript SDK 1.29.0, Node.js filesystem APIs, Vitest

---

## Task 1: Remove the implicit scene route

**Files:**
- Modify: `src/runtime/perception-service.ts`
- Modify: `src/runtime/perception-tool.ts`
- Test: `tests/perception-service.test.ts`
- Test: `tests/perception-tool.test.ts`
- Test: `tests/camera-vlm-scene-smoke.test.ts`

- [ ] **Step 1: Write failing route-omission tests**

Add a service test proving that a config with Tapo and Ollama settings but no
`vision.sceneDescription` does not synthesize `{ provider: "ollama", source: "tapo" }`.
Its scene capture and description operations must return the fixed reason
`pico camera scene description route is not configured` without invoking camera or VLM
dependencies. Add a tool test proving the scene tool returns that bounded failure while
snapshot and person-detection service construction remains usable.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npx vitest run tests/perception-service.test.ts tests/perception-tool.test.ts tests/camera-vlm-scene-smoke.test.ts
```

Expected: the omitted-route cases fail because `resolveSceneRoute()` currently creates an
implicit Ollama/Tapo route.

- [ ] **Step 3: Make the route explicit and optional**

Change the service boundary to expose an optional route:

```ts
export type PicoPerceptionService = {
  readonly sceneRoute?: PicoSceneRoute;
  // existing operations remain unchanged
};

function resolveSceneRoute(config: PicoConfig): PicoSceneRoute | undefined {
  return config.vision.sceneDescription;
}
```

Before `captureSceneFrame()` or `describeCameraScene()` performs camera work, return:

```ts
{
  status: "failed",
  reason: "pico camera scene description route is not configured"
}
```

Update the standard scene tool to branch on the optional route before provider selection.
Do not disable unrelated snapshot or person-detection operations and do not infer another
provider.

- [ ] **Step 4: Run tests to verify GREEN**

Run the three focused test files and `just typecheck`. Expected: all pass.

## Task 2: Contain MCP errors and consume ephemeral regular captures

**Files:**
- Modify: `src/modules/stackchan/index.ts`
- Test: `tests/stackchan.test.ts`
- Modify: `tests/perception-service.test.ts`

- [ ] **Step 1: Write failing hostile-boundary tests**

Add tests where `connect`, `callTool`, and `close` reject with messages containing a bearer
token, an absolute capture path, and a raw tool body. Assert that public errors contain only
fixed StackChan operation messages.

Add capture-file tests proving:

- a successfully read direct child of the configured capture root is deleted;
- a nested path is rejected before reading;
- a symlink is rejected;
- a non-regular file handle is rejected before `read()`;
- `open()` receives `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`;
- delete and close failures become the existing fixed
  `StackChan capture could not be read` message without path disclosure.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npx vitest run tests/stackchan.test.ts tests/perception-service.test.ts
```

Expected: raw rejected messages escape, regular-file checks are absent, and the capture file
still exists after a successful read.

- [ ] **Step 3: Add fixed MCP error wrappers**

Wrap the injected or SDK-backed client at `createStackChanAdapter()` so adapter callers never
receive a dependency exception:

```ts
async function callStackChanTool(
  client: StackChanMcpClient,
  request: StackChanMcpToolRequest
): Promise<unknown> {
  try {
    return await client.callTool(request);
  } catch {
    throw new Error(`StackChan ${request.name} failed`);
  }
}
```

Use equivalent fixed wrappers for connect and close. Tool names come only from Pico-owned
constants. Do not append `cause`, response text, token, URL, path, or raw JSON-RPC content.

- [ ] **Step 4: Restrict and delete capture files**

Extend the narrow file-access seam with `stat()` on the opened handle and `unlink()` on the
resolved path. Require the canonical capture to be a direct child of the canonical capture
root. Open with:

```ts
constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
```

Before reading, require `await handle.stat()` to report a regular file. Keep the existing
`maxBytes + 1` bounded loop. Close the handle and unlink only the validated canonical capture
path before returning bytes. Attempt both cleanup operations even if one fails; any filesystem
failure remains contained by the fixed capture-read error.

The narrow file-access seam cannot unlink by descriptor. Therefore the canonical capture root
must be mode `0700` and owned by the same operating-system user as Pico and the local Gateway;
no other local actor may create, rename, or replace entries in that directory. Local deployment
must preserve this ownership boundary. This invariant is required for path-based
cleanup to remain bound to the file that was validated and read.

- [ ] **Step 5: Run tests to verify GREEN**

Run:

```bash
npx vitest run tests/stackchan.test.ts tests/perception-service.test.ts \
  tests/stackchan-attention-runtime.test.ts tests/stackchan-camera-grid-field.test.ts \
  tests/stackchan-face-follow-field.test.ts
just typecheck
just lint
just ast
```

Expected: all pass, and an `rg` search for injected secret/path/body literals finds them only in
negative assertions and fixtures.

## Task 3: Re-review and validate the complete feature

**Files:**
- Verify: `docs/superpowers/specs/2026-07-26-vlm-provider-routing-design.md`
- Verify: `docs/superpowers/specs/2026-07-26-stackchan-face-follow-design.md`
- Verify: `docs/field-tests/2026-07-26-stackchan-face-follow-vlm-routing.md`

- [ ] **Step 1: Run independent security re-review**

Review the complete working tree with this accepted product boundary: an active user scene
question may produce one image tool result without a second confirmation dialog. Verify that
route omission prevents capture, every actual request remains one bounded image, raw MCP
exceptions cannot reach tool content, StackChan capture files are ephemeral, and
validation/operator events retain scene metadata without image or text content.

- [ ] **Step 2: Run the bounded live smoke**

With the private field config and PINTO 441-S Dist model, run the camera grid and a short
face-follow session. Confirm home return, fixed error output, and absence of newly retained
capture files attributable to the run. Do not delete unrelated pre-existing captures.

- [ ] **Step 3: Run final repository gates**

Run:

```bash
just check
npx --yes --package=secretlint \
  --package=@secretlint/secretlint-rule-preset-recommend secretlint .
git diff --check
```

Expected: all checks pass. If plain `npx secretlint .` still cannot resolve the preset, record
that repository-tooling gap separately without treating the robust invocation as a production
code failure.

- [ ] **Step 4: Inspect the final working tree**

Confirm no ONNX, JPEG, bearer token, private capture path, or base64 image is tracked. Confirm
only intended source, test, specification, plan, and aggregate field-report files changed.
