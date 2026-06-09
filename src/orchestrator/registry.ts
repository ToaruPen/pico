import type { PicoModule, PicoModuleKind, PicoModuleMetadata } from "./contracts.js";

export class PicoModuleRegistry {
  readonly #modules = new Map<PicoModuleKind, PicoModule>();

  register(module: PicoModule): void {
    const kind = module.metadata.kind;

    if (this.#modules.has(kind)) {
      throw new Error(`pico module already registered: ${kind}`);
    }

    this.#modules.set(kind, module);
  }

  get(kind: PicoModuleKind): PicoModule {
    const module = this.#modules.get(kind);

    if (module === undefined) {
      throw new Error(`pico module is not registered: ${kind}`);
    }

    return module;
  }

  listMetadata(): readonly PicoModuleMetadata[] {
    return [...this.#modules.values()].map((module) => module.metadata);
  }
}
