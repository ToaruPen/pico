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
- Long-memory LLM provider: Pi Agent `openai-codex` through
  `openai-codex-responses` when configured.
- Long-memory embedding provider: explicit local-default provider; do not mix
  embedding model families in one vector collection.
- Long-memory embedding primary candidate: `jinaai/jina-embeddings-v5-text-small`
  through an explicit local sidecar provider.
- Long-memory embedding comparison candidates: `jinaai/jina-embeddings-v5-text-nano`
  for a lighter Jina runtime, `bge-m3` for Ollama-native operation,
  `Qwen3-Embedding-0.6B` for Ollama A/B testing, and `ruri-v3-310m` as the
  Japanese-specialized control model.

## Reference Documents

- Product and module boundaries:
  `docs/superpowers/specs/2026-06-09-pico-agent-design.md`.
- Dependency and runtime research:
  `docs/superpowers/research/2026-06-09-pico-module-dependency-survey.md`.
- Implementation plan:
  `docs/superpowers/plans/2026-06-09-pico-foundation-implementation-plan.md`.
