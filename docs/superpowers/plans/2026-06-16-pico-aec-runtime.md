# Pico AEC Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `mode: aec` a real live-voice path requirement: pico must fail closed without a healthy explicit local AEC provider, route TTS far-end and mic near-end frames through echo control, and report half-duplex success as a safety baseline rather than AEC acceptance.

**Architecture:** Keep AEC in `voice.echoControl`, not in STT or TTS. Add provider health to the existing local HTTP provider boundary, add a small live voice turn runtime that routes TTS and mic frames through echo control before STT/session triggering, and tighten the field harness classification so only a real AEC provider run can produce an AEC pass.

**Tech Stack:** TypeScript, Vitest, existing local HTTP echo-control boundary, Aivis Speech TTS adapter, mlx-whisper STT adapter, `just check`.

---

## File Structure

- Modify `src/modules/voice/echo-control.ts`
  - Add provider health types and `checkHealth()` to `EchoControlProvider`.
  - Implement `/v1/echo-control/health` for HTTP providers.
  - Keep half-duplex as explicit safety mode with its own health result.
- Add `src/runtime/live-voice-turn.ts`
  - Own one live voice turn pipeline.
  - Accept a TTS client, STT client, echo-control provider, and trigger phrases.
  - Send TTS chunks to `acceptFarEndReference()`.
  - Send mic frames through `processNearEnd()` before STT.
  - Never transcribe suppressed frames.
- Add `tests/live-voice-turn.test.ts`
  - Verify far-end registration, near-end processing, no raw mic bypass, and trigger evaluation.
- Modify `scripts/field/voice-echo-pickup.ts`
  - Add `acceptance` classification: `aec_pass`, `safety_pass`, or `fail`.
  - Check provider health for `mode: aec` before field capture.
  - Keep half-duplex runnable, but report it as `safety_pass`.
- Modify `tests/voice-echo-control.test.ts`
  - Test HTTP provider health success and failure.
- Modify `tests/voice-echo-pickup-field.test.ts`
  - Test the new acceptance classification.
- Modify `package.json` only if a new script is required.
  - Do not add a native AEC engine dependency in this plan.

## Task 1: Provider Health Contract

**Files:**
- Modify: `src/modules/voice/echo-control.ts`
- Test: `tests/voice-echo-control.test.ts`

- [ ] **Step 1: Write the failing test for HTTP provider health**

Add to `tests/voice-echo-control.test.ts`:

```ts
it("checks explicit HTTP AEC provider health before live use", async () => {
  const requests: string[] = [];
  const provider = createHttpEchoControlProvider({
    provider: "web_rtc_aec3",
    mode: "aec",
    providerEndpoint: "http://127.0.0.1:8770",
    fetchImplementation: (url) => {
      if (!(url instanceof URL)) {
        throw new Error("unexpected echo-control health request");
      }

      requests.push(url.href);

      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            provider: "web_rtc_aec3",
            mode: "aec",
            engine: "webrtc-aec3"
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        )
      );
    }
  });

  await expect(provider.checkHealth()).resolves.toEqual({
    ok: true,
    provider: "web_rtc_aec3",
    mode: "aec",
    engine: "webrtc-aec3"
  });
  expect(requests).toEqual(["http://127.0.0.1:8770/v1/echo-control/health"]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run test -- tests/voice-echo-control.test.ts
```

Expected: FAIL because `checkHealth` does not exist on `EchoControlProvider`.

- [ ] **Step 3: Add health types and minimal implementation**

In `src/modules/voice/echo-control.ts`, add:

```ts
export type EchoControlProviderHealth =
  | {
      readonly ok: true;
      readonly provider: EchoControlProviderKind;
      readonly mode: EchoControlProviderMetadata["mode"];
      readonly engine: string;
    }
  | {
      readonly ok: false;
      readonly provider: EchoControlProviderKind;
      readonly mode: EchoControlProviderMetadata["mode"];
      readonly reason: "unavailable" | "invalid_response";
      readonly message: string;
    };
```

Update `EchoControlProvider`:

```ts
export type EchoControlProvider = {
  readonly describe: () => EchoControlProviderMetadata;
  readonly checkHealth: () => Promise<EchoControlProviderHealth>;
  readonly acceptFarEndReference: (frame: VoicePcmFrame) => Promise<void>;
  readonly processNearEnd: (frame: VoicePcmFrame) => Promise<EchoControlResult>;
  readonly flush: () => Promise<void>;
};
```

For half-duplex, add:

```ts
checkHealth() {
  return Promise.resolve({
    ok: true,
    provider: "half_duplex",
    mode: "half_duplex",
    engine: "half-duplex-safety"
  });
},
```

For HTTP provider, add:

```ts
async checkHealth() {
  return getEchoControlHealth(providerEndpoint, {
    provider: options.provider,
    mode: options.mode,
    fetchImplementation
  });
},
```

Create `getEchoControlHealth()` using `GET /v1/echo-control/health`. It must parse only the bounded fields shown in the test and must throw `pico echo-control provider health request failed with status ${response.status}` for non-2xx responses.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npm run test -- tests/voice-echo-control.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add the failing test for invalid health**

Add:

```ts
it("rejects malformed HTTP AEC provider health responses", async () => {
  const provider = createHttpEchoControlProvider({
    provider: "web_rtc_aec3",
    mode: "aec",
    providerEndpoint: "http://127.0.0.1:8770",
    fetchImplementation: () =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        })
      )
  });

  await expect(provider.checkHealth()).rejects.toThrow(
    "pico echo-control provider health response is malformed"
  );
});
```

- [ ] **Step 6: Run RED, then implement strict health parsing**

Run:

```bash
npm run test -- tests/voice-echo-control.test.ts
```

Expected: FAIL with a malformed health response mismatch.

Then implement `parseHttpEchoControlHealthResponse(input, expected)` so:

- `ok` must be `true`.
- `provider` must equal the configured provider.
- `mode` must equal the configured mode.
- `engine` must be a non-empty string.
- No raw audio or transcript fields are read or returned.

- [ ] **Step 7: Run tests**

Run:

```bash
npm run test -- tests/voice-echo-control.test.ts
```

Expected: PASS.

## Task 2: Live Voice Turn Runtime

**Files:**
- Create: `src/runtime/live-voice-turn.ts`
- Test: `tests/live-voice-turn.test.ts`

- [ ] **Step 1: Write the failing test for far-end and near-end routing**

Create `tests/live-voice-turn.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { runLiveVoiceTurn } from "../src/runtime/live-voice-turn.js";
import type { EchoControlProvider, VoicePcmFrame } from "../src/modules/voice/echo-control.js";
import type { SttClient, TtsClient } from "../src/modules/voice/index.js";

describe("live voice turn runtime", () => {
  it("routes TTS far-end and mic near-end through echo control before STT", async () => {
    const calls: string[] = [];
    const farEndFrames: VoicePcmFrame[] = [];
    const nearEndFrames: VoicePcmFrame[] = [];
    const processedAudio = new Uint8Array([9, 9, 9]);
    const echoControl: EchoControlProvider = {
      describe: () => ({ provider: "web_rtc_aec3", mode: "aec" }),
      checkHealth: () =>
        Promise.resolve({
          ok: true,
          provider: "web_rtc_aec3",
          mode: "aec",
          engine: "webrtc-aec3"
        }),
      acceptFarEndReference: (frame) => {
        calls.push(`far:${frame.id}`);
        farEndFrames.push(frame);
        return Promise.resolve();
      },
      processNearEnd: (frame) => {
        calls.push(`near:${frame.id}`);
        nearEndFrames.push(frame);
        return Promise.resolve({
          action: "pass",
          reason: "aec_processed",
          frame: {
            ...frame,
            audio: processedAudio
          },
          diagnostics: {
            provider: "web_rtc_aec3",
            residualEchoProbability: 0.1,
            voiceActivity: true
          }
        });
      },
      flush: () => Promise.resolve()
    };
    const tts: TtsClient = {
      synthesize: () =>
        Promise.resolve({
          ok: true,
          chunks: [
            {
              sentenceIndex: 0,
              text: "おはようピコ。",
              audio: new Uint8Array([1, 2, 3]),
              encoding: "pcm16le",
              sampleRateHz: 16_000,
              channels: 1,
              durationMs: 120,
              source: {
                serviceId: "local-aivis",
                provider: "aivis-speech",
                speakerId: 888_753_760
              }
            }
          ],
          totalDurationMs: 120,
          source: {
            serviceId: "local-aivis",
            provider: "aivis-speech",
            speakerId: 888_753_760
          }
        })
    };
    const sttRequests: Uint8Array[] = [];
    const stt: SttClient = {
      warmup: () => {
        throw new Error("warmup is not part of this runtime test");
      },
      transcribe: (request) => {
        sttRequests.push(request.audio);
        return Promise.resolve({
          ok: true,
          text: "こんにちは",
          language: "ja",
          confidence: 0.8,
          durationMs: 300,
          segments: [],
          source: {
            sidecarId: "local-mlx-whisper",
            provider: "mlx-whisper",
            modelRepo: "mlx-community/whisper-large-v3-turbo"
          }
        });
      }
    };

    const result = await runLiveVoiceTurn({
      now: () => "2026-06-16T10:00:00.000Z",
      tts,
      stt,
      echoControl,
      text: "おはようピコ。",
      micFrames: [
        {
          id: "mic-1",
          direction: "near_end",
          audio: new Uint8Array([4, 5, 6]),
          encoding: "pcm16le",
          sampleRateHz: 16_000,
          channels: 1,
          capturedAt: "2026-06-16T10:00:00.050Z",
          durationMs: 300
        }
      ],
      triggerPhrases: ["ピコ"]
    });

    expect(calls).toEqual(["far:tts-0", "near:mic-1"]);
    expect(farEndFrames).toHaveLength(1);
    expect(nearEndFrames).toHaveLength(1);
    expect(sttRequests).toEqual([processedAudio]);
    expect(result).toEqual({
      status: "completed",
      transcripts: ["こんにちは"],
      triggered: false,
      suppressedFrames: 0
    });
  });
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
npm run test -- tests/live-voice-turn.test.ts
```

Expected: FAIL because `src/runtime/live-voice-turn.ts` does not exist.

- [ ] **Step 3: Create the minimal runtime**

Create `src/runtime/live-voice-turn.ts`:

```ts
import {
  defineVoicePcmFrame,
  type EchoControlProvider,
  type VoicePcmFrame
} from "../modules/voice/echo-control.js";
import type { SttClient, TtsClient } from "../modules/voice/index.js";

export type LiveVoiceTurnInput = {
  readonly now: () => string;
  readonly tts: TtsClient;
  readonly stt: SttClient;
  readonly echoControl: EchoControlProvider;
  readonly text: string;
  readonly micFrames: readonly VoicePcmFrame[];
  readonly triggerPhrases: readonly string[];
};

export type LiveVoiceTurnResult = {
  readonly status: "completed";
  readonly transcripts: readonly string[];
  readonly triggered: boolean;
  readonly suppressedFrames: number;
};

export async function runLiveVoiceTurn(input: LiveVoiceTurnInput): Promise<LiveVoiceTurnResult> {
  const health = await input.echoControl.checkHealth();

  if (!health.ok) {
    throw new Error(`pico live voice echo-control provider is unhealthy: ${health.message}`);
  }

  const ttsResult = await input.tts.synthesize({ text: input.text });

  if (!ttsResult.ok) {
    throw new Error(`pico live voice TTS failed: ${ttsResult.reason}: ${ttsResult.message}`);
  }

  for (const chunk of ttsResult.chunks) {
    await input.echoControl.acceptFarEndReference(
      defineVoicePcmFrame({
        id: `tts-${chunk.sentenceIndex}`,
        direction: "far_end",
        audio: chunk.audio,
        encoding: chunk.encoding,
        sampleRateHz: chunk.sampleRateHz,
        channels: chunk.channels,
        capturedAt: input.now(),
        durationMs: chunk.durationMs
      })
    );
  }

  const transcripts: string[] = [];
  let suppressedFrames = 0;

  for (const micFrame of input.micFrames) {
    const result = await input.echoControl.processNearEnd(defineVoicePcmFrame(micFrame));

    if (result.action === "suppress") {
      suppressedFrames += 1;
      continue;
    }

    const sttResult = await input.stt.transcribe({
      audio: result.frame.audio,
      encoding: result.frame.encoding,
      sampleRateHz: result.frame.sampleRateHz,
      channels: result.frame.channels
    });

    if (!sttResult.ok) {
      throw new Error(`pico live voice STT failed: ${sttResult.reason}: ${sttResult.message}`);
    }

    transcripts.push(sttResult.text);
  }

  return {
    status: "completed",
    transcripts,
    triggered: transcripts.some((text) => includesTriggerPhrase(text, input.triggerPhrases)),
    suppressedFrames
  };
}

function includesTriggerPhrase(text: string, triggerPhrases: readonly string[]): boolean {
  const normalized = text.toLowerCase();

  return triggerPhrases.some((phrase) => {
    const trigger = phrase.trim().toLowerCase();
    return trigger !== "" && normalized.includes(trigger);
  });
}
```

- [ ] **Step 4: Run test to verify GREEN**

Run:

```bash
npm run test -- tests/live-voice-turn.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add suppressed-frame test**

Add:

```ts
it("does not send suppressed microphone frames to STT", async () => {
  let sttCalls = 0;
  const echoControl: EchoControlProvider = {
    describe: () => ({ provider: "half_duplex", mode: "half_duplex" }),
    checkHealth: () =>
      Promise.resolve({
        ok: true,
        provider: "half_duplex",
        mode: "half_duplex",
        engine: "half-duplex-safety"
      }),
    acceptFarEndReference: () => Promise.resolve(),
    processNearEnd: () =>
      Promise.resolve({
        action: "suppress",
        reason: "far_end_tail_mute",
        diagnostics: {
          provider: "half_duplex",
          residualEchoProbability: 1,
          voiceActivity: false
        }
      }),
    flush: () => Promise.resolve()
  };

  const result = await runLiveVoiceTurn({
    now: () => "2026-06-16T10:00:00.000Z",
    tts: successfulSingleChunkTts(),
    stt: {
      warmup: () => {
        throw new Error("warmup is not part of this runtime test");
      },
      transcribe: () => {
        sttCalls += 1;
        throw new Error("suppressed audio must not be transcribed");
      }
    },
    echoControl,
    text: "おはようピコ。",
    micFrames: [sampleNearEndFrame()],
    triggerPhrases: ["ピコ"]
  });

  expect(sttCalls).toBe(0);
  expect(result.suppressedFrames).toBe(1);
  expect(result.transcripts).toEqual([]);
  expect(result.triggered).toBe(false);
});
```

Add local test helpers in the same test file:

```ts
function sampleNearEndFrame(): VoicePcmFrame {
  return {
    id: "mic-1",
    direction: "near_end",
    audio: new Uint8Array([4, 5, 6]),
    encoding: "pcm16le",
    sampleRateHz: 16_000,
    channels: 1,
    capturedAt: "2026-06-16T10:00:00.050Z",
    durationMs: 300
  };
}

function successfulSingleChunkTts(): TtsClient {
  return {
    synthesize: () =>
      Promise.resolve({
        ok: true,
        chunks: [
          {
            sentenceIndex: 0,
            text: "おはようピコ。",
            audio: new Uint8Array([1, 2, 3]),
            encoding: "pcm16le",
            sampleRateHz: 16_000,
            channels: 1,
            durationMs: 120,
            source: {
              serviceId: "local-aivis",
              provider: "aivis-speech",
              speakerId: 888_753_760
            }
          }
        ],
        totalDurationMs: 120,
        source: {
          serviceId: "local-aivis",
          provider: "aivis-speech",
          speakerId: 888_753_760
        }
      })
  };
}
```

- [ ] **Step 6: Run test**

Run:

```bash
npm run test -- tests/live-voice-turn.test.ts
```

Expected: PASS.

## Task 3: Field Harness AEC Acceptance Classification

**Files:**
- Modify: `scripts/field/voice-echo-pickup.ts`
- Test: `tests/voice-echo-pickup-field.test.ts`

- [ ] **Step 1: Write failing tests for `aec_pass` versus `safety_pass`**

Update `VoiceEchoPickupFieldDetails` expectations in `tests/voice-echo-pickup-field.test.ts` by adding:

```ts
it("reports real AEC pass only for non-half-duplex pass results", () => {
  expect(
    classifyVoiceEchoPickupResult({
      provider: "web_rtc_aec3",
      echoAction: "pass",
      transcriptText: "こんにちは。",
      transcriptLength: 6,
      resumedTranscriptText: "",
      resumedTranscriptLength: 0,
      triggerPhrases: ["おはよう", "ピコ"]
    })
  ).toEqual({
    status: "passed",
    details: {
      acceptance: "aec_pass",
      provider: "web_rtc_aec3",
      echoAction: "pass",
      transcriptLength: 6,
      resumedTranscriptLength: 0,
      wouldTriggerSession: false
    }
  });
});

it("reports half-duplex suppression as a safety pass rather than AEC acceptance", () => {
  expect(
    classifyVoiceEchoPickupResult({
      provider: "half_duplex",
      echoAction: "suppress",
      transcriptText: "",
      transcriptLength: 0,
      resumedTranscriptText: "",
      resumedTranscriptLength: 0,
      triggerPhrases: ["おはよう", "ピコ"]
    })
  ).toEqual({
    status: "passed",
    details: {
      acceptance: "safety_pass",
      provider: "half_duplex",
      echoAction: "suppress",
      transcriptLength: 0,
      resumedTranscriptLength: 0,
      wouldTriggerSession: false
    }
  });
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
npm run test -- tests/voice-echo-pickup-field.test.ts
```

Expected: FAIL because `provider` and `acceptance` are not part of the classification types.

- [ ] **Step 3: Implement acceptance details**

In `scripts/field/voice-echo-pickup.ts`:

```ts
import type { EchoControlProviderKind } from "../../src/modules/voice/echo-control.js";
```

Update details:

```ts
export type VoiceEchoPickupAcceptance = "aec_pass" | "safety_pass" | "fail";

export type VoiceEchoPickupFieldDetails = {
  readonly acceptance: VoiceEchoPickupAcceptance;
  readonly provider: EchoControlProviderKind;
  readonly echoAction: "pass" | "suppress";
  readonly transcriptLength: number;
  readonly resumedTranscriptLength: number;
  readonly wouldTriggerSession: boolean;
};
```

Update classification input:

```ts
export type VoiceEchoPickupClassificationInput = {
  readonly provider: EchoControlProviderKind;
  readonly echoAction: "pass" | "suppress";
  readonly transcriptText: string;
  readonly transcriptLength: number;
  readonly resumedTranscriptText: string;
  readonly resumedTranscriptLength: number;
  readonly triggerPhrases: readonly string[];
};
```

Compute acceptance:

```ts
const acceptance: VoiceEchoPickupAcceptance = wouldTriggerSession
  ? "fail"
  : input.provider === "half_duplex"
    ? "safety_pass"
    : "aec_pass";
```

Include `provider` and `acceptance` in `details`.

- [ ] **Step 4: Update existing tests for new details**

Existing expectations in `tests/voice-echo-pickup-field.test.ts` must pass `provider` into `classifyVoiceEchoPickupResult()` and expect `provider` plus `acceptance` in `details`. Use `provider: "half_duplex"` for suppression-only safety cases and `provider: "web_rtc_aec3"` for AEC pass cases.

- [ ] **Step 5: Run focused test**

Run:

```bash
npm run test -- tests/voice-echo-pickup-field.test.ts
```

Expected: PASS.

## Task 4: Field Harness Provider Health Gate

**Files:**
- Modify: `scripts/field/voice-echo-pickup.ts`
- Test: `tests/voice-echo-pickup-field.test.ts`

- [ ] **Step 1: Write failing test for AEC provider health requirement**

Add a pure helper test by exporting a new helper `assertVoiceEchoPickupProviderReady()`:

```ts
it("fails AEC field readiness when the configured provider is unhealthy", async () => {
  await expect(
    assertVoiceEchoPickupProviderReady({
      describe: () => ({ provider: "web_rtc_aec3", mode: "aec" }),
      checkHealth: () =>
        Promise.resolve({
          ok: false,
          provider: "web_rtc_aec3",
          mode: "aec",
          reason: "unavailable",
          message: "sidecar refused connection"
        }),
      acceptFarEndReference: () => Promise.resolve(),
      processNearEnd: () => {
        throw new Error("field readiness must fail before processing audio");
      },
      flush: () => Promise.resolve()
    })
  ).rejects.toThrow(
    "pico voice echo pickup AEC provider is unhealthy: sidecar refused connection"
  );
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
npm run test -- tests/voice-echo-pickup-field.test.ts
```

Expected: FAIL because `assertVoiceEchoPickupProviderReady` does not exist.

- [ ] **Step 3: Implement field provider readiness**

In `scripts/field/voice-echo-pickup.ts`, export:

```ts
export async function assertVoiceEchoPickupProviderReady(
  echoControl: EchoControlProvider
): Promise<void> {
  const metadata = echoControl.describe();
  const health = await echoControl.checkHealth();

  if (!health.ok) {
    throw new Error(`pico voice echo pickup AEC provider is unhealthy: ${health.message}`);
  }

  if (metadata.mode === "aec" && metadata.provider === "half_duplex") {
    throw new Error("pico voice echo pickup mode aec cannot use half_duplex provider");
  }
}
```

Call it in `captureVoiceEchoPickup()` immediately after `const echoControl = createEchoControlProvider(plan);` and before `acceptFarEndReference()`.

- [ ] **Step 4: Run focused test**

Run:

```bash
npm run test -- tests/voice-echo-pickup-field.test.ts
```

Expected: PASS.

## Task 5: Integration Gate and Documentation

**Files:**
- Modify: `docs/field-tests/2026-06-14-voice-echo-pickup.md` only if the report terminology needs a note.
- Do not modify `config/pico.local.yaml` with secrets.

- [ ] **Step 1: Run focused test set**

Run:

```bash
npm run test -- tests/voice-echo-control.test.ts tests/live-voice-turn.test.ts tests/voice-echo-pickup-field.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full local gate**

Run:

```bash
just check
```

Expected: PASS.

- [ ] **Step 3: Inspect for hidden fallback language and raw audio audit**

Run:

```bash
rg -n "fallback|half_duplex|audioBase64|transcript" src scripts tests docs/superpowers/specs/2026-06-14-pico-voice-echo-control-design.md
```

Expected:

- `half_duplex` appears only as explicit mode/safety policy.
- `audioBase64` appears only in HTTP request/response payload parsing and tests.
- No audit event includes raw transcript or base64 audio.

- [ ] **Step 4: Commit implementation**

Only commit if the user has explicitly approved committing this implementation branch. Use:

```bash
git status --short
git add src/modules/voice/echo-control.ts src/runtime/live-voice-turn.ts scripts/field/voice-echo-pickup.ts tests/voice-echo-control.test.ts tests/live-voice-turn.test.ts tests/voice-echo-pickup-field.test.ts docs/superpowers/plans/2026-06-16-pico-aec-runtime.md
git commit -m "Implement AEC-gated live voice runtime"
```

## Self-Review

- Spec coverage:
  - Explicit provider health: Task 1 and Task 4.
  - STT/session trigger consumes echo-controlled mic only: Task 2.
  - TTS supplies far-end reference: Task 2.
  - Real AEC field acceptance distinct from half-duplex: Task 3.
  - No hidden fallback: Task 1, Task 3, Task 5.
  - No raw audio/transcripts in audit: Task 5 inspection.
- Placeholder scan:
  - This plan intentionally contains no open placeholders or unspecified implementation slots.
- Type consistency:
  - `EchoControlProvider.checkHealth()` is introduced before use in runtime and field harness tasks.
  - `VoiceEchoPickupAcceptance` values match the spec: `aec_pass`, `safety_pass`, `fail`.
