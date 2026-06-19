# Secure VLM Tunnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make the Windows GPU Ollama VLM path fail closed unless it is reached through a loopback-bound protected SSH tunnel, with clear diagnostics for stale Windows/WSL forwarding.

**Architecture:** Keep the selected provider as one Ollama endpoint over a protected tunnel. Add a transport-level preflight that validates the local tunnel URL, checks `/api/tags`, and reports common misroutes such as an API-key proxy or an unresponsive Windows portproxy without adding provider fallbacks.

**Tech Stack:** TypeScript, Vitest, existing `src/modules/local-models`, existing `src/modules/transport`, existing `scripts/smoke/ollama-vlm-connectivity.ts`, Tailscale SSH local forwarding.

---

## Task 1: Transport Preflight Contract

**Files:**
- Modify: `src/modules/transport/index.ts`
- Test: `tests/transport.test.ts`

- [x] **Step 1: Write failing transport tests**

Add tests that assert:

```ts
await preflightProtectedOllamaEndpoint(endpoint, fetcher)
```

returns a passed result when `/api/tags` contains `qwen3.5:9b`, returns failed results for unauthorized proxy responses, timeout/abort, and missing model, and never rewrites the selected endpoint.

- [x] **Step 2: Run RED**

Run:

```bash
npm run test -- tests/transport.test.ts
```

Expected: failure because `preflightProtectedOllamaEndpoint` is not exported.

- [x] **Step 3: Implement transport preflight**

Add a focused exported function to `src/modules/transport/index.ts` that:

- builds `/api/tags` from `endpoint.host.tunnel.localBaseUrl`;
- sends auth headers through `buildSelectedModelEndpointAuthHeaders`;
- times out with an `AbortController`;
- returns structured `passed`/`failed` results;
- maps HTTP `401`/`403` to "endpoint is not the selected Ollama port or requires unexpected auth";
- maps abort/fetch errors to protected tunnel reachability failure.

- [x] **Step 4: Run GREEN**

Run:

```bash
npm run test -- tests/transport.test.ts
```

Expected: pass.

## Task 2: VLM Smoke Integration

**Files:**
- Modify: `scripts/smoke/ollama-vlm-connectivity.ts`
- Test: `tests/ollama-vlm-smoke.test.ts`

- [x] **Step 1: Write failing smoke tests**

Add tests that prove the smoke command delegates to the transport preflight and reports the checked URL and selected model from that preflight.

- [x] **Step 2: Run RED**

Run:

```bash
npm run test -- tests/ollama-vlm-smoke.test.ts
```

Expected: failure because the current smoke fetches `/api/tags` directly.

- [x] **Step 3: Replace direct smoke fetch with transport preflight**

Keep CLI output compatible: `status`, `provider`, `details`, and `reason` remain stable. The smoke should still exit non-zero for failed results and skip when `vision.ollama` is absent.

- [x] **Step 4: Run GREEN**

Run:

```bash
npm run test -- tests/ollama-vlm-smoke.test.ts tests/transport.test.ts
```

Expected: pass.

## Task 3: Operator Documentation And Field Check

**Files:**
- Modify: `config/pico.example.yaml`
- Modify: `docs/field-tests/2026-06-15-tapo-rtsp-vlm.md`

- [x] **Step 1: Document the secure endpoint shape**

Document loopback-only local base URLs and the intended Tailscale SSH command:

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:11435:127.0.0.1:11434 win-main
```

- [x] **Step 2: Document the Windows host invariant**

State that Windows must expose Ollama only on `127.0.0.1:11434` for the SSH server process, and must not expose Ollama directly on LAN or tailnet interfaces.

- [x] **Step 3: Verify locally**

Run:

```bash
npm run test -- tests/transport.test.ts tests/ollama-vlm-smoke.test.ts
npm run typecheck
```

Expected: pass.

## Task 4: Live Tailscale SSH Verification

**Files:**
- No production code changes.

- [x] **Step 1: Check the current tunnel**

Run:

```bash
PICO_CONFIG_PATH=config/pico.local.yaml npm run smoke:ollama-vlm
```

Expected after Windows endpoint repair: pass with `qwen3.5:9b`.

- [x] **Step 2: If it fails, collect boundary evidence**

Run:

```bash
lsof -nP -iTCP:11435 -sTCP:LISTEN
ssh -o BatchMode=yes win-main 'curl.exe -sS --max-time 5 http://127.0.0.1:11434/api/tags'
```

Expected: the local listener is `ssh`, and Windows loopback returns Ollama tags.
