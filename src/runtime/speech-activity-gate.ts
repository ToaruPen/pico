import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { defineVoicePcmFrame, type VoicePcmFrame } from "../modules/voice/echo-control.js";

export type SpeechActivityProvider = "energy" | "ten_vad";

export type SpeechActivityGateResult = {
  readonly speech: boolean;
  readonly provider: SpeechActivityProvider;
  readonly rmsDb: number;
  readonly probability?: number;
};

export type SpeechActivityGate = {
  readonly process: (frame: VoicePcmFrame) => Promise<SpeechActivityGateResult>;
  readonly close?: () => void | Promise<void>;
};

export type EnergySpeechActivityGateOptions = {
  readonly minRmsDb: number;
};

export type TenWasmSpeechActivityGateOptions = {
  readonly jsPath: string;
  readonly wasmPath: string;
  readonly hopSize: 160 | 256;
  readonly threshold: number;
  readonly moduleFactory?: TenVadModuleFactory;
};

export type TenVadModuleFactory = (input: {
  readonly wasmBinary: Uint8Array;
  readonly locateFile: (path: string) => string;
  readonly noInitialRun: boolean;
  readonly noExitRuntime: boolean;
}) => Promise<TenVadWasmModule> | TenVadWasmModule;

type TenVadWasmModule = {
  readonly HEAP16: Int16Array;
  readonly HEAP32: Int32Array;
  readonly HEAPF32: Float32Array;
  readonly _malloc: (byteLength: number) => number;
  readonly _free: (pointer: number) => void;
  readonly _ten_vad_create: (handlePointer: number, hopSize: number, threshold: number) => number;
  readonly _ten_vad_process: (
    handle: number,
    audioPointer: number,
    hopSize: number,
    probabilityPointer: number,
    flagPointer: number
  ) => number;
  readonly _ten_vad_destroy?: (handlePointer: number) => number;
};

export function createEnergySpeechActivityGate(
  options: EnergySpeechActivityGateOptions
): SpeechActivityGate {
  const minRmsDatabase = requireRmsDatabase(options.minRmsDb, "pico voice energy VAD minRmsDb");

  return {
    process(frame) {
      const normalized = defineVoicePcmFrame(frame);
      const rmsDatabase = calculatePcm16leRmsDatabase(normalized.audio);

      return Promise.resolve({
        speech: rmsDatabase >= minRmsDatabase,
        provider: "energy",
        rmsDb: rmsDatabase
      });
    }
  };
}

export async function createTenWasmSpeechActivityGate(
  options: TenWasmSpeechActivityGateOptions
): Promise<SpeechActivityGate> {
  const hopSize = requireTenHopSize(options.hopSize);
  const threshold = requireProbability(options.threshold, "pico voice TEN VAD threshold");
  const module = await loadTenVadModule(options);
  const handlePointer = module._malloc(4);
  const audioPointer = module._malloc(hopSize * 2);
  const probabilityPointer = module._malloc(4);
  const flagPointer = module._malloc(4);

  try {
    const createResult = module._ten_vad_create(handlePointer, hopSize, threshold);

    if (createResult !== 0) {
      throw new Error(`pico voice TEN VAD create failed: ${createResult}`);
    }
  } catch (error) {
    module._free(flagPointer);
    module._free(probabilityPointer);
    module._free(audioPointer);
    module._free(handlePointer);
    throw error;
  }

  const handle = module.HEAP32[handlePointer >> 2] ?? 0;

  if (handle === 0) {
    module._free(flagPointer);
    module._free(probabilityPointer);
    module._free(audioPointer);
    module._free(handlePointer);
    throw new Error("pico voice TEN VAD did not return a native handle");
  }

  return {
    process(frame) {
      return Promise.resolve().then(() => {
        const normalized = defineTenVadFrame(frame, hopSize);
        const samples = readPcm16leSamples(normalized.audio);
        module.HEAP16.set(samples, audioPointer >> 1);

        const processResult = module._ten_vad_process(
          handle,
          audioPointer,
          hopSize,
          probabilityPointer,
          flagPointer
        );

        if (processResult !== 0) {
          throw new Error(`pico voice TEN VAD process failed: ${processResult}`);
        }

        const probability = module.HEAPF32[probabilityPointer >> 2] ?? 0;
        const flag = module.HEAP32[flagPointer >> 2] ?? 0;

        return {
          speech: flag === 1,
          provider: "ten_vad",
          rmsDb: calculatePcm16leRmsDatabase(normalized.audio),
          probability
        };
      });
    },
    close() {
      module._ten_vad_destroy?.(handlePointer);
      module._free(flagPointer);
      module._free(probabilityPointer);
      module._free(audioPointer);
      module._free(handlePointer);
    }
  };
}

function readPcm16leSamples(audio: Uint8Array): Int16Array {
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const samples = new Int16Array(audio.byteLength / 2);

  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true);
  }

  return samples;
}

export function calculatePcm16leRmsDatabase(audio: Uint8Array): number {
  if (audio.byteLength < 2) {
    return Number.NEGATIVE_INFINITY;
  }

  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const sampleCount = Math.floor(audio.byteLength / 2);
  let squareSum = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getInt16(index * 2, true) / 32_768;
    squareSum += sample * sample;
  }

  if (squareSum === 0) {
    return Number.NEGATIVE_INFINITY;
  }

  return 20 * Math.log10(Math.sqrt(squareSum / sampleCount));
}

async function loadTenVadModule(
  options: TenWasmSpeechActivityGateOptions
): Promise<TenVadWasmModule> {
  if (options.moduleFactory !== undefined) {
    return options.moduleFactory({
      wasmBinary: new Uint8Array(),
      locateFile: (path) => (path.endsWith(".wasm") ? options.wasmPath : path),
      noInitialRun: true,
      noExitRuntime: true
    });
  }

  const wasmBinary = await readFile(options.wasmPath);
  const imported = (await import(pathToFileURL(options.jsPath).href)) as {
    readonly default?: TenVadModuleFactory;
  } & TenVadModuleFactory;
  const factory = imported.default ?? imported;

  return factory({
    wasmBinary,
    locateFile: (path) => (path.endsWith(".wasm") ? options.wasmPath : path),
    noInitialRun: true,
    noExitRuntime: true
  });
}

function defineTenVadFrame(frame: VoicePcmFrame, hopSize: 160 | 256): VoicePcmFrame {
  const normalized = defineVoicePcmFrame(frame);

  if (normalized.sampleRateHz !== 16_000 || normalized.channels !== 1) {
    throw new Error("pico voice TEN VAD requires mono 16 kHz PCM16LE frames");
  }

  if (normalized.audio.byteLength !== hopSize * 2) {
    throw new Error(`pico voice TEN VAD requires exactly ${hopSize} samples per frame`);
  }

  return normalized;
}

function requireTenHopSize(value: number): 160 | 256 {
  if (value === 160 || value === 256) {
    return value;
  }

  throw new Error("pico voice TEN VAD hopSize must be 160 or 256");
}

function requireProbability(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be >= 0 and <= 1`);
  }

  return value;
}

function requireRmsDatabase(value: number, label: string): number {
  if (!Number.isFinite(value) || value < -120 || value > 0) {
    throw new Error(`${label} must be >= -120 and <= 0`);
  }

  return value;
}
