# Pico Voice Echo Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an AEC-first `voice.echoControl` boundary that prevents pico's own TTS output from becoming session-triggering microphone input.

**Architecture:** Keep STT and TTS adapters narrow. Add echo-control configuration, TypeScript contracts, a deterministic half-duplex safety policy, and a field harness that exercises the no-human-speech speaker pickup path. WebRTC AEC3 remains the preferred provider target behind an explicit sidecar/native adapter boundary; this first implementation does not add a hidden provider chain.

**Tech Stack:** TypeScript, Vitest, existing YAML config loader, existing structured audit module, Pi Agent extension runtime, local Aivis Speech and mlx-whisper field providers.

---

## File Structure

- Modify `src/config/index.ts`: add `voice.echoControl` config parsing and validation.
- Modify `config/pico.example.yaml`: document local echo-control config shape.
- Create `src/modules/voice/echo-control.ts`: define frame/result/provider contracts and the deterministic half-duplex echo-control policy.
- Create `tests/voice-echo-control.test.ts`: verify contracts and half-duplex behavior.
- Modify `tests/config.test.ts`: verify YAML parsing, defaults, and validation.
- Create `scripts/field/voice-echo-pickup.ts`: run the local field harness that plays Aivis output, records the mic, sends it through echo control, and reports whether STT/session triggering would be allowed.
- Create `tests/voice-echo-pickup-field.test.ts`: test field harness planning and report classification without touching hardware.
- Modify `package.json` and `justfile`: add explicit `field:voice-echo-pickup` command.
- Modify `docs/field-tests/README.md`: document how field reports are created for echo pickup prevention.

## Task 1: Config Boundary

**Files:**
- Modify: `src/config/index.ts`
- Modify: `tests/config.test.ts`
- Modify: `config/pico.example.yaml`

- [ ] **Step 1: Write failing config tests**

Append tests to `tests/config.test.ts`:

```ts
it("defaults voice echo control to disabled", () => {
  expect(definePicoConfig({}).voice.echoControl).toEqual({
    enabled: false
  });
});

it("loads explicit WebRTC AEC3 echo-control config", () => {
  const config = definePicoConfig({
    voice: {
      echoControl: {
        enabled: true,
        mode: "aec",
        provider: "web_rtc_aec3",
        providerEndpoint: "http://127.0.0.1:8770",
        sampleRateHz: 16_000,
        channels: 1,
        frameMs: 10,
        tailMuteMs: 700,
        diagnostics: {
          enabled: true
        }
      }
    }
  });

  expect(config.voice.echoControl).toEqual({
    enabled: true,
    mode: "aec",
    provider: "web_rtc_aec3",
    providerEndpoint: "http://127.0.0.1:8770",
    sampleRateHz: 16_000,
    channels: 1,
    frameMs: 10,
    tailMuteMs: 700,
    diagnostics: {
      enabled: true
    }
  });
});

it("rejects cloud echo-control provider endpoints", () => {
  expect(() =>
    definePicoConfig({
      voice: {
        echoControl: {
          enabled: true,
          mode: "aec",
          provider: "web_rtc_aec3",
          providerEndpoint: "https://echo.example.com",
          sampleRateHz: 16_000,
          channels: 1,
          frameMs: 10,
          tailMuteMs: 700
        }
      }
    })
  ).toThrow("pico config voice.echoControl.providerEndpoint must use a local URL");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm run test -- tests/config.test.ts
```

Expected: FAIL because `voice.echoControl` does not exist on `PicoConfig`.

- [ ] **Step 3: Implement config types and parsing**

In `src/config/index.ts`, add:

```ts
export type PicoEchoControlConfig =
  | {
      readonly enabled: false;
    }
  | {
      readonly enabled: true;
      readonly mode: "aec" | "platform_voice_processing" | "half_duplex";
      readonly provider?: "web_rtc_aec3" | "speexdsp";
      readonly providerEndpoint?: string;
      readonly sampleRateHz: number;
      readonly channels: number;
      readonly frameMs: number;
      readonly tailMuteMs: number;
      readonly diagnostics: {
        readonly enabled: boolean;
      };
    };
```

Update `PicoConfig["voice"]` to include:

```ts
echoControl: PicoEchoControlConfig;
```

Update `emptyPicoConfig.voice` to include:

```ts
echoControl: {
  enabled: false
}
```

Add parsing helpers following existing config style:

```ts
function defineEchoControlConfig(
  input: Record<string, unknown> | undefined
): PicoEchoControlConfig {
  if (input === undefined) {
    return { enabled: false };
  }

  const enabled = readOptionalBoolean(input.enabled, "pico config voice.echoControl.enabled") ?? false;

  if (!enabled) {
    return { enabled: false };
  }

  const mode = requireEchoControlMode(input.mode);
  const provider = readOptionalEchoControlProvider(input.provider);
  const providerEndpoint = readOptionalString(
    input.providerEndpoint,
    "pico config voice.echoControl.providerEndpoint"
  );

  if (mode === "aec") {
    requireString(provider, "pico config voice.echoControl.provider is required when mode is aec");
    requireLocalSidecarBaseUrl(providerEndpoint);
  }

  return {
    enabled: true,
    mode,
    ...(provider === undefined ? {} : { provider }),
    ...(providerEndpoint === undefined ? {} : { providerEndpoint: requireLocalSidecarBaseUrl(providerEndpoint) }),
    sampleRateHz:
      readOptionalPositiveInteger(input.sampleRateHz, "pico config voice.echoControl.sampleRateHz") ?? 16_000,
    channels: readOptionalPositiveInteger(input.channels, "pico config voice.echoControl.channels") ?? 1,
    frameMs: readOptionalPositiveInteger(input.frameMs, "pico config voice.echoControl.frameMs") ?? 10,
    tailMuteMs: readOptionalNonNegativeInteger(input.tailMuteMs, "pico config voice.echoControl.tailMuteMs") ?? 700,
    diagnostics: defineEchoControlDiagnostics(
      readOptionalRecord(input.diagnostics, "pico config voice.echoControl.diagnostics")
    )
  };
}
```

Use exact helper names that fit the file after checking nearby helpers. If `readOptionalNonNegativeInteger` is absent, add it next to numeric helpers and cover it with the tests above.

- [ ] **Step 4: Update example YAML**

In `config/pico.example.yaml`, under `voice:`, add:

```yaml
  echoControl:
    enabled: false
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

- [ ] **Step 5: Verify config tests pass**

Run:

```bash
npm run test -- tests/config.test.ts
```

Expected: PASS.

## Task 2: Echo-Control Contracts And Half-Duplex Policy

**Files:**
- Create: `src/modules/voice/echo-control.ts`
- Create: `tests/voice-echo-control.test.ts`

- [ ] **Step 1: Write failing echo-control tests**

Create `tests/voice-echo-control.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import {
  createHalfDuplexEchoControl,
  defineVoicePcmFrame
} from "../src/modules/voice/echo-control.js";

describe("voice echo control", () => {
  it("suppresses near-end frames while TTS reference is active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-14T09:00:00.000Z"));

    try {
      const echoControl = createHalfDuplexEchoControl({ tailMuteMs: 700 });
      const farEnd = defineVoicePcmFrame({
        id: "far-1",
        direction: "far_end",
        audio: new Uint8Array(320),
        encoding: "pcm16le",
        sampleRateHz: 16_000,
        channels: 1,
        capturedAt: "2026-06-14T09:00:00.000Z",
        durationMs: 10
      });

      await echoControl.acceptFarEndReference(farEnd);

      const nearEnd = defineVoicePcmFrame({
        ...farEnd,
        id: "near-1",
        direction: "near_end"
      });

      await expect(echoControl.processNearEnd(nearEnd)).resolves.toEqual({
        ok: false,
        suppressedReason: "tts_active",
        diagnostics: {
          echoDetected: true,
          voiceActivity: false
        }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes near-end frames after reference ends and tail mute expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-14T09:00:00.000Z"));

    try {
      const echoControl = createHalfDuplexEchoControl({ tailMuteMs: 700 });
      const farEnd = defineVoicePcmFrame({
        id: "far-1",
        direction: "far_end",
        audio: new Uint8Array(320),
        encoding: "pcm16le",
        sampleRateHz: 16_000,
        channels: 1,
        capturedAt: "2026-06-14T09:00:00.000Z",
        durationMs: 10
      });
      const nearEnd = defineVoicePcmFrame({
        ...farEnd,
        id: "near-1",
        direction: "near_end"
      });

      await echoControl.acceptFarEndReference(farEnd);
      await echoControl.flush();
      vi.advanceTimersByTime(700);

      await expect(echoControl.processNearEnd(nearEnd)).resolves.toEqual({
        ok: true,
        frame: nearEnd,
        diagnostics: {
          echoDetected: false,
          voiceActivity: true
        }
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm run test -- tests/voice-echo-control.test.ts
```

Expected: FAIL because `src/modules/voice/echo-control.ts` does not exist.

- [ ] **Step 3: Implement contracts and half-duplex provider**

Create `src/modules/voice/echo-control.ts`:

```ts
export type VoiceFrameDirection = "near_end" | "far_end";

export type VoicePcmFrame = {
  readonly id: string;
  readonly direction: VoiceFrameDirection;
  readonly audio: Uint8Array;
  readonly encoding: "pcm16le";
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly capturedAt: string;
  readonly durationMs: number;
};

export type EchoControlResult =
  | {
      readonly ok: true;
      readonly frame: VoicePcmFrame;
      readonly diagnostics: EchoControlDiagnostics;
    }
  | {
      readonly ok: false;
      readonly suppressedReason: "tts_active" | "tail_mute" | "provider_unavailable";
      readonly diagnostics: EchoControlDiagnostics;
    };

export type EchoControlDiagnostics = {
  readonly providerLatencyMs?: number;
  readonly voiceActivity: boolean;
  readonly echoDetected: boolean;
};

export type EchoControlProvider = {
  readonly describe: () => EchoControlProviderMetadata;
  readonly acceptFarEndReference: (frame: VoicePcmFrame) => Promise<void>;
  readonly processNearEnd: (frame: VoicePcmFrame) => Promise<EchoControlResult>;
  readonly flush: () => Promise<void>;
};

export type EchoControlProviderMetadata = {
  readonly provider: "half_duplex" | "web_rtc_aec3" | "platform_voice_processing" | "speexdsp";
  readonly mode: "aec" | "platform_voice_processing" | "half_duplex";
};

export type HalfDuplexEchoControlOptions = {
  readonly tailMuteMs: number;
};

export function createHalfDuplexEchoControl(
  options: HalfDuplexEchoControlOptions
): EchoControlProvider {
  const tailMuteMs = requireNonNegativeInteger(options.tailMuteMs, "pico echo control tailMuteMs");
  let ttsActive = false;
  let tailMuteUntil = 0;

  return {
    describe() {
      return {
        provider: "half_duplex",
        mode: "half_duplex"
      };
    },
    async acceptFarEndReference(frame) {
      requireVoiceFrameDirection(frame, "far_end");
      ttsActive = true;
    },
    async processNearEnd(frame) {
      requireVoiceFrameDirection(frame, "near_end");

      if (ttsActive) {
        return suppressed("tts_active");
      }

      if (Date.now() < tailMuteUntil) {
        return suppressed("tail_mute");
      }

      return {
        ok: true,
        frame,
        diagnostics: {
          echoDetected: false,
          voiceActivity: true
        }
      };
    },
    async flush() {
      ttsActive = false;
      tailMuteUntil = Date.now() + tailMuteMs;
    }
  };
}
```

Complete the helper functions in the same file:

```ts
export function defineVoicePcmFrame(input: VoicePcmFrame): VoicePcmFrame {
  return Object.freeze({
    id: requireText(input.id, "pico voice frame id is required"),
    direction: requireVoiceFrameDirection(input, input.direction),
    audio: requireNonEmptyAudio(input.audio),
    encoding: requirePcm16le(input.encoding),
    sampleRateHz: requirePositiveInteger(input.sampleRateHz, "pico voice frame sampleRateHz"),
    channels: requirePositiveInteger(input.channels, "pico voice frame channels"),
    capturedAt: requireIsoText(input.capturedAt, "pico voice frame capturedAt is required"),
    durationMs: requirePositiveInteger(input.durationMs, "pico voice frame durationMs")
  });
}
```

- [ ] **Step 4: Verify echo-control tests pass**

Run:

```bash
npm run test -- tests/voice-echo-control.test.ts
```

Expected: PASS.

## Task 3: Audit-Safe Echo-Control Events

**Files:**
- Modify: `src/modules/voice/echo-control.ts`
- Modify: `tests/voice-echo-control.test.ts`

- [ ] **Step 1: Add failing audit test**

Append:

```ts
it("records audit-safe listen suspension and resume events", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-14T09:00:00.000Z"));

  try {
    const events: unknown[] = [];
    const echoControl = createHalfDuplexEchoControl({
      tailMuteMs: 700,
      audit: {
        record: (event) => events.push(event),
        entries: () => []
      }
    });
    const farEnd = defineVoicePcmFrame({
      id: "far-1",
      direction: "far_end",
      audio: new Uint8Array(320),
      encoding: "pcm16le",
      sampleRateHz: 16_000,
      channels: 1,
      capturedAt: "2026-06-14T09:00:00.000Z",
      durationMs: 10
    });

    await echoControl.acceptFarEndReference(farEnd);
    await echoControl.flush();

    expect(events).toMatchObject([
      {
        name: "voice.listen.suspended_for_tts",
        category: "voice"
      },
      {
        name: "voice.listen.resumed",
        category: "voice"
      }
    ]);
    expect(JSON.stringify(events)).not.toContain("dataBase64");
    expect(JSON.stringify(events)).not.toContain("transcript");
  } finally {
    vi.useRealTimers();
  }
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm run test -- tests/voice-echo-control.test.ts
```

Expected: FAIL because the half-duplex provider does not accept audit.

- [ ] **Step 3: Add audit option and events**

In `src/modules/voice/echo-control.ts`, import `StructuredAuditLog` and update options:

```ts
import type { StructuredAuditLog } from "../audit/index.js";

export type HalfDuplexEchoControlOptions = {
  readonly tailMuteMs: number;
  readonly audit?: StructuredAuditLog;
};
```

Record events in `acceptFarEndReference` and `flush`:

```ts
recordVoiceAudit(options.audit, "voice.listen.suspended_for_tts", {
  "pico.voice.echo_control.provider": "half_duplex",
  "pico.voice.frame.duration_ms": frame.durationMs,
  "pico.voice.frame.sample_rate_hz": frame.sampleRateHz,
  "pico.voice.frame.channels": frame.channels
});
```

```ts
recordVoiceAudit(options.audit, "voice.listen.resumed", {
  "pico.voice.echo_control.provider": "half_duplex",
  "pico.voice.echo_control.tail_mute_ms": tailMuteMs
});
```

- [ ] **Step 4: Verify audit test passes**

Run:

```bash
npm run test -- tests/voice-echo-control.test.ts
```

Expected: PASS.

## Task 4: Field Harness Planning And Command

**Files:**
- Create: `scripts/field/voice-echo-pickup.ts`
- Create: `tests/voice-echo-pickup-field.test.ts`
- Modify: `package.json`
- Modify: `justfile`
- Modify: `docs/field-tests/README.md`

- [ ] **Step 1: Write failing field harness tests**

Create `tests/voice-echo-pickup-field.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  buildVoiceEchoPickupFieldPlan,
  voiceEchoPickupFieldExitCode
} from "../scripts/field/voice-echo-pickup.js";
import { definePicoConfig } from "../src/config/index.js";

describe("voice echo pickup field harness", () => {
  it("requires voice echo control, STT, and TTS configuration", () => {
    expect(buildVoiceEchoPickupFieldPlan(definePicoConfig({}))).toEqual({
      status: "skip",
      reason: "Set voice.echoControl, voice.stt.mlxWhisper, and voice.tts.aivis to run the voice echo pickup field test."
    });
  });

  it("plans a local half-duplex field run from config", () => {
    const plan = buildVoiceEchoPickupFieldPlan(
      definePicoConfig({
        voice: {
          echoControl: {
            enabled: true,
            mode: "half_duplex",
            sampleRateHz: 16_000,
            channels: 1,
            frameMs: 10,
            tailMuteMs: 700
          },
          stt: {
            mlxWhisper: {
              localBaseUrl: "http://127.0.0.1:8765",
              samplePcm16lePath: "/tmp/not-used.pcm"
            }
          },
          tts: {
            aivis: {
              localBaseUrl: "http://127.0.0.1:10101",
              speakerId: 888_753_760
            }
          }
        }
      })
    );

    expect(plan).toMatchObject({
      status: "run",
      echoControl: {
        mode: "half_duplex",
        tailMuteMs: 700
      },
      stt: {
        localBaseUrl: "http://127.0.0.1:8765"
      },
      tts: {
        localBaseUrl: "http://127.0.0.1:10101",
        speakerId: 888_753_760
      }
    });
  });

  it("returns failing exit only for failed reports", () => {
    expect(voiceEchoPickupFieldExitCode({ status: "passed" })).toBe(0);
    expect(voiceEchoPickupFieldExitCode({ status: "skipped" })).toBe(0);
    expect(voiceEchoPickupFieldExitCode({ status: "failed" })).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm run test -- tests/voice-echo-pickup-field.test.ts
```

Expected: FAIL because `scripts/field/voice-echo-pickup.ts` does not exist.

- [ ] **Step 3: Implement field harness planning**

Create `scripts/field/voice-echo-pickup.ts` with exported functions:

```ts
#!/usr/bin/env jiti
import { loadPicoConfigFromEnvironment, type PicoConfig } from "../../src/config/index.js";

export type VoiceEchoPickupFieldReport =
  | { readonly status: "passed"; readonly details?: Record<string, unknown> }
  | { readonly status: "failed"; readonly reason?: string; readonly details?: Record<string, unknown> }
  | { readonly status: "skipped"; readonly reason: string };

export function buildVoiceEchoPickupFieldPlan(config: PicoConfig) {
  const echoControl = config.voice.echoControl;
  const stt = config.voice.stt.mlxWhisper;
  const tts = config.voice.tts.aivis;

  if (!echoControl.enabled || stt === undefined || tts === undefined) {
    return {
      status: "skip" as const,
      reason:
        "Set voice.echoControl, voice.stt.mlxWhisper, and voice.tts.aivis to run the voice echo pickup field test."
    };
  }

  return {
    status: "run" as const,
    echoControl,
    stt,
    tts
  };
}

export function voiceEchoPickupFieldExitCode(report: VoiceEchoPickupFieldReport): number {
  return report.status === "failed" ? 1 : 0;
}
```

Then add direct command behavior that loads config, runs the plan, and prints JSON. The first direct implementation may classify `status: "skipped"` when hardware capture is not wired; the planning tests must pass before live execution is added.

- [ ] **Step 4: Add package and just commands**

In `package.json` scripts:

```json
"field:voice-echo-pickup": "jiti scripts/field/voice-echo-pickup.ts"
```

In `justfile`:

```just
field-voice-echo-pickup:
  npm run field:voice-echo-pickup
```

- [ ] **Step 5: Verify field harness tests pass**

Run:

```bash
npm run test -- tests/voice-echo-pickup-field.test.ts
```

Expected: PASS.

## Task 5: Local Field Execution And Report

**Files:**
- Modify: `scripts/field/voice-echo-pickup.ts`
- Add: `docs/field-tests/YYYY-MM-DD-voice-echo-pickup.md`

- [ ] **Step 1: Add field execution behavior**

Extend `scripts/field/voice-echo-pickup.ts` to:

1. Generate Aivis TTS audio for a fixed phrase such as `ピコのエコーテストです。`.
2. Play the audio through the configured local speaker command or platform default.
3. Record microphone input to an ignored `.pico-local/field-voice/` PCM file.
4. Feed near-end frames through `createHalfDuplexEchoControl` for the first slice.
5. Send only allowed frames to mlx-whisper.
6. Report failed if STT returns a wake phrase or greeting during the no-human-speech window.
7. Report passed if echo control suppresses the mic window and no session trigger would be produced.

- [ ] **Step 2: Run the field command**

Run:

```bash
PICO_CONFIG_PATH=config/pico.local.yaml npm run field:voice-echo-pickup
```

Expected: JSON report with `status: "passed"` or `status: "failed"` and no raw audio/transcript payloads in audit.

- [ ] **Step 3: Add field report**

Create `docs/field-tests/YYYY-MM-DD-voice-echo-pickup.md` with:

```md
# YYYY-MM-DD Voice Echo Pickup Field Test

## Scope

Verify that pico does not trigger a session from its own Aivis Speech output.

## Environment

- Echo-control mode:
- STT endpoint:
- TTS endpoint:
- Microphone device:
- Speaker path:
- Raw audio artifacts: `.pico-local/field-voice/` only, not tracked.

## Observed Result

- TTS playback:
- Mic recording:
- Echo-control result:
- STT/session trigger result:

## Verdict

Passed or failed.

## Follow-Up

Issue links for failures.
```

- [ ] **Step 4: Update #58 and #31**

Comment on #58 with the field report path. If the no-human-speech echo pickup test passes, update #31 only if it maps to a current milestone; otherwise keep #58 as the tracking issue.

## Task 6: Full Verification

**Files:**
- All modified files.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm run test -- tests/config.test.ts tests/voice-echo-control.test.ts tests/voice-echo-pickup-field.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full local gate**

Run:

```bash
just check
```

Expected: PASS with all test files passing.

- [ ] **Step 3: Inspect changed files**

Run:

```bash
git status --short
git diff --stat
```

Expected: changes are limited to echo-control config, voice echo-control contracts, field harness, tests, and docs.

## Self-Review

- Spec coverage: This plan covers YAML config, runtime contracts, audit-safe events, explicit provider boundaries, field harness, and verification. Native WebRTC AEC3 implementation is intentionally behind the provider boundary and not included in this first deterministic slice.
- Placeholder scan: No step depends on a placeholder value; field commands use local config and ignored `.pico-local/` artifacts.
- Type consistency: Config uses `voice.echoControl`; runtime uses `VoicePcmFrame`, `EchoControlProvider`, and `EchoControlResult`; field harness uses `buildVoiceEchoPickupFieldPlan` and `voiceEchoPickupFieldExitCode`.
