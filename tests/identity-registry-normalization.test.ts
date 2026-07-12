import { describe, expect, it } from "vitest";

import {
  assertSafeIdentityText,
  createIdentityLookupMaterials,
  createIdentityLookupQueryVariants,
  type IdentityNormalizationError,
  normalizeIdentityDisplayText,
  normalizeIdentityLookupText,
  normalizeIdentityReading
} from "../src/modules/identity-registry/normalization.js";

describe("minimal identity normalization", () => {
  it("normalizes display, lookup, and reading text", () => {
    expect(normalizeIdentityDisplayText("  ＴＡＮＡＫＡ　 花子  ")).toBe("TANAKA 花子");
    expect(normalizeIdentityLookupText("  ＴＡＮＡＫＡ　花子  ")).toBe("tanaka花子");
    expect(normalizeIdentityLookupText("カクウ　ハナコ")).toBe("かくうはなこ");
    expect(normalizeIdentityReading(" ﾀﾅｶ　ハナコ ")).toBe("たなかはなこ");
  });

  it.each([
    ["NUL", "\u0000"],
    ["C0", "\u001f"],
    ["C1", "\u0085"],
    ["unpaired high surrogate", "\ud800"],
    ["unpaired low surrogate", "\udc00"]
  ])("rejects unsafe %s", (_label, value) => {
    expectNormalizationError(() => assertSafeIdentityText(value), "identity_text_unsafe");
  });

  it("does not broaden the local trust boundary into a format-character policy", () => {
    expect(normalizeIdentityDisplayText("架空\u200b花子")).toBe("架空\u200b花子");
  });

  it("creates exact-first honorific variants", () => {
    expect(createIdentityLookupQueryVariants("はなちゃん")).toEqual(["はなちゃん", "はな"]);
    expect(createIdentityLookupQueryVariants("架空花子さん")).toEqual(["架空花子さん", "架空花子"]);
    expect(createIdentityLookupQueryVariants("さん")).toEqual(["さん"]);
  });

  it("creates only formal, reading, and alias lookup materials", () => {
    expect(
      createIdentityLookupMaterials({
        family: "架空",
        given: "花子",
        familyKana: "カクウ",
        givenKana: "ハナコ",
        aliases: ["はなちゃん", "ＨＡＮＡ", "hana"]
      })
    ).toEqual([
      { kind: "formal", normalizedText: "架空花子" },
      { kind: "reading", normalizedText: "かくうはなこ" },
      { kind: "alias", normalizedText: "はなちゃん" },
      { kind: "alias", normalizedText: "hana" }
    ]);
  });
});

function expectNormalizationError(
  run: () => unknown,
  code: IdentityNormalizationError["code"]
): void {
  expect(run).toThrow(expect.objectContaining({ code, message: code }));
}
