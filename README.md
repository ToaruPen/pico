# pico

`pico` is a Pi Agent-centered domain extension for one resident AI support staff
member in an after-school care facility.

The repository is in foundation stage. It currently defines the package shape,
module boundaries, quality gates, and active provider decisions.

## Development

Use Node.js 24 or newer. CI runs on Node 24.

Install dependencies:

```bash
npm install
```

Run all local checks:

```bash
just check
```

Run the same parallel gate shape used by CI:

```bash
just ci
```

Run the optional live Tapo RTSP snapshot smoke. Without `PICO_TAPO_HOST`, the
command exits successfully with an explicit skipped report:

```bash
just smoke-camera-tapo
```

To capture one JPEG frame from a Tapo RTSP source:

```bash
PICO_TAPO_HOST=192.168.10.25 \
PICO_TAPO_USER=your-camera-user \
PICO_TAPO_PASSWORD=your-camera-password \
PICO_TAPO_STREAM=stream2 \
just smoke-camera-tapo
```

Run the optional protected Ollama VLM connectivity smoke. Without
`PICO_VISION_LOCAL_BASE_URL`, the command exits successfully with an explicit
skipped report:

```bash
just smoke-ollama-vlm
```

To verify `qwen3.5:9b` through a local protected tunnel:

```bash
PICO_VISION_LOCAL_BASE_URL=http://127.0.0.1:11434 \
PICO_VISION_TUNNEL_KIND=tailscale_ssh \
PICO_VISION_SSH_TARGET=pico-vision-host \
just smoke-ollama-vlm
```

See:

- `AGENTS.md` for agent-facing repository guidance.
- `TOOLS.md` for tool references.
- `docs/superpowers/specs/2026-06-09-pico-agent-design.md` for product and
  module boundaries.
- `docs/superpowers/plans/2026-06-09-pico-foundation-implementation-plan.md`
  for the current implementation plan.
