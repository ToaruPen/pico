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
- Pi owns the production process, non-persistent host session, every interaction
  AgentSession, conversation context and history, model loop, tools, subagents,
  normal cancellation, and all memory capabilities. Pico owns interaction
  timing, facility audio, address/attention rules, TTS/echo control, and
  facility runtime restrictions.
- Durable memory, when enabled, is provided by a separately installed Pi-level
  plugin. That plugin owns provider configuration, extraction, persistence,
  retrieval, mutation, retention, and lifecycle. Pico does not register,
  configure, wrap, proxy, or call memory tools or providers, and Pico
  interaction ending has no memory side effect.
- Normal Pi starts without the resident controller. `pi --no-session --pico`
  starts Pico in a non-persistent Pi-owned host runtime; the `pico` command is
  only a convenience alias for that path. Pico's model is selected from YAML at
  startup, and each timed interaction uses one Pi-owned in-memory AgentSession.
- Tool visibility for normal Pi, Pico, and subagents is owned by Pi settings.
  Do not duplicate those allowlists in Pico runtime profiles or tests.
- Internal modules are TypeScript modules under `src/`.
- Module code uses one folder per module under `src/modules/<module>/index.ts`.
- Runtime modules cover context, interaction-session control, local models,
  handoff, audit, transport, voice, vision, camera, and channels.
- Scene vision provider and camera source are selected explicitly at startup.
  The `agent` provider sends one bounded image to the current image-capable Pi
  Agent model; the `ollama` provider retains `Qwen/Qwen3.5-9B` through
  `qwen3.5:9b`. Provider fallback is prohibited.
- When the Ollama scene provider is selected, the `pico` host reaches the
  Windows vision host through a Tailscale or Cloudflare-protected SSH tunnel;
  do not assume that VLM runs on the same machine as Pi Agent.

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
- Pi SDK AgentSession creation is confined to `src/runtime/pi-agent-turn.ts`.
  Production and the direct `npm run resident:voice` field harness share that
  Pi integration boundary; Pico domain modules do not create or persist
  AgentSessions.
- Hard-kill residue is reviewed by the scheduled Codex stale-process cleanup.
  Do not add task auto-resume, a custom worker runner, or a TaskRun store to the
  Pico runtime for process cleanup.
- Provider selection is an explicit startup choice, never a hidden runtime
  chain or automatic fallback.
- Do not add a custom policy engine as an early architecture layer.
- Remote model access uses protected transport boundaries such as Tailscale ACLs
  or Cloudflare Access/Tunnel, not exposed inbound model ports.
- Human staff remain responsible for discipline, emergencies, safeguarding,
  parental communication, and final decisions.
- Do not design durable memory around child tracking, scoring, or profiling.
- Do not add short-term or durable-memory stores, extraction workers,
  memory-search tools, Mem0/Qdrant clients, or cutoff-memory hooks to Pico.

## Deterministic Checks

- TypeScript strictness lives in `tsconfig.json`.
- Type-aware linting lives in `eslint.config.ts`.
- Formatting lives in `biome.json`.
- Project-specific structural rules live in `sgconfig.yml` and `rules/`.
