# AGENTS.md

## Why

`pico` is a Pi Agent domain extension that establishes one resident AI support
staff member for an after-school care facility.

The project preserves the durable product position from Wooly-Fluffy archived:
one named facility presence, modular capabilities, and human staff as the final
responsible decision makers.

## What

- Source of truth starts in `docs/superpowers/specs/` and
  `docs/superpowers/research/`.
- Runtime shape is one Pi package with one TypeScript extension.
- Internal modules are TypeScript modules under `src/`.
- Module code uses one folder per module under `src/modules/<module>/index.ts`.
- First-slice runtime modules are metadata/contract modules for context, memory,
  local models, handoff, audit, and transport.
- `long_memory` has a narrow SQLite durable-memory slice for reviewed facility
  knowledge; broader long-memory automation remains future work.
- Planned heavy modules include voice, vision, camera, channels, and broader
  long-memory integrations.
- Vision provider selection is `Qwen/Qwen3.5-9B` through Ollama `qwen3.5:9b`
  running on a protected Windows GPU host.
- The `pico` host reaches the Windows vision host through a Tailscale or
  Cloudflare-protected SSH tunnel; do not assume the VLM runs on the same
  machine as Pi Agent.

## How

- Install dependencies with `npm install`.
- Check `TOOLS.md` before adding, replacing, or bypassing repository tools.
- Run all local gates with `just check`.
- Run focused gates with `just typecheck`, `just lint`, `just ast`, or
  `just test`.
- Format files with `just format`.

## Tool References

- Tool routing and deterministic tool details live in `TOOLS.md`.
- Keep AGENTS.md concise; put detailed tool notes in `TOOLS.md` or the relevant
  config file.

## Boundaries

- Production architecture has no mock, stub, fake, backward-compatibility, or
  automatic fallback provider paths.
- Provider alternatives are explicit future choices, not hidden runtime chains.
- Do not add a custom policy engine as an early architecture layer.
- Remote model access uses protected transport boundaries such as Tailscale ACLs
  or Cloudflare Access/Tunnel, not exposed inbound model ports.
- Human staff remain responsible for discipline, emergencies, safeguarding,
  parental communication, and final decisions.
- Do not design durable memory around child tracking, scoring, or profiling.

## Deterministic Checks

- TypeScript strictness lives in `tsconfig.json`.
- Type-aware linting lives in `eslint.config.ts`.
- Formatting lives in `biome.json`.
- Project-specific structural rules live in `sgconfig.yml` and `rules/`.
