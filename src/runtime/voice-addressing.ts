export type AddressedVoiceRequest = {
  readonly trigger: string;
  readonly request: string;
};

export type BusyVoiceControl = "status" | "cancel" | "end" | "new_request";

const leadingSeparator = /^[\s,、。.!！?？:：;；]+/u;
const controlSeparator = /[\s,、。.!！?？:：;；]+/gu;
const statusControls = new Set(["今どう", "まだ", "進み具合は", "状況教えて"]);
const cancelControls = new Set(["やめて", "中止して", "止めて"]);
const endControls = new Set(["終わり", "じゃあ終わり", "おしまい", "じゃあね"]);

export function extractAddressedRequest(
  transcript: string,
  wakeNames: readonly string[]
): AddressedVoiceRequest | undefined {
  const utterance = transcript.trimStart();
  const normalizedUtterance = utterance.toLocaleLowerCase("ja-JP");
  const phrases = [...wakeNames]
    .filter((phrase) => phrase.trim() !== "")
    .sort((left, right) => right.length - left.length);

  for (const configuredPhrase of phrases) {
    const phrase = configuredPhrase.trim();

    if (!normalizedUtterance.startsWith(phrase.toLocaleLowerCase("ja-JP"))) {
      continue;
    }

    return Object.freeze({
      trigger: utterance.slice(0, phrase.length),
      request: utterance.slice(phrase.length).replace(leadingSeparator, "").trim()
    });
  }

  return undefined;
}

export function classifyBusyVoiceControl(transcript: string): BusyVoiceControl {
  const normalized = transcript.replace(controlSeparator, "");

  if (statusControls.has(normalized)) {
    return "status";
  }

  if (cancelControls.has(normalized)) {
    return "cancel";
  }

  if (endControls.has(normalized)) {
    return "end";
  }

  return "new_request";
}
