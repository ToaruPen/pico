# Pico Agent Design

Date: 2026-06-09
Status: Draft

## Purpose

`pico` is a Pi Agent domain extension that turns Pi Agent into a resident AI
support staff member for an after-school care facility.

The goal is not to rebuild Wooly-Fluffy as a fixed voice/camera system. The
goal is to preserve Wooly-Fluffy's core product position: a named, consistent
presence that belongs to the facility and supports children and human staff as
part of the everyday care environment.

## Source Context

This design keeps the durable intent from Wooly-Fluffy archived materials:

- The agent is not merely a screen character, chatbot, or utility.
- The agent exists as part of the facility environment.
- The agent has a name, personality, and stable relationship with children and
  staff.
- The agent supports the care setting without replacing human staff.
- The agent should avoid individual tracking, evaluation, or profiling of
  children.

Wooly-Fluffy implementation details are reference material only, not `pico`
requirements.

## Product Position

`pico` is one AI support staff member.

It should be understandable to children as a named presence with a stable
personality. It should also be understandable to adult staff as a tool-backed
assistant that can help with conversation, observation, reminders, summaries,
facility knowledge, and handoff preparation.

`pico` does not become the responsible adult. Human staff remain responsible for
discipline, emergency judgment, parental communication, safeguarding decisions,
and final interpretation of child welfare concerns.

## Architecture Position

Pi Agent is the resident agent harness.

`pico` is a single Pi Agent extension package. It owns the domain identity and
coordinates internal modules. Capabilities are modular, but the agent identity
is not fragmented across modules.

```text
Pi Agent
  └─ pico
      ├─ identity
      ├─ orchestrator
      ├─ context
      ├─ session
      ├─ local_models
      ├─ voice
      ├─ vision
      ├─ camera
      ├─ channels
      ├─ handoff
      ├─ audit
      └─ transport
```

Pi owns the non-persistent host session, interaction AgentSessions, transcript,
context, history, tools, and subagents. Durable memory, when enabled, is
provided by a separately installed Pi-level plugin. Pico does not configure,
register, wrap, proxy, or call memory providers or tools.

## Module Responsibilities

### identity

Defines the agent's name, personality, tone, relationship to children, and
relationship to human staff.

This module owns the agent's durable self-description and the prompt material
that makes `pico` behave like one consistent support staff member.

### orchestrator

Coordinates module calls and runtime state.

This should stay small. It should route events and tool calls, manage active
interaction state, and prevent modules from becoming a tangled control plane.

### context

Provides facility context such as rules, schedules, activity plans, room
information, staff-provided notes, and operational knowledge.

### session

Keeps process-local interaction-control state for activation, inactivity timing,
farewell, deferred-tool cancellation, and Pi session cleanup. It does not store
conversation entries, summaries, or memory-cutoff payloads.

### local_models

Provides local model capabilities around Pi Agent.

The design goal is local-first for surrounding cognition where practical, while
allowing explicit provider choices when local models would compromise accuracy,
latency, or machine capacity. Aside from the Pi Agent brain itself, supporting
model work such as speech, vision, or classification should name its provider
and runtime boundary directly.

`local` does not require every model to run on the same host as Pi Agent. The
vision model is expected to run on a Windows GPU host and be reached through a
protected Tailscale or Cloudflare SSH tunnel. From `pico`'s perspective this is
still a selected local-first provider, not a cloud model and not an automatic
provider chain.

### voice

Provides voice input and output capabilities.

Voice is a capability module, not the identity of the product. `pico` should be
able to exist even before the final voice pipeline is chosen.

### vision

Provides image and scene understanding.

This module should expose bounded scene-understanding capabilities rather than
unrestricted image inspection.

The selected first vision provider is Qwen/Qwen3.5-9B via Ollama
`qwen3.5:9b`, running on a Windows GPU host. `pico` should reach it through a
protected SSH tunnel provided by Tailscale or Cloudflare, with no public model
port exposure.

### camera

Provides camera operation and observation control.

Camera operation should remain capability-driven and purpose-limited. Specific
hardware choices and camera-control protocols are deferred.

### channels

Provides external communication channels.

LINE is a likely channel for notifications and record delivery, and OpenClaw may
be useful reference material. This design does not yet specify LINE transport or
message shape. Channels should remain replaceable.

### handoff

Prepares information for human staff.

This includes summaries, suggested follow-up, notification drafts, and
escalation handoff text. Human staff remain the responsible decision makers.

### audit

Records operationally important actions.

Audit should focus on traceability for tool calls, external sends, and module
decisions that affect the facility. It should not become a full transcript
store by default.

### transport

Owns protected communication boundaries.

The initial expectation is protected Cloudflare-based communication where remote
or cross-device access is needed. The project should prioritize concrete
transport protection over a custom policy engine.

Protected transport also covers remote local-model access. The Windows vision
host should be reachable through Tailscale ACLs or Cloudflare Access/Tunnel
rather than an exposed Ollama port.

## Non-Goals

- Do not create a separate complex `policy` module or rules engine as an early
  architecture layer.
- Do not add short-term or durable-memory implementation to Pico.
- Do not split `pico` into many separate Pi plugins before the identity and
  module contract are stable.
- Do not design the agent as a child-monitoring, scoring, or profiling system.

## Design Principles

- One agent identity, many capability modules.
- Local-first surrounding cognition.
- Protected transport over bespoke policy machinery.
- Human staff keep final responsibility.
- Capabilities can expand; responsibility boundaries should not silently expand.
- Any independently installed durable-memory capability must not be designed for
  child tracking, scoring, or profiling.
- External channels are output surfaces, not the core architecture.
- No test-double modules, compatibility layers, or automatic provider switching
  in production architecture. Providers are selected explicitly.

## Initial Implementation Shape

The first implementation should establish the package skeleton and contracts,
not the full facility runtime.

Suggested first slice:

1. Create the `pico` Pi extension package structure.
2. Add `identity` prompt material and a minimal module registry.
3. Add a small `orchestrator` that can call real metadata-only first-slice
   modules through typed contracts.
4. Add first-slice modules for `context`, `session`, `local_models`, `handoff`,
   `audit`, and `transport`.
5. Keep `voice`, `vision`, `camera`, and `channels` as explicit future modules
   with contracts but no runtime implementation until their real dependencies
   are selected and reachable.

## Open Decisions

- Agent name and personality details.
- Exact Pi SDK versus Pi extension loading boundary.
- Whether the first running slice is CLI-only, daemon-like, or a small local
  service.
- Where protected Cloudflare transport is required in the first milestone.
- Which local LLM/runtime should back `local_models`.
- Which LINE/OpenClaw integration pattern, if any, should be adopted later.
