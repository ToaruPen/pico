import { describe, expect, it } from "vitest";

import {
  createEnergySpeechActivityGate,
  createTenWasmSpeechActivityGate
} from "../src/runtime/speech-activity-gate.js";

describe("speech activity gate", () => {
  it("classifies PCM16LE frames by RMS when the energy provider is selected", async () => {
    const gate = createEnergySpeechActivityGate({ minRmsDb: -50 });

    await expect(gate.process(pcmFrame("silent", 0))).resolves.toMatchObject({
      speech: false,
      provider: "energy"
    });
    await expect(gate.process(pcmFrame("speech", 3_000))).resolves.toMatchObject({
      speech: true,
      provider: "energy"
    });
  });

  it("runs TEN VAD WASM with the configured hop size and threshold", async () => {
    const calls: Array<{
      readonly createHandlePointer?: number;
      readonly destroyHandlePointer?: number;
      readonly hopSize: number;
      readonly threshold: number;
      readonly samples: readonly number[];
    }> = [];
    const module = createInMemoryTenVadModule(calls);
    const gate = await createTenWasmSpeechActivityGate({
      jsPath: "/tmp/ten_vad.js",
      wasmPath: "/tmp/ten_vad.wasm",
      hopSize: 160,
      threshold: 0.5,
      moduleFactory: () => module
    });

    const result = await gate.process(pcmFrame("speech", 3_000));
    await gate.close?.();

    expect(result).toMatchObject({
      speech: true,
      provider: "ten_vad"
    });
    expect(result.probability).toBeCloseTo(0.82);

    expect(calls).toEqual([
      {
        createHandlePointer: 0,
        hopSize: 160,
        threshold: 0.5,
        samples: []
      },
      {
        hopSize: 160,
        threshold: 0.5,
        samples: Array.from({ length: 160 }, () => 3_000)
      },
      {
        destroyHandlePointer: 0,
        hopSize: 160,
        threshold: 0.5,
        samples: []
      }
    ]);
  });
});

function pcmFrame(id: string, sample: number) {
  const sampleRateHz = 16_000;
  const durationMs = 10;
  const sampleCount = (sampleRateHz * durationMs) / 1_000;
  const audio = new Uint8Array(sampleCount * 2);

  for (let index = 0; index < audio.length; index += 2) {
    audio[index] = sample & 0xff;
    audio[index + 1] = (sample >> 8) & 0xff;
  }

  return {
    id,
    direction: "near_end" as const,
    audio,
    encoding: "pcm16le" as const,
    sampleRateHz,
    channels: 1,
    capturedAt: "2026-06-18T00:00:00.000Z",
    durationMs
  };
}

function createInMemoryTenVadModule(
  calls: Array<{
    readonly createHandlePointer?: number;
    readonly destroyHandlePointer?: number;
    readonly hopSize: number;
    readonly threshold: number;
    readonly samples: readonly number[];
  }>
) {
  const buffer = new ArrayBuffer(32_768);
  const HEAP16 = new Int16Array(buffer);
  const HEAP32 = new Int32Array(buffer);
  const HEAPF32 = new Float32Array(buffer);
  let nextPointer = 0;
  let configuredHopSize = 0;
  let configuredThreshold = 0;

  return {
    HEAP16,
    HEAP32,
    HEAPF32,
    _malloc(byteLength: number) {
      const pointer = nextPointer;
      nextPointer += byteLength;

      return pointer;
    },
    _free() {},
    _ten_vad_create(handlePointer: number, hopSize: number, threshold: number) {
      configuredHopSize = hopSize;
      configuredThreshold = threshold;
      calls.push({
        createHandlePointer: handlePointer,
        hopSize: configuredHopSize,
        threshold: configuredThreshold,
        samples: []
      });
      HEAP32[handlePointer >> 2] = 1234;

      return 0;
    },
    _ten_vad_destroy(handlePointer: number) {
      calls.push({
        destroyHandlePointer: handlePointer,
        hopSize: configuredHopSize,
        threshold: configuredThreshold,
        samples: []
      });

      return 0;
    },
    _ten_vad_process(
      _handle: number,
      audioPointer: number,
      hopSize: number,
      probabilityPointer: number,
      flagPointer: number
    ) {
      calls.push({
        hopSize: configuredHopSize,
        threshold: configuredThreshold,
        samples: Array.from(HEAP16.subarray(audioPointer >> 1, (audioPointer >> 1) + hopSize))
      });
      HEAPF32[probabilityPointer >> 2] = 0.82;
      HEAP32[flagPointer >> 2] = 1;

      return 0;
    }
  };
}
