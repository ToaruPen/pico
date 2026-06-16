# 2026-06-16 Session Memory Lifecycle Field Test

## Scope

Verify that an entry-bearing pico session cutoff can flow through the same field
run into SQLite memory candidates, Mem0, and audit OTel export.

This field harness uses the `pico_session` tool boundary with an injected
session lifecycle, then submits the resulting cutoff payload to the memory and
audit providers. It records counts and identifiers only; it does not record
secrets or raw local credentials.

## Environment

- Repository: field issue worktree
- Config: `config/pico.local.yaml`
- Session duration: default `60_000 ms`
- Mem0: enabled in local config
- OTel: enabled in local config

## Command

```bash
PICO_CONFIG_PATH=config/pico.local.yaml \
npm run field:session-memory-lifecycle
```

## Result

```json
{
  "status": "passed",
  "provider": "session+sqlite+mem0+otel",
  "details": {
    "runId": "d21a16cf-88d9-4e35-bcfb-ab61649a53e2",
    "sessionId": "session-1",
    "sourceEntryCount": 2,
    "candidateJobId": 1,
    "candidateCount": 1,
    "mem0MemoryCount": 2,
    "auditEventCount": 6,
    "exportedOtelRecordCount": 6,
    "databasePath": ".pico-local/session-memory-field.sqlite"
  }
}
```

## Verdict

Passed.

- The cutoff was entry-bearing: `sourceEntryCount=2`.
- The same cutoff produced one SQLite memory candidate job and one pending
  candidate.
- The same cutoff produced two Mem0 memories.
- The shared audit log exported six OTel records.

Issue #65 is satisfied by this field run.
