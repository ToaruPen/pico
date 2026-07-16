import { describe, expect, it } from "vitest";

import { buildMacOsNotificationAppleScript } from "../src/runtime/resident-system-notification.js";

describe("resident system notification", () => {
  it("builds an escaped generic Pico notification without task contents", () => {
    expect(buildMacOsNotificationAppleScript('完了 "確認" \\')).toBe(
      'display notification "完了 \\"確認\\" \\\\" with title "Pico"'
    );
  });
});
