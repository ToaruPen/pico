import { describe, expect, it } from "vitest";

import { picoIdentity } from "../src/identity/profile.js";
import { buildSystemPrompt } from "../src/identity/system-prompt.js";

describe("pico identity", () => {
  it("defines pico as one named support staff member", () => {
    expect(picoIdentity.role).toBe("resident_ai_support_staff");
    expect(picoIdentity.relationshipToChildren).toContain("named presence");
  });

  it("builds a prompt with responsibility boundaries", () => {
    const prompt = buildSystemPrompt(picoIdentity);

    expect(prompt).toContain("one AI support staff member");
    expect(prompt).toContain("Human staff remain responsible");
    expect(prompt).toContain("Do not track, score, or profile individual children");
  });
});
