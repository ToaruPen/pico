import { describe, expect, it } from "vitest";

import {
  encodeResidentIoMessage,
  ResidentIoDecoder,
  type ResidentIoMessage
} from "../src/runtime/resident-io-protocol.js";

describe("resident I/O framed protocol", () => {
  it("decodes fragmented and consecutive frames without losing PCM bytes", () => {
    const ready: ResidentIoMessage = {
      kind: "ready",
      engineGeneration: 4,
      sampleRateHz: 16_000,
      channels: 1
    };
    const pcm: ResidentIoMessage = {
      kind: "pcm_frame",
      generation: 11,
      sampleHostTimeNanoseconds: "20000",
      sampleRateHz: 16_000,
      channels: 1,
      frameCount: 2,
      audio: Buffer.from([1, 2, 3, 4])
    };
    const encoded = Buffer.concat([encodeResidentIoMessage(ready), encodeResidentIoMessage(pcm)]);
    const decoder = new ResidentIoDecoder();

    decoder.append(encoded.subarray(0, 7));
    expect(decoder.next()).toBeUndefined();
    decoder.append(encoded.subarray(7));
    expect(decoder.next()).toEqual(ready);
    expect(decoder.next()).toEqual(pcm);
    expect(decoder.next()).toBeUndefined();
  });

  it("preserves uint64 host timestamps as decimal strings", () => {
    const message: ResidentIoMessage = {
      kind: "control_event",
      sequence: 1,
      controlKind: "talk_pressed",
      eventTimestampNanoseconds: "18446744073709551615"
    };
    const decoder = new ResidentIoDecoder();

    decoder.append(encodeResidentIoMessage(message));

    expect(decoder.next()).toEqual(message);
  });

  it("round-trips fixed privacy-safe timing stages without identifiers", () => {
    const message: ResidentIoMessage = {
      kind: "timing_event",
      stage: "key_to_admission",
      durationMs: 1.25
    };
    const decoder = new ResidentIoDecoder();

    decoder.append(encodeResidentIoMessage(message));

    expect(decoder.next()).toEqual(message);
    const encoded = encodeResidentIoMessage(message);
    const metadataLength = encoded.readUInt32BE(8);
    expect(parseJsonRecord(encoded.subarray(16, 16 + metadataLength).toString("utf8"))).toEqual({
      duration_ms: 1.25,
      stage: "key_to_admission"
    });
  });

  it("encodes Node control responses with the Swift snake-case metadata contract", () => {
    const encoded = encodeResidentIoMessage({
      kind: "control_result",
      sequence: 9,
      result: "accepted",
      generation: 11
    });
    const metadataLength = encoded.readUInt32BE(8);
    const metadata = parseJsonRecord(encoded.subarray(16, 16 + metadataLength).toString("utf8"));

    expect(metadata).toEqual({ generation: 11, result: "accepted", sequence: 9 });
  });

  it.each([
    ["suppress_capture", 6],
    ["resume_capture", 7]
  ] as const)("encodes %s with the exact Swift wire fixture", (kind, kindCode) => {
    const metadata = Buffer.from('{"command_id":1}', "utf8");
    const header = Buffer.from([
      0x50,
      0x49,
      0x43,
      0x4f,
      1,
      kindCode,
      0,
      0,
      0,
      0,
      0,
      metadata.byteLength,
      0,
      0,
      0,
      0
    ]);

    expect(encodeResidentIoMessage({ kind, commandId: 1 })).toEqual(
      Buffer.concat([header, metadata])
    );
  });

  it("rejects invalid headers, oversized bodies, and payload on non-PCM messages", () => {
    const wrongVersion = encodeResidentIoMessage({ kind: "shutdown" });
    wrongVersion[4] = 2;
    expect(() => new ResidentIoDecoder().append(wrongVersion)).toThrow(
      "unsupported resident I/O protocol version 2"
    );

    const oversized = encodeResidentIoMessage({ kind: "shutdown" });
    oversized.writeUInt32BE(1_048_577, 12);
    expect(() => new ResidentIoDecoder().append(oversized)).toThrow(
      "resident I/O payload length 1048577 exceeds 1048576"
    );

    const unexpectedPayload = encodeResidentIoMessage({ kind: "shutdown" });
    unexpectedPayload.writeUInt32BE(1, 12);
    expect(() =>
      new ResidentIoDecoder().append(Buffer.concat([unexpectedPayload, Buffer.of(0)]))
    ).toThrow("resident I/O shutdown message must not contain PCM payload");
  });

  it("rejects unknown metadata fields and PCM length mismatches", () => {
    const ready = encodeResidentIoMessage({
      kind: "ready",
      engineGeneration: 1,
      sampleRateHz: 16_000,
      channels: 1
    });
    const metadataLength = ready.readUInt32BE(8);
    const metadata = parseJsonRecord(ready.subarray(16, 16 + metadataLength).toString("utf8"));
    const invalidMetadata = Buffer.from(JSON.stringify({ ...metadata, device_uid: "private" }));
    const invalidReady = Buffer.concat([ready.subarray(0, 8), Buffer.alloc(8), invalidMetadata]);
    invalidReady.writeUInt32BE(invalidMetadata.byteLength, 8);
    expect(() => {
      const decoder = new ResidentIoDecoder();
      decoder.append(invalidReady);
      decoder.next();
    }).toThrow("resident I/O ready metadata is invalid");

    expect(() =>
      encodeResidentIoMessage({
        kind: "pcm_frame",
        generation: 1,
        sampleHostTimeNanoseconds: "1",
        sampleRateHz: 16_000,
        channels: 1,
        frameCount: 2,
        audio: Buffer.from([1, 2])
      })
    ).toThrow("resident I/O PCM byte length does not match frame metadata");
  });
});

function parseJsonRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected JSON object");
  }

  return parsed as Record<string, unknown>;
}
