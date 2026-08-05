import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  parseJsonRejectingDuplicateKeys,
  stackChanAttentionReplaySchemaHash,
  validateStackChanAttentionReplaySchemaValue
} from "../scripts/field/stackchan-attention-replay-schema.js";

describe("StackChan attention replay schema", () => {
  it("parses numeric arrays without slicing the remaining document for every number", () => {
    const slice = vi.spyOn(String.prototype, "slice");
    let parsed: unknown;
    let sliceCalls: number;
    try {
      const raw = `[${Array.from({ length: 100 }, (_, index) => index).join(",")}]`;
      parsed = parseJsonRejectingDuplicateKeys(raw, "number-array probe");
      sliceCalls = slice.mock.calls.length;
    } finally {
      slice.mockRestore();
    }
    expect(parsed).toHaveLength(100);
    expect(sliceCalls).toBe(0);
  });

  it("enforces string minLength declarations", () => {
    expect(() =>
      validateStackChanAttentionReplaySchemaValue("", { type: "string", minLength: 1 })
    ).toThrow("at least 1");
  });

  it("hashes object keys using locale-independent code-unit order", () => {
    const expected = createHash("sha256").update('{"A":2,"a":1}').digest("hex");

    expect(stackChanAttentionReplaySchemaHash({ a: 1, A: 2 })).toBe(expected);
  });
});
