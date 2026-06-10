# Pico YAML Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one central YAML config boundary for pico smoke provider settings.

**Architecture:** `src/config/index.ts` parses `config/pico.local.yaml`, validates the result, and returns an immutable `PicoConfig`. Smoke scripts consume this config instead of provider-specific `PICO_*` environment reads while preserving explicit skipped sections for absent optional providers.

**Tech Stack:** TypeScript, Vitest, `yaml`, existing module validators, `jiti` smoke scripts.

---

## File Structure

- Create `src/config/index.ts`: YAML loader, config validation, immutable settings.
- Create `tests/config.test.ts`: loader and validation tests.
- Modify `scripts/smoke/tapo-rtsp-snapshot.ts`: build Tapo plan from config.
- Modify `scripts/smoke/ollama-vlm-connectivity.ts`: build VLM plan from config.
- Modify `scripts/smoke/voice-providers.ts`: build voice plans from config.
- Modify `scripts/smoke/camera-vlm-scene.ts`: use config-derived camera/VLM plans and config-derived sensitive values.
- Modify `scripts/smoke/milestone-suite.ts`: load config once per suite run and pass it into smoke dependencies.
- Modify smoke tests to assert config-based behavior.
- Create `config/pico.example.yaml`.
- Modify `.gitignore`, `README.md`, `package.json`, and `package-lock.json`.

### Task 1: Add YAML Dependency and Config Loader Tests

- [ ] **Step 1: Add failing loader tests**

Create `tests/config.test.ts` with tests for missing config, valid YAML, invalid numeric fields, partial Tapo config, and immutability.

- [ ] **Step 2: Verify red**

Run `npm run test -- tests/config.test.ts`.

Expected: FAIL because `../src/config/index.js` does not exist.

- [ ] **Step 3: Add `yaml` dependency**

Run `npm install yaml`.

- [ ] **Step 4: Implement config loader**

Create `src/config/index.ts` with `loadPicoConfig`, `loadPicoConfigFromEnvironment`, `definePicoConfig`, `emptyPicoConfig`, and typed nested config records.

- [ ] **Step 5: Verify green**

Run `npm run test -- tests/config.test.ts`.

Expected: PASS.

### Task 2: Move Smoke Plan Builders to Config

- [ ] **Step 1: Add failing smoke tests**

Update camera, voice, VLM, camera-to-VLM, and milestone tests to pass config objects and assert plan output.

- [ ] **Step 2: Verify red**

Run:

```bash
npm run test -- tests/camera-smoke.test.ts tests/voice-smoke.test.ts tests/ollama-vlm-smoke.test.ts tests/camera-vlm-scene-smoke.test.ts tests/milestone-smoke.test.ts
```

Expected: FAIL because plan builders still accept only env objects.

- [ ] **Step 3: Update smoke scripts**

Change smoke scripts to load config once at direct command boundaries and pass config into plan builders.

- [ ] **Step 4: Verify green**

Run the same focused test command.

Expected: PASS.

### Task 3: Add Example Config and Docs

- [ ] **Step 1: Add config sample**

Create `config/pico.example.yaml` without real credentials.

- [ ] **Step 2: Ignore local config**

Add `config/pico.local.yaml` to `.gitignore`.

- [ ] **Step 3: Update README**

Document `PICO_CONFIG_PATH=config/pico.local.yaml npm run smoke:milestone` and keep real credentials out of tracked docs.

### Task 4: Full Verification

- [ ] **Step 1: Run focused smoke suite without local config**

Run `npm run smoke:milestone`.

Expected: command exits 0 with optional provider sections skipped when no local config is present.

- [ ] **Step 2: Run all gates**

Run `just check`.

Expected: PASS.
