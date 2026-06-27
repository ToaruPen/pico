import { afterEach, describe, expect, it, vi } from "vitest";

const piAgentTurnHarness = vi.hoisted(() => ({
  disposeAll: vi.fn<() => Promise<void>>(),
  prompt: vi.fn()
}));

vi.mock("../src/runtime/pi-agent-turn.js", () => ({
  createPiAgentTurnClient: () => ({
    disposeAll: piAgentTurnHarness.disposeAll,
    prompt: piAgentTurnHarness.prompt
  })
}));

describe("resident Pi turn measure field", () => {
  afterEach(() => {
    vi.useRealTimers();
    piAgentTurnHarness.disposeAll.mockReset();
    piAgentTurnHarness.prompt.mockReset();
  });

  it("fails when the Pi Agent reply violates the scripted short response contract", async () => {
    piAgentTurnHarness.disposeAll.mockResolvedValue(undefined);
    piAgentTurnHarness.prompt.mockResolvedValue({
      text: "これは長すぎる返答です。もう一文あります。"
    });
    const { runResidentPiTurnMeasure } = await import(
      "../scripts/field/resident-pi-turn-measure.js"
    );

    await expect(runResidentPiTurnMeasure()).resolves.toMatchObject({
      status: "failed",
      reason: "reply_contract_violation"
    });
  });

  it("fails instead of hanging when the Pi Agent turn misses its deadline", async () => {
    vi.useFakeTimers();
    piAgentTurnHarness.disposeAll.mockResolvedValue(undefined);
    piAgentTurnHarness.prompt.mockReturnValue(new Promise(() => undefined));
    const { runResidentPiTurnMeasure } = await import(
      "../scripts/field/resident-pi-turn-measure.js"
    );

    const running = runResidentPiTurnMeasure();
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(Promise.race([running, Promise.resolve("still_pending")])).resolves.toMatchObject({
      status: "failed",
      reason: "turn_timeout"
    });
    expect(piAgentTurnHarness.disposeAll).toHaveBeenCalledOnce();
  });
});
