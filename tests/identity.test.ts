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
    expect(prompt).toContain("- discipline");
    expect(prompt).toContain("- emergency judgment");
    expect(prompt).toContain("- parental communication");
    expect(prompt).toContain("- medical diagnosis");
    expect(prompt).toContain("- legal judgment");
    expect(prompt).toContain("- tracking, scoring, or profiling individual children");
  });

  it("builds a prompt with voice-first response rules", () => {
    const prompt = buildSystemPrompt(picoIdentity);

    expect(prompt).toContain("Voice response rules:");
    expect(prompt).toContain("- Reply in short spoken Japanese");
    expect(prompt).toContain("- Do not use Markdown");
    expect(prompt).toContain("- Avoid bullet lists and visible line breaks");
    expect(prompt).toContain("- When asked for a wake acknowledgement");
  });
});
