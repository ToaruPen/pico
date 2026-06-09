import type { FuturePicoModuleMetadata } from "../../orchestrator/contracts.js";

export const visionModuleMetadata = {
  kind: "vision",
  status: "planned",
  summary: "Bounded scene understanding through Qwen/Qwen3.5-9B on a protected Windows GPU host.",
  selectedProvider:
    "Qwen/Qwen3.5-9B via Ollama qwen3.5:9b over a Tailscale or Cloudflare-protected SSH tunnel",
  capabilities: [
    {
      id: "vision.describe_scene",
      description: "Return bounded scene summaries as structured text or JSON."
    }
  ]
} as const satisfies FuturePicoModuleMetadata;
