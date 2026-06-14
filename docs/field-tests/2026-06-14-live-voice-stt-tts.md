# 2026-06-14 Live Voice STT/TTS Field Test

## Scope

Verify live microphone STT using the configured mlx-whisper sidecar and exercise
the configured Aivis Speech TTS speaker playback path.

This validates real microphone capture and STT transcription. TTS synthesis,
playback command execution, and audible speaker output were validated with
operator confirmation.

## Environment

- Repository: `/Users/monsoon/Dev/pico`
- Branch: `codex/field-validation-policy`
- Microphone source: AVFoundation audio device `0` (`UAB-80`)
- STT endpoint: `http://127.0.0.1:8765`
- STT provider: `mlx-whisper`
- STT model: `mlx-community/whisper-large-v3-turbo`
- TTS endpoint: `http://127.0.0.1:10101`
- TTS provider: `aivis-speech`
- TTS speaker id: `888753760`
- Local artifacts: `.pico-local/field-voice/`
- Secrets: not recorded

## TTS Prompt Generation And Playback

The Aivis Speech sidecar generated `.pico-local/field-voice/aivis-prompt.wav`
for this Japanese prompt:

```text
ピコの実地テストです。これから5秒録音します。おはようピコ、今日は折り紙をします、と話してください。
```

Playback command:

```bash
afplay .pico-local/field-voice/aivis-prompt.wav
```

The command exited successfully.

## Live Microphone STT Retry

Recording command:

```bash
ffmpeg -y -hide_banner -loglevel error -f avfoundation -i ':0' -t 6 -ac 1 -ar 16000 -f s16le .pico-local/field-voice/live-mic-user-retry.pcm
```

Transcription request used the recorded PCM16LE mono 16 kHz file and posted it
to `/v1/transcriptions` on the configured mlx-whisper sidecar.

Observed STT result:

```json
{
  "provider": "mlx-whisper",
  "ok": true,
  "result": {
    "text": "おはようピコ。今日は折り紙をします。",
    "language": "ja",
    "confidence": 0.5,
    "durationMs": 943.3984170318581,
    "segments": [
      {
        "text": "おはようピコ。今日は折り紙をします。",
        "startMs": 0,
        "endMs": 5240,
        "confidence": 0.5
      }
    ]
  }
}
```

## Earlier Attempt

An earlier 5-second recording without a clear spoken prompt was transcribed as
`ご視聴ありがとうございました`. That result is treated as environmental/no-speech
misrecognition and is not used as the passing evidence.

## Verdict

- Live microphone STT: passed.
- Aivis Speech synthesis and playback command path: passed.
- Audible TTS confirmation from the intended speaker path: passed by operator
  confirmation.

## Follow-Up

- Track speaker-to-microphone echo pickup prevention in issue #58.
- Wire the live STT result into the Pi Agent session trigger path.
