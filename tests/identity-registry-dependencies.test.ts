import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("minimal identity registry dependencies", () => {
  it("keeps ExcelJS and removes encryption and custom ZIP dependencies", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies?.exceljs).toBe("4.4.0");
    expect(packageJson.dependencies).not.toHaveProperty("@napi-rs/keyring");
    expect(packageJson.dependencies).not.toHaveProperty("yauzl");
    expect(packageJson.devDependencies).not.toHaveProperty("@types/yauzl");
  });
});
