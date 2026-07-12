# Autonomous Long-Memory Retrieval Field Evidence

- Date: 2026-07-12 (Asia/Tokyo)
- Operator: Codex, under the repository worktree session
- Host: Darwin 25.5.0 arm64
- Node.js: 24.13.0
- npm: 11.6.2
- Pi Agent SDK: 0.80.6
- OpenTelemetry Collector: 0.154.0 (temporary local Docker container)
- Config: `<local-config-path>` (values not copied)
- Database report path: `.pico-local/session-memory-retrieval-field.sqlite`

## Formal live gate

Command:

```bash
PICO_CONFIG_PATH=<local-config-path> \
PICO_ENABLE_LIVE_SESSION_MEMORY_RETRIEVAL=1 \
npm run field:session-memory-retrieval
```

Result: **PASS**.

- Source entries: 2
- Processed worker jobs: 1
- Active automated memories: 1
- Separate Pi Agent SDK session retrieval results: 2
- Matching automated provenance: 2
- Search audit events: 1
- Duration: 66,671 ms

The Collector received the bounded worker lifecycle events over the configured
loopback OTLP HTTP endpoint. The exported records contained IDs, counts,
categories, and fixed summaries only; no cutoff text, query, memory body, raw
provider output, device identifier, or credential was present. The temporary
Collector container was stopped and removed after the gate.

## Long-memory path isolation run

The same live gate was rerun with only the OTel exporter boundary replaced by
an in-memory exporter. The extraction model, SQLite store, and Pi Agent SDK
session loading the Pico extension were not replaced.

Result: **PASS**.

- Source entries: 2
- Processed worker jobs: 1
- Active automated memories: 1
- Separate Pi Agent SDK session retrieval results: 1
- Matching automated provenance: 1
- Search audit events: 1
- Duration: 65,370 ms

The report and audit contained no cutoff text, query text, memory title/body,
raw provider output, device identifier, or credential.

## Luna one-shot worker validation

- Date: 2026-07-13 (Asia/Tokyo)
- Extraction config: `openai-codex/gpt-5.6-luna`, thinking level `high`
- Startup mode: `resident:memory --once`
- OpenTelemetry Collector: 0.154.0, temporary loopback container
- Backup: `.pico-local/backups/20260713-054433-luna-worker/`

Pre-run bounded state:

- processed jobs: 3
- queued jobs: 2
- active memories: 0
- automation observations: 0
- memory LaunchAgent: not loaded (`launchctl` code 113)

The first run reached a deterministic degraded retry after 3.58 seconds. Root-cause analysis used
synthetic prompts only and found that the extractor had supplied a fixed provider session ID while
the working Pi CLI delegates in-memory session identity to `SessionManager`. Under Luna, the fixed
identity routed to an unavailable provider-side model alias. The model, thinking level, request
shape, OAuth credential hash, and WebSocket transport were otherwise identical.

The extractor was changed to let Pi generate its in-memory session ID. The regression test uses a
non-production model sentinel and therefore fixes arbitrary config pass-through rather than a Luna
model lock. No fallback model or CLI-hardcoded model was added.

Successful rerun result:

```json
{
  "status": "drained",
  "processedCount": 2,
  "recoveredCount": 0,
  "idle": true,
  "memoryWrittenCount": 0,
  "deadLetterCount": 0
}
```

- duration: 8.83 seconds
- processed jobs after run: 5
- queued jobs after run: 0
- the retried job completed on attempt 2; the second queued job completed on attempt 1
- active memories: 0
- automation observations: 0
- archive/delete lifecycle events: 0
- successful-run audit records delivered to the temporary Collector: 4
- memory LaunchAgent after run: not loaded (`launchctl` code 113)

Zero extracted memories is a valid outcome: neither queued cutoff contained a reusable facility fact
that the Luna extractor accepted for durable storage. The worker removed the raw processed payloads
through the normal repository-owned success transition. No retention/decay operation ran. The
temporary Collector and diagnostic scripts were removed after verification.

## Conclusion

The long-memory implementation path is field-proven through real model
extraction, SQLite persistence, a separate Pi Agent SDK session invocation of
`pico_memory_search`, provenance matching, and real OTel Collector delivery.
No code fallback or placeholder was added.

Follow-up issue: none.
