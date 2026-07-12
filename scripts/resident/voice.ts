import { createPiAgentTurnClient } from "../../src/runtime/pi-agent-turn.js";
import { runDirectResidentVoiceHarness } from "../../src/runtime/resident-voice-runner.js";

await runDirectResidentVoiceHarness(createPiAgentTurnClient);
