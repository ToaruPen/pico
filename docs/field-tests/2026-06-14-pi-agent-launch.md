# 2026-06-14 Pi Agent Launch Field Test

> Historical record: memory-related ownership in this document was superseded
> by [Pi 所有 memory 責務境界設計](../superpowers/specs/2026-07-13-pi-owned-memory-boundary-design.md).
> Current Pico has no short-term or durable-memory implementation.

## Scope

Verify that the actual Pi Agent CLI can launch with the pico extension loaded.
This is field milestone 0. It does not validate live STT, TTS, Tapo camera, VLM,
session cutoff, memory processing, or OTel export.

## Environment

- Repository: `/Users/monsoon/Dev/pico`
- Branch: `codex/field-validation-policy`
- Pi Agent CLI: `node_modules/.bin/pi`
- Extension: `./src/index.ts`
- Secrets: not recorded

## Command

```bash
node_modules/.bin/pi --approve --no-session --no-tools --extension ./src/index.ts -p 'pico extensionが読み込まれているか確認します。日本語で簡潔に、あなたのpico identity名と利用可能なpico modulesを列挙してください。'
```

## Observed Result

The Pi Agent process exited successfully and reported:

- pico extension loaded.
- pico identity name: `pico`.
- role: `resident_ai_support_staff`.
- available modules: `context`, `memory`, `session`, `local_models`, `handoff`,
  `audit`, `transport`.
- planned modules: `long_memory`, `voice`, `vision`, `camera`, `channels`.

## Verdict

Passed.

## Follow-Up

- Continue with a live interaction field test through the Pi Agent runtime.
- Confirm whether `handoff` should remain in the runtime module list before
  treating the module inventory as product-final.
