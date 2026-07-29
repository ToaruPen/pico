import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildVoiceDesignSpeechInstruction,
  createVoiceDesignSpeechPlanCache,
  formatVoiceDesignEnvelope,
  inspectVoiceDesignEnvelope,
  irodoriVoiceDesignSpeechProfile
} from "../src/modules/voice-design/index.js";

const nonce = "5LZJ29aPpA3MLBfC0c8VGnN6";

describe("VoiceDesign speech envelope", () => {
  it("accepts the exact bounded plan and preserves the canonical response text", () => {
    const text = "今日は石垣市で雨が降る見込みです。傘を持っていきましょう。";
    const envelope = formatVoiceDesignEnvelope(nonce, {
      v: 1,
      style: "calm",
      annotations: []
    });

    expect(
      inspectVoiceDesignEnvelope(`${text}${envelope}`, nonce, irodoriVoiceDesignSpeechProfile)
    ).toEqual({
      text,
      status: "accepted",
      plan: {
        v: 1,
        style: "calm",
        annotations: []
      }
    });
  });

  it.each([
    {
      v: 1,
      style: "calm",
      annotations: [],
      caption: "softly"
    },
    {
      v: 1,
      style: "dramatic",
      annotations: []
    },
    {
      v: 1,
      style: "calm",
      annotations: ["smile"]
    },
    {
      v: 1,
      style: "calm"
    }
  ])("strips but rejects an invalid plan: %#", (plan) => {
    const text = "施設の入口は右手です。";

    expect(
      inspectVoiceDesignEnvelope(
        `${text}${formatVoiceDesignEnvelope(nonce, plan)}`,
        nonce,
        irodoriVoiceDesignSpeechProfile
      )
    ).toEqual({
      text,
      status: "rejected"
    });
  });

  it("strips a stale nonce without applying its speech plan", () => {
    const text = "こんにちは。";
    const rendered = `${text}${formatVoiceDesignEnvelope("stale_nonce", {
      v: 1,
      style: "cheerful",
      annotations: []
    })}`;

    expect(inspectVoiceDesignEnvelope(rendered, nonce, irodoriVoiceDesignSpeechProfile)).toEqual({
      text,
      status: "rejected"
    });
  });

  it("strips but rejects an oversized hidden suffix", () => {
    const text = "施設の入口は右手です。";
    const rendered = `${text}${formatVoiceDesignEnvelope(nonce, {
      v: 1,
      style: "calm",
      annotations: [],
      padding: "x".repeat(2_048)
    })}`;

    expect(inspectVoiceDesignEnvelope(rendered, nonce, irodoriVoiceDesignSpeechProfile)).toEqual({
      text,
      status: "rejected"
    });
  });

  it("strips but rejects a hidden suffix with an invalid nonce", () => {
    const text = "こんにちは。";
    const rendered = `${text}${formatVoiceDesignEnvelope("!".repeat(256), {
      v: 1,
      style: "calm",
      annotations: []
    })}`;

    expect(inspectVoiceDesignEnvelope(rendered, nonce, irodoriVoiceDesignSpeechProfile)).toEqual({
      text,
      status: "rejected"
    });
  });

  it("does not treat an embedded marker as a hidden suffix envelope", () => {
    const text = `説明例: ${formatVoiceDesignEnvelope(nonce, {
      v: 1,
      style: "clear",
      annotations: []
    })}\n以上です。`;

    expect(inspectVoiceDesignEnvelope(text, nonce, irodoriVoiceDesignSpeechProfile)).toEqual({
      text,
      status: "absent"
    });
  });

  it.each([
    `\n\n<!--pico-voice-design:${nonce}`,
    `\n\n<!--pico-voice-design:${nonce.slice(0, 12)}`,
    `\n\n<!--pico-voice-design:${nonce}\n{"v":1`,
    `\n\n<!--pico-voice-design:${nonce}\r\n{"v":1,"style":"calm","annotations":[]}\r\n-->`,
    `\n\n<!--pico-voice-design:${nonce}\n{"v":1,"style":"calm","annotations":[]}`
  ])("strips but rejects a malformed trailing suffix", (suffix) => {
    const text = "不完全な制御情報は読み上げません。";

    expect(
      inspectVoiceDesignEnvelope(`${text}${suffix}`, nonce, irodoriVoiceDesignSpeechProfile)
    ).toEqual({
      text,
      status: "rejected"
    });
  });

  it("preserves an embedded marker when a valid envelope follows at the final suffix", () => {
    const text = `説明例: ${formatVoiceDesignEnvelope(nonce, {
      v: 1,
      style: "clear",
      annotations: []
    })}\nこの例示も読み上げ本文です。`;
    const rendered = `${text}${formatVoiceDesignEnvelope(nonce, {
      v: 1,
      style: "calm",
      annotations: []
    })}`;

    expect(inspectVoiceDesignEnvelope(rendered, nonce, irodoriVoiceDesignSpeechProfile)).toEqual({
      text,
      status: "accepted",
      plan: {
        v: 1,
        style: "calm",
        annotations: []
      }
    });
  });

  it("strips but rejects duplicate JSON object keys", () => {
    const text = "重複キーは受理しません。";
    const rendered = `${text}\n\n<!--pico-voice-design:${nonce}\n{"v":1,"style":"calm","style":"cheerful","annotations":[]}\n-->`;

    expect(inspectVoiceDesignEnvelope(rendered, nonce, irodoriVoiceDesignSpeechProfile)).toEqual({
      text,
      status: "rejected"
    });
  });

  it("correlates a plan with assistant identity and clean-text SHA-256", () => {
    const cache = createVoiceDesignSpeechPlanCache();
    const text = "同じ本文です。";
    const plan = {
      v: 1,
      style: "clear",
      annotations: []
    } as const;

    cache.record({
      assistantTimestamp: 12_345,
      textSha256: createHash("sha256").update(text, "utf8").digest("hex"),
      plan
    });

    expect(cache.resolve({ assistantTimestamp: 12_346, text })).toBeUndefined();
    expect(cache.resolve({ assistantTimestamp: 12_345, text: `${text}変更` })).toBeUndefined();
    expect(cache.resolve({ assistantTimestamp: 12_345, text })).toEqual(plan);
    expect(cache.resolve({ assistantTimestamp: 12_345, text })).toBeUndefined();
  });

  it("builds resident-only instructions from the verified profile allowlists", () => {
    const instruction = buildVoiceDesignSpeechInstruction(nonce, irodoriVoiceDesignSpeechProfile);

    expect(instruction).toContain("neutral | calm | cheerful | clear");
    expect(instruction).toContain("Use calm when no other style is clearly justified.");
    expect(instruction).toContain('{"v":1,"style":"calm","annotations":[]}');
    expect(instruction).toContain('"annotations":[]');
    expect(instruction).toContain(nonce);
    expect(instruction).toContain("Do not add any other fields");
    expect(instruction).not.toContain("smile");
  });
});
