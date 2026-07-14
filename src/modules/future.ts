import type { FuturePicoModuleMetadata } from "../orchestrator/contracts.js";
import { cameraModuleMetadata } from "./camera/index.js";
import { channelsModuleMetadata } from "./channels/index.js";
import { visionModuleMetadata } from "./vision/index.js";
import { voiceModuleMetadata } from "./voice/index.js";

export const futurePicoModules = [
  voiceModuleMetadata,
  visionModuleMetadata,
  cameraModuleMetadata,
  channelsModuleMetadata
] as const satisfies readonly FuturePicoModuleMetadata[];
