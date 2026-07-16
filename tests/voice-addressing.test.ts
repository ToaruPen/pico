import { describe, expect, it } from "vitest";

import {
  classifyBusyVoiceControl,
  extractAddressedRequest
} from "../src/runtime/voice-addressing.js";

describe("voice addressing", () => {
  it("extracts the request after a configured wake name", () => {
    expect(extractAddressedRequest("ピコ、文書を作って", ["ピコ", "pico"])).toEqual({
      trigger: "ピコ",
      request: "文書を作って"
    });
    expect(extractAddressedRequest("pico  確認して", ["ピコ", "pico"])).toEqual({
      trigger: "pico",
      request: "確認して"
    });
  });

  it("returns an empty request for a wake-only utterance", () => {
    expect(extractAddressedRequest("ピコ！", ["ピコ"])).toEqual({
      trigger: "ピコ",
      request: ""
    });
  });

  it("matches only the leading address and preserves the same word in the request", () => {
    expect(extractAddressedRequest("ピコ、ピコの状態を教えて", ["ピコ"])).toEqual({
      trigger: "ピコ",
      request: "ピコの状態を教えて"
    });
    expect(extractAddressedRequest("文書を作って", ["ピコ"])).toBeUndefined();
  });
});

describe("busy voice controls", () => {
  it("classifies only bounded local controls", () => {
    expect(classifyBusyVoiceControl("今どう？")).toBe("status");
    expect(classifyBusyVoiceControl("まだ？")).toBe("status");
    expect(classifyBusyVoiceControl("やめて")).toBe("cancel");
    expect(classifyBusyVoiceControl("中止して。")).toBe("cancel");
    expect(classifyBusyVoiceControl("じゃあ終わり")).toBe("end");
    expect(classifyBusyVoiceControl("別の文書も作って")).toBe("new_request");
  });
});
