# Irodori VoiceDesign Operational Quality Implementation Plan

> **Execution rule:** Follow TDD for every behavior-bearing harness, validator,
> and skill resource. Do not commit unless the user explicitly asks.

**Goal:** Establish a reproducible VoiceDesign input contract and performance
baseline, prove any optimization against that baseline, then create and
independently evaluate a fail-closed Codex skill.

**Architecture:** Use a two-layer lab. The public layer measures the unchanged
FastAPI service through Windows loopback and the existing SSH tunnel. The
direct layer runs only during a bounded Windows Scheduled Task stop and imports
the exact production Irodori-TTS source without opening an HTTP listener. Store
private text/audio separately from shareable metadata.

**Tech stack:** Python 3.11 stdlib harnesses plus pinned analysis dependencies,
FastAPI/Pydantic Irodori infra, Irodori-TTS v3 VoiceDesign, TypeScript/Vitest
only where Pico integration is eventually required, Windows PowerShell,
NVML/nvidia-smi, and Codex `skill-creator` plus `skill-eval-orchestrator`.

---

## Task 1: Freeze source and profile evidence

**Files:**

- Create: `.codex/benchmarks/voicedesign_operational/profile.schema.json`
- Create: `.codex/benchmarks/voicedesign_operational/profile.py`
- Create: `.codex/benchmarks/voicedesign_operational/test_profile.py`
- Create privately at runtime:
  `.codex/artifacts/irodori-voicedesign-operational-<run-id>/profile.json`

1. Write failing tests for canonical JSON ordering, hash validation, required
   revision fields, runtime flags, speaker manifest/embedding hashes, and
   rejection of secrets or raw fixture text.
2. Run the focused tests and capture the expected failures.
3. Implement the smallest deterministic profile builder and validator.
4. Re-run the focused tests.
5. Collect read-only macOS and Windows evidence. The production core-file
   hashes must still match before any synthesis.
6. Resolve and record the exact Hub snapshot/checkpoint artifact hash without
   adding a public endpoint.
7. Resolve the selected embedding internally and record only its SHA-256 in the
   private manifest.

## Task 2: Define fixtures and private artifact boundaries

**Files:**

- Create: `.codex/benchmarks/voicedesign_operational/fixtures.private.json`
- Create: `.codex/benchmarks/voicedesign_operational/fixtures.py`
- Create: `.codex/benchmarks/voicedesign_operational/test_fixtures.py`
- Create: `.codex/benchmarks/voicedesign_operational/test_artifacts.py`

1. Add the five required fixture IDs: short greeting, Ishigaki weather,
   Jugemu-length text, facility guidance, and one style-comparison sentence.
2. Write failing tests for NFC normalization, scalar/UTF-8 byte counts,
   deterministic hashes, missing fixture rejection, and duplicate ID rejection.
3. Write failing tests that private artifacts are mode `0600` and shareable
   output never contains raw text, speaker paths, embeddings, environment
   secrets, or WAV payloads.
4. Implement fixture loading and artifact writers.
5. Re-run the focused tests and inspect the sanitized output.

## Task 3: Implement the public protocol harness

**Files:**

- Create: `.codex/benchmarks/voicedesign_operational/public_protocol.py`
- Create: `.codex/benchmarks/voicedesign_operational/wav_metrics.py`
- Create: `.codex/benchmarks/voicedesign_operational/test_public_protocol.py`
- Create: `.codex/benchmarks/voicedesign_operational/test_wav_metrics.py`

1. Write failing deterministic tests for:
   - request/flush/header/first-byte/handshake/first-PCM/full-body timestamps;
   - the existing line-framed stream protocol;
   - malformed handshake, header, length, index, terminal error, and WAV cases;
   - retry disabled;
   - reused and fresh connection modes as separate series;
   - monotonic timing and sanitized error records.
2. Add WAV tests for sample format, duration, canonical PCM SHA-256, 20 ms
   silence ratio, clipping fraction, integrated loudness, and fixed-version F0
   metadata.
3. Run the focused tests and capture the expected failures.
4. Implement the client without importing Pico production runtime.
5. Re-run focused tests.
6. Run validation-only probes against Windows loopback and the SSH tunnel. Do
   not synthesize during the validation probe.

## Task 4: Implement benchmark planning and statistics

**Files:**

- Create: `.codex/benchmarks/voicedesign_operational/plan.py`
- Create: `.codex/benchmarks/voicedesign_operational/statistics.py`
- Create: `.codex/benchmarks/voicedesign_operational/test_plan.py`
- Create: `.codex/benchmarks/voicedesign_operational/test_statistics.py`

1. Write failing tests for the exact warm core, style mirror order, transport
   ABBA blocks, concurrency `2,4,4,2` blocks, 20 ms wave-skew rejection,
   30-run sequence, resource `off,on,on,off` pass, cold five-cycle plan, and
   fixed seed panels.
2. Write failing tests for median/IQR/min/max, p95 eligibility, paired ratios,
   deterministic bootstrap CI, MAD envelopes, and every optimization guardrail.
3. Implement the pure planners and statistics functions.
4. Re-run focused tests.
5. Confirm new identifiers occur only in the benchmark owner/helper files with
   `rg`.

## Task 5: Capture the no-stop public baseline

**Files:**

- Create at runtime:
  `.codex/artifacts/irodori-voicedesign-operational-<run-id>/baseline-*.json`
- Create at runtime:
  `.codex/artifacts/irodori-voicedesign-operational-<run-id>/private/*.wav`
- Create:
  `.codex/artifacts/irodori-voicedesign-operational-<run-id>/report.md`

1. Confirm the Pico resident LaunchAgent remains unloaded.
2. Confirm the Irodori tunnel and service health.
3. Freeze the immutable profile and fixture manifest.
4. Capture 60 seconds of loaded-idle resource data.
5. Run and discard three short warm-ups.
6. Execute the warm loopback, style, transport, concurrency, 30-run stability,
   and resource-overhead/resource-pass sequences exactly as planned.
7. Write private WAV and raw fixture evidence with mode `0600`.
8. Write only hashes and aggregate metrics to the report.
9. Treat all 2026-07-27 results as historical context, not samples in this
   baseline.

## Task 6: Capture cold and direct-runtime evidence

**Files:**

- Create: `.codex/benchmarks/voicedesign_operational/direct_runtime.py`
- Create: `.codex/benchmarks/voicedesign_operational/windows_session.py`
- Create: `.codex/benchmarks/voicedesign_operational/test_windows_session.py`
- Create on Windows only for the bounded run: a temporary non-HTTP harness
  under a dedicated benchmark directory

1. Write failing tests for the state machine:
   `preflight -> stop-task -> verify-unloaded -> cold-cycles -> direct-run ->
   unload -> restore-task -> health -> smoke`.
2. Write failing tests proving restore is attempted from every post-stop
   failure state and Pico resident is never a target.
3. Implement the controller with explicit target names and bounded waits.
4. Re-run focused tests.
5. Obtain a final pre-stop health snapshot.
6. Stop only `Pico-Irodori-TTS-8924`.
7. Run five process/model-cold cycles.
8. Keep the task stopped, load the exact direct runtime once, and execute:
   - first three calls;
   - fixed warm fixture/style sequence;
   - caption meaning panel;
   - steps, CFG, seed, duration, schedule, KV cache, compile, and decode
     one-factor experiments.
9. Exit the direct runtime and verify GPU memory returns to the pre-load
   envelope.
10. Restore the Scheduled Task, health, and one SSH-tunnel smoke synthesis.
11. Confirm the Pico resident LaunchAgent is still unloaded.

## Task 7: Classify the input contract

**Files:**

- Create:
  `.codex/artifacts/irodori-voicedesign-operational-<run-id>/input-contract.csv`
- Update:
  `.codex/artifacts/irodori-voicedesign-operational-<run-id>/report.md`

1. Produce one row per field with public validation, public mapping, direct
   equivalent, source consumption, behavioral evidence, per-layer
   classification, and skill disposition.
2. Use only `unsupported`, `ignored`, `effective`, or `undetermined`.
3. Keep every `undetermined` control out of skill v1.
4. Verify same-seed audio hashes and repeatability envelopes before interpreting
   cross-seed differences.
5. Complete bounded blind paired listening for style/caption and candidate
   comparisons.

## Task 8: Evaluate optimizations

**Files:**

- Create per candidate:
  `.codex/artifacts/irodori-voicedesign-operational-<candidate-id>/`

1. Evaluate one factor at a time in this order:
   - `num_steps`;
   - model residency/startup behavior;
   - context KV cache;
   - compile;
   - framing/sentence split;
   - queue behavior;
   - HTTP connection reuse.
2. Run the full paired public protocol for every candidate.
3. Reject candidates that miss any error, latency, cold, resource, or quality
   guardrail.
4. Re-run the full protocol for any combination of individually passing
   candidates.
5. Compare Cloudflare only if measured SSH transport overhead is material and
   transport-bound. Reject it if slower or less stable.
6. Preserve rejected candidate evidence; do not overwrite the baseline.

## Task 9: Create the canonical Codex skill

**Canonical directory:**

- `$HOME/Dev/dotfiles/home/.codex/skills/<approved-skill-name>/`

Follow the required `skill-creator` order exactly:

1. **Concrete examples:** derive valid, ambiguous, malicious-extra,
   unsupported-control, wrong-model, over-limit, and default-materialization
   examples from the measured contract.
2. **Reusable resources:** identify the deterministic normalizer/validator,
   profile manifest schema, evaluation fixtures, and concise reference matrix
   that belong in the skill.
3. **Initialization:** run the `skill-creator` initializer in the canonical
   dotfiles skill directory. Do not make a second installed copy.
4. **Implementation:** write English LLM-facing instructions plus the smallest
   validation script and fixtures. The validator must fail closed and emit the
   specified success/error schemas.
5. **quick_validate:** run the system validator and the bundled normalization,
   boundary, enum, seed, unknown-field, default, profile mismatch, and error
   schema checks.
6. **Real use:** invoke the skill on measured Pico/Irodori examples and inspect
   the exact request output before any network send.
7. **Iteration:** invoke `skill-eval-orchestrator` with fresh executors, record
   baseline and candidate outcomes, and iterate until contract violations are
   zero.
8. Update `skill-index.json` only through the canonical symlink distribution
   pattern already used by the dotfiles repository.
9. Run `bash scripts/check-dotfiles.sh` and `npx secretlint .` in the dotfiles
   repository.

## Task 10: Integrate only the proven contract into Pico

**Files:** Determine the minimal file list from the final measured contract
before editing.

1. Write failing Pico tests for the final API/config contract.
2. Preserve explicit Irodori/Aivis selection with no automatic fallback.
3. Apply only the measured default, caller-cancellation, and connection changes.
4. Run focused tests, then `just check`.
5. Run the unchanged public benchmark protocol once more.
6. Document recommended defaults, performance values, known limits, explicit
   provider switch, and rollback.
7. Do not start the resident LaunchAgent as part of verification.

## Completion evidence

- Public and direct field matrix with measured classifications
- Immutable baseline and candidate manifests
- Warm/cold/TTFA/wall/RTF/audio/resource/stability/concurrency/transport data
- Same-text/same-seed paired private WAV and sanitized metadata
- Optimization gate decisions, including rejected candidates
- Canonical skill, quick validation, real-use evidence, and independent skill
  evaluation
- Pico API/config/default/rollback contract
- Passing focused tests and repository gates
