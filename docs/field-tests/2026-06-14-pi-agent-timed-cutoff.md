# 2026-06-14 Pi Agent Timed Cutoff Field Test

## Scope

Verify that pico's configured timed session ending can end a Pi Agent runtime
session and allow a cutoff payload to be produced through the `pico_session`
tool.

This validates the Pi Agent runtime path for timed session cutoff. It does not
validate live microphone STT, audible TTS, camera, VLM, long-memory processing,
or OTel export.

## Environment

- Repository: `/Users/monsoon/Dev/pico`
- Branch: `codex/field-validation-policy`
- Pi Agent CLI: `node_modules/.bin/pi`
- Extension: `./src/index.ts`
- Built-in coding tools: disabled with `--no-builtin-tools`
- Config: `.pico-local/field-session-cutoff.yaml`
- Secrets: not recorded

## Command

```bash
PICO_CONFIG_PATH=.pico-local/field-session-cutoff.yaml node_modules/.bin/pi --approve --no-session --no-builtin-tools --extension ./src/index.ts -p '実地テスト2です。必ず pico_session tool を使ってください。まず action=start, triggerKind=greeting, label=おはよう, source=field-test-cutoff でセッションを開始し、その sessionId に role=staff, content=今日は紙芝居をします。 を append してください。その後、同じ sessionId に action=cutoff を実行してください。最後の返答では、cutoffのsessionId、sourceEntryIdsの数、requestedByだけを日本語で簡潔に報告してください。'
```

## Observed Result

The Pi Agent process exited successfully and reported:

- `sessionId`: `session-1`
- `sourceEntryIds` count: `0`
- `requestedBy`: `session_lifecycle`

## Interpretation

The configured `durationMs: 1` ended the session before the later append action
could add an entry. This is acceptable for the timed cutoff milestone because
`pico_session cutoff` only succeeds after the lifecycle has moved the session to
`ended`.

A second run with `durationMs: 100` showed the same practical behavior: the
model/tool round trip took longer than the configured cutoff window, so the
cutoff payload was empty. Entry-bearing cutoff should be validated through the
memory milestone using either an interactive run or a dedicated field harness
that can wait intentionally between append and cutoff without racing the model
turn.

## Verdict

Passed for configured timed session cutoff.

## Follow-Up

- Validate entry-bearing cutoff during the long-memory field milestone.
- Build a field harness if repeated timed interaction tests require precise
  waits between Pi Agent tool calls.
