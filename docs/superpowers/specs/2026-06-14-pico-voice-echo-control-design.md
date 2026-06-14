# Pico Voice Echo Control Design

Date: 2026-06-14
Status: Draft

## Purpose

`pico` needs an AEC-first live voice boundary so its own Aivis Speech output is
not treated as user speech. The goal is to support reliable resident-agent
turn-taking with real microphones and speakers.

This design updates the voice architecture before broader live voice automation.
It keeps STT and TTS adapters narrow while adding an explicit audio I/O and echo
control layer between physical devices and transcription/session triggering.

## Problem

The 2026-06-14 live voice field test proved:

- Aivis Speech synthesis can produce audible speaker output.
- AVFoundation microphone capture can record real user speech.
- The mlx-whisper sidecar can transcribe that real microphone input.

It did not prove that `pico` can safely listen while or after it speaks. Speaker
audio can leak back into the microphone and cause false wake phrases, false
session starts, repeated responses, or feedback loops.

## Source Context

- Field report:
  `docs/field-tests/2026-06-14-live-voice-stt-tts.md`
- Follow-up issue:
  `https://github.com/ToaruPen/pico/issues/58`
- WebRTC AEC3 is the preferred software AEC family because it is a modern
  production-grade echo canceller with residual echo suppression and double-talk
  handling.
- SpeexDSP has a simpler AEC API and remains an explicit alternative candidate
  if WebRTC AEC3 integration is blocked.
- Apple platform voice processing can provide echo-cancelled input on Apple
  platforms, but it is a platform audio I/O provider rather than a portable
  TypeScript library.

## Architecture

AEC belongs in `voice.echoControl`, not inside `voice.stt` or `voice.tts`.

```text
TTS text
  -> voice.tts
  -> voice.audio output
  -> voice.echoControl far-end reference

Mic input
  -> voice.audio input
  -> voice.echoControl near-end processing
  -> voice.stt
  -> voice.sessionTrigger
```

### voice.audio

Owns physical and local-process audio I/O:

- Microphone capture.
- Speaker playback.
- Frame sizing and timing metadata.
- Optional device labels and local file artifacts for field tests.

`voice.audio` does not transcribe, synthesize, or decide session starts.

### voice.echoControl

Owns echo-safe microphone processing:

- Accepts far-end reference frames from TTS playback.
- Accepts near-end microphone frames.
- Emits processed microphone frames for STT and session triggering.
- Applies AEC when configured.
- Applies safety policies such as post-TTS tail mute.
- Emits audit-safe lifecycle events without raw audio or transcripts.

### voice.stt

Remains the mlx-whisper transcription adapter. It receives already-approved
audio frames and returns text, language, confidence, duration, segments, and
provider source metadata.

### voice.tts

Remains the Aivis Speech synthesis adapter. It returns audio chunks and source
metadata. Playback itself belongs to `voice.audio` so the same output frames can
be supplied to `voice.echoControl` as far-end reference.

### voice.sessionTrigger

Owns wake-name, greeting, bell, and future trigger evaluation. It must consume
only processed audio/STT results from `voice.echoControl`, never raw mic input.

## Provider Model

Provider selection is explicit. There is no automatic hidden provider chain.

### web_rtc_aec3

Preferred implementation target.

Expected shape:

- Local sidecar or native adapter.
- Input: PCM16LE frames with sample rate, channel count, frame timestamp, and
  direction (`far_end` or `near_end`).
- Output: processed near-end PCM16LE frame plus diagnostics such as echo
  suppression status, voice activity status, and provider latency.

This provider is the long-term target for macOS, Linux, and Raspberry Pi if the
native integration is maintainable.

### platform_voice_processing

Apple development provider for macOS local field testing when platform audio
APIs are the best way to get echo-cancelled capture.

This provider is explicit and platform-scoped. It must not become a silent
secondary provider on Linux or Raspberry Pi.

### speexdsp

Explicit alternative if WebRTC AEC3 integration blocks the first practical
implementation. SpeexDSP should be treated as a lower-quality but simpler local
provider, not as the preferred design target.

### half_duplex

Safety policy, not the target AEC provider.

Half-duplex can suspend listening during TTS and a post-TTS tail window. It is
allowed as:

- A configured safety mode.
- A field-test baseline to prove the echo trigger harness works.

## YAML Shape

```yaml
voice:
  echoControl:
    enabled: true
    mode: aec
    provider: web_rtc_aec3
    providerEndpoint: http://127.0.0.1:8770
    sampleRateHz: 16000
    channels: 1
    frameMs: 10
    tailMuteMs: 700
    diagnostics:
      enabled: true
```

Validation rules:

- `enabled` defaults to `false` until the field implementation exists.
- `mode` is one of `aec`, `platform_voice_processing`, or `half_duplex`.
- `provider` is required when `mode: aec`.
- `providerEndpoint` is required for sidecar-backed providers.
- `sampleRateHz`, `channels`, `frameMs`, and `tailMuteMs` are positive bounded
  integers.
- No cloud endpoint is allowed.
- No provider chain is inferred from missing fields.

## Runtime Contracts

### Audio frame

```ts
type VoicePcmFrame = {
  readonly id: string;
  readonly direction: "near_end" | "far_end";
  readonly audio: Uint8Array;
  readonly encoding: "pcm16le";
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly capturedAt: string;
  readonly durationMs: number;
};
```

### Echo-control provider

```ts
type EchoControlProvider = {
  readonly describe: () => EchoControlProviderMetadata;
  readonly acceptFarEndReference: (frame: VoicePcmFrame) => Promise<void>;
  readonly processNearEnd: (frame: VoicePcmFrame) => Promise<EchoControlResult>;
  readonly flush: () => Promise<void>;
};
```

### Echo-control result

```ts
type EchoControlResult =
  | {
      readonly action: "pass";
      readonly reason: "no_far_end_tail" | "aec_processed";
      readonly frame: VoicePcmFrame;
      readonly diagnostics: EchoControlDiagnostics;
    }
  | {
      readonly action: "suppress";
      readonly reason: "far_end_tail_mute";
      readonly diagnostics: EchoControlDiagnostics;
    };
```

## Audit

Audit events must not include raw audio or transcripts.

Required lifecycle events:

- `voice.echo_control.reference_started`
- `voice.echo_control.reference_ended`
- `voice.echo_control.near_end_processed`
- `voice.listen.suspended_for_tts`
- `voice.listen.resumed`
- `voice.echo_control.provider_failed`

Allowed attributes:

- Provider name.
- Frame duration.
- Sample rate.
- Channel count.
- Suppression reason.
- Latency bucket or bounded latency value.
- Session id when one exists.

Forbidden attributes:

- Raw audio.
- Base64 audio.
- Raw transcript.
- Child identity labels.

## Field Tests

### Echo pickup prevention

Run Aivis TTS playback while recording microphone input with no human speech.
The test passes only if no pico session trigger is produced from the bot's own
speaker output.

### AEC resume

After TTS completes and the tail mute window expires, speak a wake phrase. The
test passes only if STT recognizes the human speech and session trigger resumes.

### Barge-in readiness

This is a later test. If the facility needs users to interrupt while pico is
speaking, run a field test with simultaneous TTS and human speech. This decides
whether half-duplex remains acceptable or full-duplex AEC behavior is required.

## Non-Goals

- Do not implement child voice identification.
- Do not use cloud audio processing.
- Do not store raw field-test audio in tracked files.
- Do not add a hidden secondary provider chain.
- Do not merge AEC into the STT adapter.
- Do not merge AEC into the TTS adapter.

## Acceptance Criteria

- Config can express an explicit echo-control provider.
- STT/session triggers consume only echo-controlled microphone frames.
- TTS playback supplies far-end reference frames to echo control.
- Field test proves pico does not trigger from its own TTS output.
- Field test proves listening resumes after tail mute.
- `just check` remains green.
