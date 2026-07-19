import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import picoExtension from "../src/index.js";

describe("Pi-owned subagent capability", () => {
  it("loads Pico and the Pi subagent tool into one SDK session", async () => {
    const subagentExtensionPath = fileURLToPath(
      new URL(
        "../node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts",
        import.meta.url
      )
    );
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: getAgentDir(),
      additionalExtensionPaths: [subagentExtensionPath],
      extensionFactories: [picoExtension],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(process.cwd()),
      noTools: "builtin",
      tools: ["subagent"]
    });

    try {
      await session.bindExtensions({ mode: "print" });

      expect(session.getActiveToolNames()).toEqual(["subagent"]);
    } finally {
      session.dispose();
    }
  });

  it("uses the Pi SDK session adapter for production resident interactions", async () => {
    const [extensionSource, serviceSource, runnerSource, directHarnessSource] = await Promise.all([
      readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/runtime/resident-voice-service.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/runtime/resident-voice-runner.ts", import.meta.url), "utf8"),
      readFile(new URL("../scripts/resident/voice.ts", import.meta.url), "utf8")
    ]);

    for (const productionSource of [extensionSource, serviceSource, runnerSource]) {
      expect(productionSource).not.toContain("createAgentSession");
    }

    expect(extensionSource).toContain("createPiAgentTurnClient");
    expect(extensionSource).not.toContain("createPiHostTurnClient");
    expect(serviceSource).toContain("createPiAgent");
    expect(directHarnessSource).toContain("createPiAgentTurnClient");
    expect(directHarnessSource).toContain("runDirectResidentVoiceHarness");
  });
});
