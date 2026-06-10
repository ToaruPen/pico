import { describe, expect, it } from "vitest";

import { defineSelectedModelEndpoint } from "../src/modules/local-models/index.js";
import { checkProtectedModelEndpointConnectivity } from "../src/modules/transport/index.js";

const selectedEndpoint = defineSelectedModelEndpoint({
  id: "windows-ollama-qwen3-5",
  provider: "ollama",
  model: "qwen3.5:9b",
  host: {
    platform: "windows",
    tunnel: {
      kind: "cloudflare_access_ssh",
      localBaseUrl: "http://127.0.0.1:11434",
      sshTarget: "pico-vision-host"
    }
  }
});

describe("protected model endpoint connectivity", () => {
  it("checks connectivity through the validated selected endpoint", async () => {
    const checkedUrls: string[] = [];

    const result = await checkProtectedModelEndpointConnectivity(selectedEndpoint, {
      canReach(localBaseUrl) {
        checkedUrls.push(localBaseUrl);
        return Promise.resolve(true);
      }
    });

    expect(result).toEqual({
      endpointId: "windows-ollama-qwen3-5",
      reachable: true,
      checkedUrl: "http://127.0.0.1:11434"
    });
    expect(checkedUrls).toEqual(["http://127.0.0.1:11434"]);
  });

  it("reports unreachable protected endpoint connectivity without changing the selected endpoint", async () => {
    const checkedUrls: string[] = [];

    const result = await checkProtectedModelEndpointConnectivity(selectedEndpoint, {
      canReach(localBaseUrl) {
        checkedUrls.push(localBaseUrl);
        return Promise.resolve(false);
      }
    });

    expect(result).toEqual({
      endpointId: "windows-ollama-qwen3-5",
      reachable: false,
      checkedUrl: "http://127.0.0.1:11434"
    });
    expect(checkedUrls).toEqual(["http://127.0.0.1:11434"]);
  });
});
