import { createHash, randomBytes } from "node:crypto";

export const voiceDesignStyles = Object.freeze(["neutral", "calm", "cheerful", "clear"] as const);

export type VoiceDesignStyle = (typeof voiceDesignStyles)[number];

export type VoiceDesignSpeechPlan = {
  readonly v: 1;
  readonly style: VoiceDesignStyle;
  readonly annotations: readonly string[];
};

export type VoiceDesignSpeechProfile = {
  readonly profileId: string;
  readonly defaultStyle: VoiceDesignStyle;
  readonly styleAllowlist: readonly VoiceDesignStyle[];
  readonly annotationAllowlistVersion: string;
  readonly annotationAllowlist: Readonly<Record<string, string>>;
  readonly maxAnnotations: number;
  readonly maxEnvelopeBytes: number;
};

export const irodoriVoiceDesignSpeechProfile: VoiceDesignSpeechProfile = Object.freeze({
  profileId: "f0a618870c60d9ee4348449a48a39b12417da141259b5e83472ee13732251842",
  defaultStyle: "calm",
  styleAllowlist: voiceDesignStyles,
  annotationAllowlistVersion: "unverified-empty-v1",
  annotationAllowlist: Object.freeze({}),
  maxAnnotations: 4,
  maxEnvelopeBytes: 512
});

export type VoiceDesignEnvelopeInspection =
  | {
      readonly text: string;
      readonly status: "accepted";
      readonly plan: VoiceDesignSpeechPlan;
    }
  | {
      readonly text: string;
      readonly status: "absent" | "rejected";
    };

export type VoiceDesignSpeechPlanCandidate = {
  readonly assistantTimestamp: number;
  readonly textSha256: string;
  readonly plan: VoiceDesignSpeechPlan;
};

export type VoiceDesignSpeechPlanCache = {
  readonly record: (candidate: VoiceDesignSpeechPlanCandidate) => void;
  readonly resolve: (input: {
    readonly assistantTimestamp: number;
    readonly text: string;
  }) => VoiceDesignSpeechPlan | undefined;
  readonly clear: () => void;
};

const envelopeMarker = "\n\n<!--pico-voice-design:";
const envelopePattern = /^\n\n<!--pico-voice-design:([^\r\n]*)\n([\s\S]*)\n-->$/u;
const exactPlanKeys = Object.freeze(["annotations", "style", "v"]);

export function createVoiceDesignSpeechNonce(): string {
  return randomBytes(18).toString("base64url");
}

export function formatVoiceDesignEnvelope(nonce: string, plan: unknown): string {
  return `\n\n<!--pico-voice-design:${nonce}\n${JSON.stringify(plan)}\n-->`;
}

export function inspectVoiceDesignEnvelope(
  renderedText: string,
  expectedNonce: string,
  profile: VoiceDesignSpeechProfile
): VoiceDesignEnvelopeInspection {
  const markerIndex = renderedText.lastIndexOf(envelopeMarker);
  if (markerIndex === -1) {
    return { text: renderedText, status: "absent" };
  }

  const suffix = renderedText.slice(markerIndex);
  const match = envelopePattern.exec(suffix);
  if (match === null) {
    return { text: renderedText, status: "absent" };
  }

  const text = renderedText.slice(0, markerIndex);
  const [, nonce, serializedPlan] = match;
  if (
    nonce !== expectedNonce ||
    serializedPlan === undefined ||
    Buffer.byteLength(suffix, "utf8") > profile.maxEnvelopeBytes
  ) {
    return { text, status: "rejected" };
  }

  const plan = parseVoiceDesignSpeechPlan(serializedPlan, profile);
  return plan === undefined
    ? { text, status: "rejected" }
    : {
        text,
        status: "accepted",
        plan
      };
}

export function buildVoiceDesignSpeechInstruction(
  nonce: string,
  profile: VoiceDesignSpeechProfile
): string {
  const styles = profile.styleAllowlist.join(" | ");
  const annotationIds = Object.keys(profile.annotationAllowlist);
  const annotationRule =
    annotationIds.length === 0
      ? 'No annotation IDs are verified for this profile. Always use "annotations":[]'
      : `Allowed annotation IDs: ${annotationIds.join(" | ")}`;

  return [
    "## Pico VoiceDesign speech plan (resident voice only)",
    "For each final assistant response, keep the reader-facing response unchanged and append exactly one hidden speech-plan suffix.",
    "Choose the delivery style that best matches the response. Use neutral when no other style is clearly justified.",
    `Allowed styles: ${styles}`,
    `${annotationRule}.`,
    "The JSON object must contain exactly v, style, and annotations. Do not add any other fields.",
    "Do not use free-form captions, descriptions, emoji, kaomoji, speed, seed, steps, or provider parameters.",
    "Append this exact shape as the final bytes of the response:",
    `<!--pico-voice-design:${nonce}`,
    '{"v":1,"style":"neutral","annotations":[]}',
    "-->",
    "Never mention or explain this suffix in the reader-facing response."
  ].join("\n");
}

export function hashVoiceDesignSpeechText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function createVoiceDesignSpeechPlanCache(): VoiceDesignSpeechPlanCache {
  const candidates = new Map<number, VoiceDesignSpeechPlanCandidate>();

  return {
    record(candidate) {
      candidates.set(candidate.assistantTimestamp, candidate);
    },
    resolve(input) {
      const candidate = candidates.get(input.assistantTimestamp);
      if (
        candidate === undefined ||
        candidate.textSha256 !== hashVoiceDesignSpeechText(input.text)
      ) {
        return undefined;
      }

      candidates.delete(input.assistantTimestamp);
      return candidate.plan;
    },
    clear() {
      candidates.clear();
    }
  };
}

function parseVoiceDesignSpeechPlan(
  serializedPlan: string,
  profile: VoiceDesignSpeechProfile
): VoiceDesignSpeechPlan | undefined {
  let value: unknown;
  try {
    value = JSON.parse(serializedPlan);
  } catch {
    return undefined;
  }

  if (
    !isRecord(value) ||
    JSON.stringify(value) !== serializedPlan ||
    !hasExactKeys(value, exactPlanKeys)
  ) {
    return undefined;
  }
  if (value.v !== 1 || !isAllowedStyle(value.style, profile.styleAllowlist)) {
    return undefined;
  }
  const annotations = readAllowedAnnotations(value.annotations, profile);
  if (annotations === undefined) {
    return undefined;
  }

  return Object.freeze({
    v: 1,
    style: value.style,
    annotations
  });
}

function readAllowedAnnotations(
  value: unknown,
  profile: VoiceDesignSpeechProfile
): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > profile.maxAnnotations) {
    return undefined;
  }

  const annotations: string[] = [];
  for (const annotation of value as unknown[]) {
    if (typeof annotation !== "string" || !Object.hasOwn(profile.annotationAllowlist, annotation)) {
      return undefined;
    }
    annotations.push(annotation);
  }

  return new Set(annotations).size === annotations.length ? Object.freeze(annotations) : undefined;
}

function isAllowedStyle(
  value: unknown,
  styleAllowlist: readonly VoiceDesignStyle[]
): value is VoiceDesignStyle {
  return typeof value === "string" && styleAllowlist.some((allowedStyle) => allowedStyle === value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[]
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index])
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
