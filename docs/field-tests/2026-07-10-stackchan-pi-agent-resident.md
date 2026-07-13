# 2026-07-10 StackChan Pi Agent Resident Field Test

## Purpose

Verify that the actual Pi Agent runtime can control StackChan through MCP and
that pico can retain one Pi Agent SDK session across resident turns.

## Environment

- Pi Agent: `0.79.2`
- Pi MCP adapter: `2.10.0`
- StackChan MCP gateway: `0.15.0`
- StackChan device: `<redacted-device-id>`
- MCP endpoint: `http://127.0.0.1:18767/mcp`
- Authentication: `STACKCHAN_TOKEN` environment variable
- Project MCP config: `.pi/mcp.json`

The project config exposes a selected direct-tool set for status, camera,
volume, brightness, head movement, avatar, mouth, blink, and speech. It does not
place the bearer token in the repository.

## Pi Runtime Smoke

The authenticated Pi runtime smoke loaded pico's real system instructions:

```json
{"loaded":true,"identity":"pico"}
```

Pi Agent then used the MCP adapter to call StackChan `get_status`:

```json
{
  "agent": "pico",
  "mcp_server": "stackchan",
  "connected": true,
  "initialized": true,
  "device_id": "<redacted-device-id>",
  "tool_count": 35
}
```

## Physical Control

Pi Agent called `set_avatar`, `move_head`, and `get_head_angles` through MCP.
The requested avatar was `happy`; the requested movement was yaw `10`, pitch
`20`, speed `low`.

```json
{
  "agent": "pico",
  "avatar_requested": "happy",
  "move_requested": {"yaw": 10, "pitch": 20, "speed": "low"},
  "observed_yaw": 8,
  "observed_pitch": 20,
  "success": true
}
```

The observed yaw is the device-reported servo position after the bounded move,
not a rewritten requested value.

## Resident SDK Failure And Root Cause

The first SDK resident test reused one process and one pico session, but both MCP
tools returned `MCP not initialized`.

The same direct tool succeeded through the Pi CLI. A diagnostic SDK session
confirmed that the MCP extension and selected direct tools were loaded, but its
`session_start` handler had not run.

Pi SDK requires an embedding runtime to call `session.bindExtensions(...)`.
Pi CLI modes do this before the first prompt. Pico's resident SDK adapter had
created the session and prompted it without binding extension lifecycle events.

The resident adapter now:

1. binds extensions in headless `print` mode before returning a new SDK session;
2. emits `session_shutdown` with reason `quit` before disposing that session.

## Resident SDK Result

The corrected test kept the same process and pico session `session-1` alive
across a 15-second idle interval and two real model turns.

First turn:

```json
{"turn":1,"marker":"orchid-8045","avatar":"thinking","success":true}
```

Second turn:

```json
{
  "turn": 2,
  "remembered_marker": "orchid-8045",
  "yaw": 8,
  "pitch": 20,
  "success": true
}
```

This proves that one resident process can retain the Pi Agent SDK conversation
and continue to use StackChan tools. The test process exited normally after
extension shutdown and session disposal.

## 2026-07-11 Version And Tool-Boundary Revalidation

The integration was revalidated after updating the local runtime and tightening
the resident tool boundary:

- Pi Agent: `0.80.6`
- Pi MCP adapter: `2.11.0`
- available current OpenAI Codex models included multiple model ids, and
  `gpt-5.6-sol`
- StackChan MCP gateway: `0.15.0`

A read-only CLI run used `gpt-5.6-sol`, minimal thinking, and the single
`stackchan_get_status` allowlisted tool. The real gateway result reported
`connected=true`, `initialized=true`, and `toolCount=35`.

The real resident SDK measurement then started with the exact pico and selected
StackChan tool allowlist. Startup now verifies the post-bind active tool names,
so a missing direct-tool cache or any retained generic `mcp`, file, or shell tool
fails before the first prompt. The measurement passed in the same SDK path:

```json
{
  "status": "passed",
  "thinkingLevel": "medium",
  "durationMs": 3148,
  "responseLength": 7,
  "sessionId": "session-1"
}
```

## Voice Runtime Readiness

This field test proves Pi Agent and StackChan residency, not the complete live
voice loop. The following observations describe the original 2026-07-10 run,
before the Apple Speech migration:

- Resident voice config is enabled.
- MLX Whisper is healthy at `http://127.0.0.1:8765/health`.
- Aivis Speech was not listening at `127.0.0.1:10101`.
- A bounded microphone capture completed, but ambient input measured `-62.4 dB`
  RMS against the configured `-55 dB` minimum. No operator speech was supplied
  during that capture.
- The resident voice LaunchAgent plist exists but was not loaded during this
  test.

The full microphone-to-Pi-to-audible-response field run therefore still needs
Aivis Speech running and an operator speaking during the input check.
