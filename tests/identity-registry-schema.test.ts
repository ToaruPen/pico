import { describe, expect, it } from "vitest";

import {
  type ChildIdentity,
  parseRosterRow,
  ROSTER_CLEAR_LITERAL,
  ROSTER_COLUMNS,
  ROSTER_LIMITS,
  ROSTER_SCHEMA_VERSION,
  validateChildIdentity
} from "../src/modules/identity-registry/schema.js";

const subjectReference = "018f0f4e-0000-7000-8000-000000000001";

describe("minimal identity registry schema", () => {
  it("owns only the fields needed for pseudonym resolution", () => {
    expect(ROSTER_SCHEMA_VERSION).toBe(1);
    expect(ROSTER_CLEAR_LITERAL).toBe("[[CLEAR]]");
    expect(ROSTER_COLUMNS.map(({ header }) => header)).toEqual([
      "pico_id",
      "revision",
      "姓",
      "名",
      "姓かな",
      "名かな",
      "あだ名",
      "状態"
    ]);
    expect(ROSTER_LIMITS).toEqual({
      maximumFileBytes: 10 * 1024 * 1024,
      maximumRosterRows: 2_000,
      maximumWorkbookCells: 50_000,
      maximumCellCodePoints: 512,
      maximumNameCodePoints: 64,
      maximumAliases: 20,
      maximumAliasCodePoints: 64
    });
  });

  it("parses a minimal create row", () => {
    expect(
      parseRosterRow(
        {
          pico_id: undefined,
          revision: undefined,
          姓: " 架空 ",
          名: " 花子 ",
          姓かな: "カクウ",
          名かな: "ハナコ",
          あだ名: "はなちゃん\n ＨＡＮＡ ",
          状態: "active"
        },
        2
      )
    ).toEqual({
      ok: true,
      row: {
        kind: "create",
        rowNumber: 2,
        name: {
          family: "架空",
          given: "花子",
          familyKana: "かくう",
          givenKana: "はなこ"
        },
        aliases: ["はなちゃん", "HANA"],
        status: "active"
      }
    });
  });

  it("parses keep, set, and alias clear operations for updates", () => {
    expect(
      parseRosterRow(
        {
          pico_id: subjectReference,
          revision: 3,
          姓: undefined,
          名: "華子",
          姓かな: undefined,
          名かな: undefined,
          あだ名: ROSTER_CLEAR_LITERAL,
          状態: "inactive"
        },
        7
      )
    ).toEqual({
      ok: true,
      row: {
        kind: "update",
        rowNumber: 7,
        subjectRef: subjectReference,
        revision: 3,
        family: { kind: "keep" },
        given: { kind: "set", value: "華子" },
        familyKana: { kind: "keep" },
        givenKana: { kind: "keep" },
        aliases: { kind: "clear" },
        status: { kind: "set", value: "inactive" }
      }
    });
  });

  it("rejects fields outside the minimal contract", () => {
    const result = parseRosterRow(
      {
        pico_id: undefined,
        revision: undefined,
        姓: "架空",
        名: "花子",
        姓かな: "かくう",
        名かな: "はなこ",
        あだ名: undefined,
        状態: "active",
        生年月日: "2018-07-12"
      },
      2
    );

    expect(result).toEqual({
      ok: false,
      errors: [{ rowNumber: 2, fieldCode: "row", code: "unknown_field" }]
    });
  });

  it("does not treat a non-string pico_id as a create row", () => {
    const result = parseRosterRow(
      {
        pico_id: 123,
        revision: undefined,
        姓: "架空",
        名: "花子",
        姓かな: "かくう",
        名かな: "はなこ",
        あだ名: undefined,
        状態: "active"
      },
      2
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid roster row");
    expect(result.errors).toContainEqual({
      rowNumber: 2,
      fieldCode: "pico_id",
      code: "invalid_value"
    });
  });

  it("validates the exact persisted shape", () => {
    const identity: ChildIdentity = {
      subjectRef: subjectReference,
      revision: 1,
      name: {
        family: "架空",
        given: "花子",
        familyKana: "かくう",
        givenKana: "はなこ"
      },
      aliases: ["はなちゃん"],
      status: "active",
      updatedAt: "2026-07-12T00:00:00.000Z"
    };

    expect(validateChildIdentity(identity, 1)).toEqual([]);
    expect(validateChildIdentity({ ...identity, birthDate: "2018-07-12" }, 1)).toContainEqual({
      rowNumber: 1,
      fieldCode: "row",
      code: "unknown_field"
    });
    expect(validateChildIdentity({ ...identity, status: "left" }, 1)).toContainEqual({
      rowNumber: 1,
      fieldCode: "status",
      code: "invalid_value"
    });
  });
});
