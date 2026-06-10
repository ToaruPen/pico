import type { FuturePicoModuleMetadata } from "../../orchestrator/contracts.js";

export const voiceModuleMetadata = {
  kind: "voice",
  status: "planned",
  summary: "Voice input and output through mlx-whisper and Aivis Speech.",
  capabilities: []
} as const satisfies FuturePicoModuleMetadata;
