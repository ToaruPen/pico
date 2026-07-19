# Resident Voice OpenTelemetry Validation

## Scope

This field run validates one finite Japanese audio fixture through the configured Apple Speech STT,
Pi Agent, StackChan tool, Aivis Speech TTS, playback, interaction cleanup, private content evidence,
and in-process OpenTelemetry exporters.

The run used `openai-codex/gpt-5.6-sol` with thinking level `medium`. The configured external OTLP
Collector was disabled and neither `otelcol` nor `otelcol-contrib` was installed, so this run proves
SDK signal creation, collection, flush, and health but not network delivery to an external Collector.

## Input and command

The 7.044-second PCM16LE mono 16 kHz WAV fixture contained:

> スタックチャンの現在の状態を、必ず状態確認ツールを呼び出して確認してください。

The fixture was injected as a finite capture source rather than played into a physical microphone.
Apple Speech, Pi Agent, Aivis Speech, and the configured playback provider remained real.

```bash
PICO_CONFIG_PATH=config/pico.local.yaml \
  npm run field:resident-voice-pseudo-audio -- \
  --audio-fixture /tmp/pico-otel-stackchan-check-20260719.wav \
  --validation-output /tmp/pico-voice-validation.bj6NtE/events.jsonl \
  --required-tool-name stackchan_get_status \
  --timeout-ms 240000
```

## Content correctness

The private artifact directory was owned by the current user with mode `0700`; the new JSONL file
had mode `0600`. Four events were present:

1. Apple Speech transcript: `スタックちゃんの現在の状態を必ず状態確認ツールを呼び出して確認してください。`
2. `stackchan_get_status` start with empty arguments.
3. Matching non-error tool end after 78.144 ms. The result reported disconnected state, no device ID,
   and zero available tools.
4. Pi response: `スタックちゃんは現在接続されていません。デバイスIDはなく、利用可能なツールは0件です。`

The field status was `passed`: one accepted hold, one completed turn, no empty/cancelled/failed turn,
no late result, and the required tool completed with `isError: false`.

## Timing results

| Stage | Status | Duration |
|---|---:|---:|
| `stt` | ok | 309.114 ms |
| `pi_session_resource_load` | ok | 690.983 ms |
| `pi_session_create` | ok | 2.025 ms |
| `pi_session_bind` | ok | 1.905 ms |
| `pi_tool_execution` | ok | 78.198 ms |
| `pi_time_to_first_text` | ok | 9,442.902 ms |
| `pi_turn` | ok | 9,463.362 ms |
| `tts_request_wall` | ok | 2,762.335 ms |
| `ptt_release_to_playback_start` | ok | 12,792.912 ms |
| `tts_playback` | ok | 10,068.396 ms |
| `pi_session_dispose` | ok | 11.663 ms |
| `interaction_end` | ok | 12.666 ms |

The dominant pre-playback cost was Pi time to first text at 73.8% of the 12.793-second release-to-
playback interval. TTS request wall time was 21.6% and STT was 2.4%. Pi resource loading accounted
for 0.691 seconds of TTFT; session creation and binding were negligible. The remaining Pi time cannot
be split safely between model inference and Pi-level plugin hooks from Pico telemetry alone.

Playback itself lasted 10.068 seconds. Therefore the observed release-to-end-of-playback path was
approximately 22.861 seconds, while interaction cleanup after the ended notification completed in
12.666 ms and included an 11.663 ms Pi child-session disposal.

## OpenTelemetry evidence

The in-process exporters received 14 LogRecords and 24 Metric data points. Log and Metric health both
reported zero consecutive failures and a successful force-flush. Metrics remained limited to stage
and status labels; the transcript, response, tool arguments/results, and resident identifiers existed
only in the explicit private artifact.

## Optimization conclusion

The next optimization target is the Pi first-text path, not STT or session disposal. Resource loading
is measurable but only 0.691 seconds; the roughly 8.75 seconds after subtracting resource creation and
binding needs Pi/model-side investigation. TTS request latency is the second target at 2.762 seconds.
The current measurement does not justify changing Apple Speech, whose observed request time was
0.309 seconds.

Before making performance policy changes, repeat this run enough times to calculate p50/p95 and add a
live Collector capture. A physical microphone run is still required to measure AVFoundation capture
startup and actual user hold duration; the finite fixture intentionally excludes those variables.
