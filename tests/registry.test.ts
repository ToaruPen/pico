import { describe, expect, it } from "vitest";

import { createContextModule } from "../src/modules/context/index.js";
import { createMemoryModule } from "../src/modules/memory/index.js";
import { PicoModuleRegistry } from "../src/orchestrator/registry.js";

describe("PicoModuleRegistry", () => {
  it("registers and lists first-slice module metadata", () => {
    const registry = new PicoModuleRegistry();

    registry.register(createContextModule());
    registry.register(createMemoryModule());

    expect(registry.listMetadata()).toEqual([
      createContextModule().metadata,
      createMemoryModule().metadata
    ]);
  });

  it("rejects duplicate module registration", () => {
    const registry = new PicoModuleRegistry();

    registry.register(createContextModule());

    expect(() => registry.register(createContextModule())).toThrow(
      "pico module already registered: context"
    );
  });
});
