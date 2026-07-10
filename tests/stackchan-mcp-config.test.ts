import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { residentPiAgentToolNames } from "../src/runtime/pi-agent-turn.js";

type StackChanMcpConfig = {
  readonly settings?: {
    readonly toolPrefix?: string;
    readonly disableProxyTool?: boolean;
  };
  readonly mcpServers?: {
    readonly stackchan?: {
      readonly url?: string;
      readonly auth?: string;
      readonly bearerToken?: string;
      readonly bearerTokenEnv?: string;
      readonly lifecycle?: string;
      readonly directTools?: readonly string[];
    };
  };
};

describe("StackChan Pi MCP config", () => {
  it("exposes only the selected resident tools and reads authentication from the environment", () => {
    const path = resolve(process.cwd(), ".pi/mcp.json");
    const config = JSON.parse(readFileSync(path, "utf8")) as StackChanMcpConfig;
    const stackchan = config.mcpServers?.stackchan;

    expect(config.settings).toEqual({
      toolPrefix: "server",
      disableProxyTool: true
    });
    expect(stackchan).toMatchObject({
      url: "http://127.0.0.1:18767/mcp",
      auth: "bearer",
      bearerTokenEnv: "STACKCHAN_TOKEN",
      lifecycle: "lazy"
    });
    expect(stackchan?.bearerToken).toBeUndefined();
    expect(stackchan?.directTools).toEqual([
      "get_status",
      "get_device_info",
      "take_photo",
      "set_volume",
      "set_brightness",
      "move_head",
      "get_head_angles",
      "set_avatar",
      "set_mouth",
      "set_blink",
      "say"
    ]);
  });

  it("keeps the configured direct tools aligned with the resident SDK allowlist", () => {
    const path = resolve(process.cwd(), ".pi/mcp.json");
    const config = JSON.parse(readFileSync(path, "utf8")) as StackChanMcpConfig;
    const configuredToolNames = config.mcpServers?.stackchan?.directTools?.map(
      (toolName) => `stackchan_${toolName}`
    );

    expect(configuredToolNames).toEqual(
      residentPiAgentToolNames.filter((toolName) => toolName.startsWith("stackchan_"))
    );
  });
});
