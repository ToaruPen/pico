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
- `just typecheck`: run TypeScript type checking.
- `just lint`: run type-aware ESLint.
- `just ast`: run ast-grep rule tests and scans.
- `just test`: run Vitest.
- `just format`: apply Biome formatting.

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

If a repeated review rule can be expressed structurally, add or update an
ast-grep rule and test instead of relying on AGENTS.md prose.

## Real-Provider Field Validation

Use this order for resident voice measurements so environment failures do not
consume a benchmark series or become accepted evidence:

1. Run focused tests and type/lint checks while iterating.
2. Run `just smoke-voice-providers` for Apple Speech and AivisSpeech
   reachability. Inspect its JSON and require both sections to have
   `status: passed`; `skipped` is not a successful preflight and stops the
   validation ladder even though the generic smoke command exits zero.
3. Run one strict full-turn pseudo-audio smoke with the canonical fixture hash,
   required tool, private validation output, and `--report-output`.
4. Do not benchmark until that metadata report has `status: passed`.
5. Without changing code, config, or fixture, collect at least three sequential
   runs. Do not run provider benchmarks concurrently.
6. Report Pi time-to-first-text separately from Pico stages so model variation
   is not attributed to Pico.
7. Run `just check` and Secretlint on the final tree.

Shared raw stdout is not an evidence boundary because Pi-level extensions may
write to it. Use the field-owned `--report-output` file as authoritative
metadata evidence. If a diagnostic display pipeline uses `tee`, enable
`set -o pipefail`; never adopt the raw `tee` output as the report artifact.

## Runtime Tooling Decisions

- Pi Agent package entry: `package.json` `pi.extensions`.
- Module layout: one folder per module under `src/modules/<module>/index.ts`.
- Vision provider: `Qwen/Qwen3.5-9B` through Ollama `qwen3.5:9b`.
- Vision host: protected Windows GPU host reached through Tailscale or
  Cloudflare-protected SSH tunneling.
- STT provider: Apple Speech through the loopback Swift sidecar.
- TTS candidate: Aivis Speech.
- Camera candidate: Tapo C210 through RTSP first, ONVIF only when bounded PTZ is
  needed.
- Identity Registry XLSX processing: use ExcelJS with the fixed local roster
  schema and ordinary file/row/cell bounds. Do not add a custom ZIP parser.

## Reference Documents

- Product and module boundaries:
  `docs/superpowers/specs/2026-06-09-pico-agent-design.md`.
- Dependency and runtime research:
  `docs/superpowers/research/2026-06-09-pico-module-dependency-survey.md`.
- Implementation plan:
  `docs/superpowers/plans/2026-06-09-pico-foundation-implementation-plan.md`.
