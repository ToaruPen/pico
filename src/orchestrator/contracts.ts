export type PicoModuleKind =
  | "context"
  | "session"
  | "local_models"
  | "handoff"
  | "audit"
  | "identity_registry"
  | "transport";

export type FuturePicoModuleKind = "voice" | "vision" | "camera" | "channels";

export type PicoModuleStatus = "available" | "planned";

export type PicoModuleCapability = {
  readonly id: string;
  readonly description: string;
};

export type PicoModuleMetadata = {
  readonly kind: PicoModuleKind;
  readonly status: "available";
  readonly summary: string;
  readonly capabilities: readonly PicoModuleCapability[];
};

export type FuturePicoModuleMetadata = {
  readonly kind: FuturePicoModuleKind;
  readonly status: "planned";
  readonly summary: string;
  readonly selectedProvider?: string;
  readonly capabilities: readonly PicoModuleCapability[];
};

export type PicoModule = {
  readonly metadata: PicoModuleMetadata;
};
