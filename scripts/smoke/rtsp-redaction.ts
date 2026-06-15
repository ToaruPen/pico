export type RtspRedactionInput = {
  readonly username?: string | undefined;
  readonly password?: string | undefined;
  readonly rtspUrl?: string | undefined;
};

export function readRtspSensitiveValues(input: RtspRedactionInput): readonly string[] {
  const values = [input.username, input.password, input.rtspUrl].flatMap((value) =>
    value === undefined ? [] : [value, encodeURIComponent(value)]
  );

  return [...new Set(values.filter((value) => value.trim() !== ""))];
}

export function redactRtspSensitiveValues(
  message: string,
  sensitiveValues: readonly string[]
): string {
  let sanitized = message.replaceAll(/rtsp:\/\/\S+/gu, "[redacted-rtsp-url]");

  for (const value of sensitiveValues) {
    sanitized = sanitized.replaceAll(value, "[redacted]");
  }

  return sanitized;
}
