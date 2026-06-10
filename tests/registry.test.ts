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

  it("retrieves a registered module by kind", () => {
    const registry = new PicoModuleRegistry();

    registry.register(createContextModule());

    expect(registry.get("context").metadata.kind).toBe("context");
  });

  it("throws when retrieving an unregistered module", () => {
    const registry = new PicoModuleRegistry();

    expect(() => registry.get("context")).toThrow("pico module is not registered: context");
  });
});
