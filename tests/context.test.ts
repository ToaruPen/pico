import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadFacilityContextFile } from "../src/modules/context/index.js";

async function withContextFile(
  content: string,
  run: (path: string) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pico-context-"));
  const path = join(directory, "facility-context.json");

  try {
    await writeFile(path, content, "utf8");
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("facility context loader", () => {
  it("loads a structured local facility context file", async () => {
    await withContextFile(
      JSON.stringify({
        facility: {
          name: "放課後ケア ひだまり",
          locale: "ja-JP"
        },
        schedules: [
          {
            id: "weekday-flow",
            title: "平日の流れ",
            days: ["monday", "tuesday"],
            time: "15:00-18:00"
          }
        ],
        rules: [
          {
            id: "indoor-shoes",
            title: "室内の約束",
            description: "走らず、困ったらスタッフに声をかける。"
          }
        ],
        rooms: [
          {
            id: "main-room",
            name: "メインルーム",
            notes: "宿題と自由遊びに使う。"
          }
        ],
        notes: [
          {
            id: "rainy-day",
            text: "雨の日は工作セットを早めに準備する。"
          }
        ]
      }),
      async (path) => {
        await expect(loadFacilityContextFile(path)).resolves.toEqual({
          facility: {
            name: "放課後ケア ひだまり",
            locale: "ja-JP"
          },
          schedules: [
            {
              id: "weekday-flow",
              title: "平日の流れ",
              days: ["monday", "tuesday"],
              time: "15:00-18:00"
            }
          ],
          rules: [
            {
              id: "indoor-shoes",
              title: "室内の約束",
              description: "走らず、困ったらスタッフに声をかける。"
            }
          ],
          rooms: [
            {
              id: "main-room",
              name: "メインルーム",
              notes: "宿題と自由遊びに使う。"
            }
          ],
          notes: [
            {
              id: "rainy-day",
              text: "雨の日は工作セットを早めに準備する。"
            }
          ]
        });
      }
    );
  });

  it("rejects malformed facility context files", async () => {
    await withContextFile(
      JSON.stringify({
        facility: {
          name: ""
        },
        schedules: "weekday"
      }),
      async (path) => {
        await expect(loadFacilityContextFile(path)).rejects.toThrow(
          "pico facility context file is malformed"
        );
      }
    );
  });

  it("rejects invalid JSON facility context files", async () => {
    await withContextFile("{", async (path) => {
      await expect(loadFacilityContextFile(path)).rejects.toThrow(
        "pico facility context file is malformed"
      );
    });
  });

  it("rejects unknown facility context fields instead of silently ignoring them", async () => {
    await withContextFile(
      JSON.stringify({
        facility: {
          name: "放課後ケア ひだまり",
          unknown: "ignored"
        }
      }),
      async (path) => {
        await expect(loadFacilityContextFile(path)).rejects.toThrow(
          "pico facility context file is malformed"
        );
      }
    );
  });

  it("rejects individual child profile fields in facility context", async () => {
    await withContextFile(
      JSON.stringify({
        facility: {
          name: "放課後ケア ひだまり"
        },
        childProfiles: []
      }),
      async (path) => {
        await expect(loadFacilityContextFile(path)).rejects.toThrow(
          "pico facility context must not contain individual child profile data"
        );
      }
    );
  });

  it("allows facility-wide child guidance without individual profile fields", async () => {
    await withContextFile(
      JSON.stringify({
        facility: {
          name: "放課後ケア ひだまり"
        },
        notes: [
          {
            id: "child-guidance",
            text: "子ども全体への声かけはスタッフの判断に合わせる。"
          }
        ]
      }),
      async (path) => {
        await expect(loadFacilityContextFile(path)).resolves.toMatchObject({
          facility: {
            name: "放課後ケア ひだまり"
          }
        });
      }
    );
  });
});
