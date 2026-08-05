# TOOLS.md

## Purpose

This file is the tool reference for `pico`. Check it before adding, replacing,
or bypassing repository tools.

Keep tool behavior encoded in deterministic configs where possible. Do not move
lint rules, formatting rules, or structural checks into prose-only agent
instructions.

## Task Entry Points

- `just --list`: show available repo tasks.
- `just check`: run the full local gate.
- `just ci`: run the Linux CI job's parallel TypeScript gate shape locally.
- `just apple-speech-check`: run the isolated macOS 26 Swift sidecar gate.
- `just macos-resident-io-check`: lint, test, and release-build the integrated
  macOS keyboard/AVAudioEngine resident I/O sidecar with warnings as errors.
- `just macos-resident-io-build`: build the production resident I/O executable
  at the path used by the Node managed-child bridge.
- `just macos-resident-audio-probe --duration-seconds 30 --device-uid <uid>`: collect bounded
  pre-implementation/field measurements for callback cadence, common host
  clock alignment, CPU, and configuration notifications. It opens the real
  microphone and must not run while another Pico checkout owns resident audio.
- `just typecheck`: run TypeScript type checking.
- `just lint`: run type-aware ESLint.
- `just ast`: run ast-grep rule tests and scans.
- `just test`: run Vitest.
- `just format`: apply Biome formatting.
- `npm run field:stackchan-camera-grid -- --enable-live-run --model-path <onnx> --report-output <json>`:
  move StackChan through the bounded home/left/right optical grid, capture one
  CoreS3 frame per pose, run PINTO 441-S Dist head/face detection, and write only
  aggregate quality/detection metadata. The report file is mode `0600` and
  contains no image; Pico deletes each validated source capture after its
  bounded read without touching older or adjacent gateway captures.
- `npm run field:stackchan-center-calibration -- --enable-live-run --duration-ms <ms> --max-frames <n> --minimum-target-frames <n> --model-path <onnx> --report-output <json>`:
  verify StackChan reaches its configured home pose, process at least 20 new
  CoreS3 camera sequences, verify the final home readback, and atomically write
  aggregate PINTO head/face centering metrics without saving images. Failed
  reports retain a bounded failure code and any safe aggregate already observed,
  but never raw errors or individual detections.
- `npm run field:stackchan-face-follow -- --enable-live-run --duration-ms <ms> --max-frames <n> --model-path <onnx> --report-output <json>`:
  run bounded conversation-style StackChan head/face following, drain the
  active inference, return home, and write aggregate runtime metadata.
- `npm run field:stackchan-motion-continuity -- --enable-live-run --report-output <json>`:
  drive the live head through a bounded monotonic triangle wave using the
  production latest-only target lane, sample aggregate yaw continuity at
  20 ms intervals, return home, and write a mode-`0600` report without
  retaining a position timeline.
- `npm run field:stackchan-head-target-lane -- --enable-live-run --duration-ms <ms> --update-hz <hz> --status-hz <hz> --report-output <json>`:
  stress the latest-only head-target lane at explicit update and status rates,
  restore home, and write aggregate latency, rate, depth, and safety metrics.
- `npm run field:stackchan-attention-replay -- --report-output <absolute-json> --repeat 3 --producer-source-hash <sha256> [--step-quantization round|error-feedback]`:
  run the deterministic attention-controller replay and write its
  schema-validated aggregate comparison report. Inspect `--help` before use
  because qualification inputs and output paths are explicit.
- `npm run field:stackchan-attention-replay-evidence -- build <required flag/value pairs>`:
  build or verify a private deterministic replay evidence bundle from explicit
  report, source, contract, and output paths.
- `npm run field:stackchan-target-filter-evaluation -- --report-output <json>`:
  evaluate the fixed-seed target-filter grid and atomically write the selected
  candidate and aggregate acceptance metrics without camera or device access.

## Deterministic Tooling

- TypeScript: `tsconfig.json`.
- ESLint: `eslint.config.ts`.
- Biome: `biome.json`.
- ast-grep: `sgconfig.yml`, `rules/`, and `rule-tests/`.
- Vitest: `vitest.config.ts` and `tests/`.
- npm package and Pi extension metadata: `package.json`.
- GitHub Actions CI: `.github/workflows/ci.yml`.
- CI parallel gate runner: `scripts/ci/run-quality-gates.sh`; it runs local
  tool binaries directly and prints a per-gate timing summary for CI scaling
  decisions.

## Project-Specific Checks

- `rules/no-test-doubles.yml`: blocks mock/stub/fake/fallback identifiers in
  source and tests.
- `rules/no-automatic-fallback.yml`: blocks try/catch provider fallback chains.
- `rules/no-token-bearing-mcp-redirect.yml`: requires token-bearing MCP HTTP
  transports to reject redirects.

If a repeated review rule can be expressed structurally, add or update an
ast-grep rule and test instead of relying on AGENTS.md prose.

## Real-Provider Field Validation

Use this order for resident voice measurements so environment failures do not
consume a benchmark series or become accepted evidence:

1. Before an exclusive microphone, port, or lock check, inspect running Pico
   processes and ask the operator to coordinate if another checkout is active.
   Never stop it implicitly.
2. Run focused tests and type/lint checks while iterating, including
   `just macos-resident-io-check` on macOS.
3. Run the bounded resident audio probe, then
   `npm run field:resident-hold-to-talk`, and retain only aggregate timing,
   cadence, health, dropped-frame, CPU, and memory metadata. Do not retain PCM.
4. Run `just smoke-voice-providers` for Apple Speech and the configured TTS
   provider. Inspect its JSON and require both sections to have
   `status: passed`; `skipped` is not a successful preflight and stops the
   validation ladder even though the generic smoke command exits zero.
5. Run one strict full-turn pseudo-audio smoke with the canonical fixture hash,
   required tool, private validation output, and `--report-output`.
6. Do not benchmark until that metadata report has `status: passed`.
7. Without changing code, config, or fixture, collect at least three sequential
   runs. Do not run provider benchmarks concurrently.
8. Report Pi time-to-first-text separately from Pico stages so model variation
   is not attributed to Pico.
9. Run `just check` and Secretlint on the final tree.

Shared raw stdout is not an evidence boundary because Pi-level extensions may
write to it. Use the field-owned `--report-output` file as authoritative
metadata evidence. If a diagnostic display pipeline uses `tee`, enable
`set -o pipefail`; never adopt the raw `tee` output as the report artifact.

## Runtime Tooling Decisions

- Pi Agent package entry: `package.json` `pi.extensions`.
- Module layout: one folder per module under `src/modules/<module>/index.ts`.
- Scene vision provider is selected explicitly by
  `vision.sceneDescription.provider`: `agent` sends one bounded image tool
  result to the active image-capable Pi/Codex model; `ollama` keeps the
  protected `Qwen/Qwen3.5-9B` route. There is no provider fallback.
- Vision host: protected Windows GPU host reached through Tailscale or
  Cloudflare-protected SSH tunneling.
- STT provider: Apple Speech through the loopback Swift sidecar.
- Resident STT transport: one WebSocket and one `SpeechAnalyzer` per accepted
  PTT turn. Node coalesces accepted PCM into bounded 100 ms messages; Swift
  keeps a byte-bounded analyzer input queue. `/v1/transcriptions` remains for
  warmup and finite smoke only and is not a production fallback.
- macOS resident input and physical F-key control: one managed
  `pico-macos-resident-io` Swift sidecar with a continuously running
  AVAudioEngine, stable Core Audio UID selection, and binary stdin/stdout IPC.
- TTS provider: Irodori VoiceDesign through the protected Windows tunnel.
  Aivis Speech remains an explicit configuration rollback.
- Camera candidate: Tapo C210 through RTSP first, ONVIF only when bounded PTZ is
  needed.
- StackChan CoreS3 camera/head access uses the authenticated loopback
  `stackchan-mcp` Streamable HTTP endpoint. Bearer token values stay in the
  configured environment variable. PINTO 441-S Dist provides local head/face
  coordinates only; Pico does not identify or persist people.
- Identity Registry XLSX processing: use ExcelJS with the fixed local roster
  schema and ordinary file/row/cell bounds. Do not add a custom ZIP parser.

## Reference Documents

- Product and module boundaries:
  `docs/superpowers/specs/2026-06-09-pico-agent-design.md`.
- Dependency and runtime research:
  `docs/superpowers/research/2026-06-09-pico-module-dependency-survey.md`.
- Implementation plan:
  `docs/superpowers/plans/2026-06-09-pico-foundation-implementation-plan.md`.
