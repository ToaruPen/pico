import type { FuturePicoModuleMetadata } from "../../orchestrator/contracts.js";

export const cameraModuleMetadata = {
  kind: "camera",
  status: "planned",
  summary: "Snapshot-oriented camera access through RTSP, with ONVIF only when PTZ is needed.",
  capabilities: []
} as const satisfies FuturePicoModuleMetadata;
