# Resident Voice OpenTelemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export the resident voice stage contract to private JSONL, batched OpenTelemetry Logs, and OpenTelemetry Metrics while adding the missing latency boundaries needed to diagnose response delay.

**Architecture:** `VoiceStageProbe` remains the only measurement source. A telemetry owner consumes the resulting validated `AuditEvent`, emits one LogRecord for every audit event, records low-cardinality voice stage Histograms and Counters, and owns bounded flush/shutdown plus export health. The resident runner fans each event out to the existing file sink and the optional OTel sink without awaiting network I/O.

**Tech Stack:** TypeScript 6, Vitest 4, OpenTelemetry JavaScript 2.8/0.219, OTLP HTTP, Pi Agent SDK, YAML, Biome, ESLint, ast-grep

---

## Task 1: Replace the logs-only configuration contract

**Files:**
- Modify: `src/config/index.ts`
- Modify: `config/pico.example.yaml`
- Modify: `tests/config.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Add failing configuration tests**

Add tests that load this exact contract and reject non-loopback origins, paths, credentials, and export intervals that do not exceed the export timeout:

```ts
telemetry:
  otel:
    enabled: true
    baseUrl: http://127.0.0.1:4318
    serviceName: pico
    timeoutMs: 10000
    metricExportIntervalMs: 15000
    shutdownTimeoutMs: 5000
```

Assert that omitted configuration returns `{ otel: { enabled: false } }`. Assert that the old
`audit.otel` input is rejected with the deterministic migration error
`pico config audit.otel was removed; use telemetry.otel` rather than silently used.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run tests/config.test.ts -t "telemetry OTel"
```

Expected: FAIL because `PicoConfig` has no `telemetry` section and still parses `audit.otel`.

- [ ] **Step 3: Install the Metrics SDK dependencies**

Run:

```bash
npm install @opentelemetry/exporter-metrics-otlp-http@^0.219.0 @opentelemetry/sdk-metrics@^2.8.0
```

- [ ] **Step 4: Implement the configuration boundary**

Replace `PicoConfig["audit"]["otel"]` with:

```ts
export type PicoTelemetryOtelConfig = {
  readonly enabled: boolean;
  readonly baseUrl?: string;
  readonly serviceName?: string;
  readonly timeoutMs?: number;
  readonly metricExportIntervalMs?: number;
  readonly shutdownTimeoutMs?: number;
};
```

Validate a pathless loopback `http:` or `https:` origin and require
`metricExportIntervalMs > timeoutMs` when enabled. Default enabled values are service name `pico`,
timeout `10_000`, metric interval `15_000`, and shutdown timeout `5_000`.

- [ ] **Step 5: Verify GREEN**

Run `npx vitest run tests/config.test.ts`. Expected: PASS.

## Task 2: Build the batched Logs and Metrics telemetry owner

**Files:**
- Create: `src/modules/telemetry/index.ts`
- Create: `tests/telemetry.test.ts`
- Modify: `src/modules/audit/otel.ts`
- Modify: `tests/audit-otel-exporter.test.ts`

- [ ] **Step 1: Add failing provider tests**

Define test exporters that implement the real OpenTelemetry exporter interfaces and assert that:

```ts
telemetry.record(stageEvent);
await telemetry.forceFlush();
```

produces one LogRecord, one `pico.voice.stage.duration` Histogram data point with unit `ms`, and one
`pico.voice.stage.completions` Counter data point. Assert attributes contain only
`pico.voice.stage` and `pico.voice.stage_status`. Add tests for ordinary non-voice audit Logs,
export failure health snapshots, non-throwing record after an export failure, bounded shutdown, and
idempotent shutdown.

- [ ] **Step 2: Verify RED**

Run `npx vitest run tests/telemetry.test.ts`. Expected: FAIL because the telemetry module does not exist.

- [ ] **Step 3: Implement the provider**

Create this public contract:

```ts
export type PicoTelemetry = {
  readonly record: (event: AuditEvent) => void;
  readonly forceFlush: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
  readonly health: () => TelemetryHealthSnapshot;
};
```

Use `BatchLogRecordProcessor`, `MeterProvider`, `PeriodicExportingMetricReader`,
`OTLPLogExporter`, and `OTLPMetricExporter`. Wrap both exporters to observe their real
`ExportResult` callbacks without creating a Promise per event. Set fixed batch queue limits and use
the config timeout for exporter and processor timeouts. `record()` must synchronously enqueue and
return. `forceFlush()` and `shutdown()` must be bounded by `shutdownTimeoutMs`, report failures through
a metadata-only diagnostic callback, and never create an unbounded operation queue.

- [ ] **Step 4: Remove the old logs-only provider**

Delete `src/modules/audit/otel.ts` after moving generic OTel ownership into the telemetry module.
Update or replace `tests/audit-otel-exporter.test.ts` so audit mapping remains covered by
`tests/audit.test.ts` and provider behavior is owned by `tests/telemetry.test.ts`.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx vitest run tests/telemetry.test.ts tests/audit.test.ts
```

Expected: PASS.

## Task 3: Wire telemetry into resident and command lifecycles

**Files:**
- Modify: `src/runtime/resident-voice-runner.ts`
- Modify: `src/runtime/resident-voice-audit-log.ts`
- Modify: `scripts/roster.ts`
- Modify: `scripts/smoke/milestone-suite.ts`
- Modify: `tests/resident-voice-runner.test.ts`
- Modify: `tests/resident-voice-audit-log.test.ts`
- Modify: `tests/milestone-smoke.test.ts`

- [ ] **Step 1: Add failing fan-out and lifecycle tests**

Expose a focused resident telemetry lifecycle helper and assert:

```ts
const pipeline = createResidentVoiceTelemetryPipeline({ fileLog, telemetry });
pipeline.audit.record(stageInput);
expect(fileEvents).toHaveLength(1);
expect(otelEvents).toHaveLength(1);
await pipeline.shutdown();
```

Add cases proving one sink failure does not block the other, disabled OTel does not construct a
provider, shutdown is awaited once, and shutdown failure is written as bounded process metadata but
does not reject the resident voice lifecycle.

- [ ] **Step 2: Verify RED**

Run focused runner and audit tests. Expected: FAIL because the runner creates only the file sink.

- [ ] **Step 3: Implement non-blocking fan-out and bounded shutdown**

Create the OTel provider only when `config.telemetry.otel.enabled` is true. The synchronous audit
callback writes private JSONL first and then calls `telemetry.record(event)` inside an isolated sink
boundary. Resident shutdown awaits `telemetry.shutdown()` after voice resources settle and converts
telemetry failure into one fixed process-log diagnostic.

Migrate roster and milestone smoke to `telemetry.otel` and the new provider. The smoke must emit one
ordinary audit event and one `voice.runtime.stage` event, then force-flush both signals.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npx vitest run tests/resident-voice-runner.test.ts tests/resident-voice-audit-log.test.ts tests/milestone-smoke.test.ts
```

Expected: PASS.

## Task 4: Add Pi first-text, setup, tool, and disposal timing

**Files:**
- Modify: `src/runtime/voice-stage-probe.ts`
- Modify: `src/runtime/pi-agent-turn.ts`
- Modify: `tests/voice-stage-probe.test.ts`
- Modify: `tests/pi-agent-turn.test.ts`

- [ ] **Step 1: Add failing stage contract tests**

Add the fixed stages `pi_time_to_first_text`, `pi_session_resource_load`, `pi_session_create`,
`pi_session_bind`, `pi_tool_execution`, and `pi_session_dispose`. Test their persistence and summary
policies through the single registry.

- [ ] **Step 2: Add failing Pi timing tests**

Use an injected monotonic clock and SDK session event source to prove:

- first non-empty `message_update/text_delta` records TTFT once;
- prompt settlement without text records `skipped` or `error` once;
- resource reload, session factory, bind/tool enforcement, and disposal each record settlement time;
- matching `tool_execution_start` and `tool_execution_end` events record one anonymous tool duration;
- unmatched or duplicate tool end events emit no duplicate measurement;
- cancel and failure settle every started stage with fixed error codes and no tool/session identifiers.

- [ ] **Step 3: Verify RED**

Run focused Pi and probe tests. Expected: FAIL because the new stages and observers do not exist.

- [ ] **Step 4: Implement the Pi instrumentation**

Add `now` and `monotonicNow` dependencies to `PiAgentTurnClientOptions`. Capture TTFT at the beginning
of `prompt()` before child session lookup so first-turn setup is included. Extend the existing
subscription parser for `tool_execution_start` and `tool_execution_end`, keeping tool call IDs only
in a per-prompt in-memory map. Wrap resource reload, SDK factory, extension bind/tool enforcement,
and shutdown/dispose with the same `recordVoiceStageProbe()` contract.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx vitest run tests/pi-agent-turn.test.ts tests/voice-stage-probe.test.ts
```

Expected: PASS.

## Task 5: Add PTT-to-playback and interaction-ending timing

**Files:**
- Modify: `src/runtime/voice-resident.ts`
- Modify: `src/runtime/voice-stage-probe.ts`
- Modify: `tests/voice-resident.test.ts`
- Modify: `tests/resident-voice-measurements.test.ts`

- [ ] **Step 1: Add failing end-to-end stage tests**

Use the existing deterministic control scheduler and monotonic clock to assert:

- an accepted `talk_released` starts `ptt_release_to_playback_start`;
- the stage ends immediately before the first playback provider call;
- empty speech, cancellation, STT failure, Pi failure, and TTS failure settle it exactly once;
- farewell playback does not create a PTT latency event;
- lifecycle ended notification through farewell, deferred cancellation, Pi disposal, and record
  removal records one `interaction_end` event;
- cancellation and cleanup failure settle `interaction_end` once with a fixed error code.

- [ ] **Step 2: Verify RED**

Run the named tests and confirm failure from missing stage events.

- [ ] **Step 3: Implement both boundaries**

Store accepted release wall/monotonic time on the active turn after the control state machine accepts
`talk_released`. Settle the PTT stage at first playback dispatch or the terminal no-playback path.
Capture interaction-ending start time when the lifecycle ended notification is accepted and settle
after record removal. Do not use event wall-clock differences for duration.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npx vitest run tests/voice-resident.test.ts tests/resident-voice-measurements.test.ts tests/voice-stage-probe.test.ts
```

Expected: PASS.

## Task 6: Add Collector operations and pseudo-audio measurement

**Files:**
- Create: `config/otel-collector.example.yaml`
- Create: `scripts/smoke/otel-telemetry.ts`
- Create: `tests/otel-telemetry-smoke.test.ts`
- Modify: `package.json`
- Modify: `Justfile`
- Modify: `README.md`
- Modify: `scripts/field/resident-hold-to-talk.ts`
- Modify: `tests/resident-hold-to-talk-field.test.ts`

- [ ] **Step 1: Add failing smoke and field-plan tests**

Assert that the repository exposes `smoke:otel-telemetry`, the Collector example binds OTLP HTTP
only to `127.0.0.1:4318`, and the field harness accepts a bounded PCM/WAV injection input without
adding a production fallback provider.

- [ ] **Step 2: Verify RED**

Run the smoke and field-plan tests. Expected: FAIL because the entries and files are absent.

- [ ] **Step 3: Implement the bounded operations surface**

The OTel smoke loads enabled telemetry config, emits a metadata-only voice stage event, force-flushes,
prints the health snapshot, and shuts down. The Collector example includes `memory_limiter`, `batch`,
loopback OTLP HTTP, a loopback Prometheus exporter, and a file/debug Logs exporter without public
listeners.

Extend the existing field harness only at its constructor/CLI test seam so a finite local PCM/WAV
fixture can replace microphone frames during explicit field validation. Production resident config
must still have no automatic fallback or injected-audio provider.

The full-turn pseudo-audio harness also creates an explicit mode-0600 private validation JSONL under
a current-user-owned, non-symlink, mode-0700 directory and refuses an existing output file. It
records recognized text, Pi response text, and Pi SDK tool start/end bodies (name, arguments, result,
error status, and duration). This contentful artifact is never sent to audit, normal resident logs,
or OTel. It is required because timing alone cannot prove recognition or tool correctness.
When a required tool name is supplied, the harness passes only after that tool produces a non-error
end event; transcript and response events alone are insufficient.

- [ ] **Step 4: Verify GREEN**

Run focused smoke and field tests. Expected: PASS.

## Task 7: Verify, polish, publish, and measure

**Files:**
- Modify only files required by deterministic formatting, review findings, PR metadata, and the
  field evidence report.
- Create: `docs/superpowers/research/2026-07-19-resident-voice-opentelemetry-validation.md`

- [ ] **Step 1: Search the final ownership boundaries**

Run:

```bash
rg -n "audit\.otel|telemetry\.otel|voice\.runtime\.stage|pico\.voice\.stage\.duration|pi_time_to_first_text|ptt_release_to_playback_start" src tests scripts config docs/superpowers/specs
```

Confirm old config ownership is removed, fixed stage literals occur only in the registry, tests,
and specifications, and no transcript/audio/session identifier enters telemetry attributes.

- [ ] **Step 2: Run focused tests and the full gate**

Run `just format`, all focused Vitest files, then `just check`. Expected: PASS.

- [ ] **Step 3: Apply cleanup skills**

Run `polishment` and `ai-slop-cleaner` only on this plan's changed files. Re-run `just check` after
behavior-preserving cleanup.

- [ ] **Step 4: Commit and push**

Stage the scoped files, inspect the staged diff, commit with a Conventional Commit message, and push
`codex/resident-latency-observability`. Update the existing draft PR rather than creating a duplicate.

- [ ] **Step 5: Execute pseudo-audio validation**

With a local Collector available, inject the finite Japanese voice fixture through the field harness,
capture the resulting private metrics JSONL and OTel health snapshot, calculate per-stage wall time
and PTT-to-playback time, and compare OTel metric samples with JSONL values. If no Collector binary is
installed, execute the same field injection with JSONL plus in-process recording exporters and state
the external Collector limitation explicitly rather than installing system software automatically.

- [ ] **Step 6: Record evidence and converge the PR**

Write exact commands, timestamps, fixture properties, stage measurements, export health, and any
remaining optimization findings in the validation report. Commit and push the evidence update, then
inspect PR checks and review feedback until the current head is converged or a concrete external
blocker is proven.
