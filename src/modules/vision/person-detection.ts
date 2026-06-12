export type PersonDetectionBoxInput = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type PersonDetectionInput = {
  readonly label: string;
  readonly confidence: number;
  readonly box: PersonDetectionBoxInput;
};

export type PersonDetectionFrameInput = {
  readonly sourceId: string;
  readonly capturedAt: string;
  readonly frameSize: {
    readonly width: number;
    readonly height: number;
  };
  readonly confidenceThreshold: number;
  readonly detections: readonly PersonDetectionInput[];
};

export type PersonDetection = {
  readonly label: "person";
  readonly confidence: number;
  readonly boundingBox: {
    readonly xMin: number;
    readonly yMin: number;
    readonly xMax: number;
    readonly yMax: number;
  };
};

export type PersonDetectionFrame = {
  readonly sourceId: string;
  readonly capturedAt: string;
  readonly detections: readonly PersonDetection[];
};

export type PersonDetectionModel = {
  readonly detect: (frame: Uint8Array) => Promise<readonly PersonDetectionInput[]>;
};

export type PersonDetectionStreamOptions = {
  readonly sourceId: string;
  readonly frameIntervalMs: number;
  readonly confidenceThreshold: number;
  readonly frameSize: PersonDetectionFrameInput["frameSize"];
  readonly captureFrame: () => Promise<Uint8Array | undefined>;
  readonly model: PersonDetectionModel;
  readonly publish: (frame: PersonDetectionFrame) => void;
  readonly reportError?: (error: Error) => void;
  readonly now?: () => string;
};

export type PersonDetectionStream = {
  readonly start: () => void;
  readonly stop: () => void;
};

export function normalizePersonDetectionFrame(
  input: PersonDetectionFrameInput
): PersonDetectionFrame {
  const sourceId = requireDetectionText(
    input.sourceId,
    "pico person detection source id is required"
  );
  const capturedAt = requireIsoTimestamp(input.capturedAt);
  const frameWidth = requirePositiveDimension(
    input.frameSize.width,
    "pico person detection frame width"
  );
  const frameHeight = requirePositiveDimension(
    input.frameSize.height,
    "pico person detection frame height"
  );
  const confidenceThreshold = requireConfidenceThreshold(input.confidenceThreshold);
  const detections = input.detections
    .map((detection) => normalizeDetection(detection, frameWidth, frameHeight))
    .filter((detection): detection is PersonDetection => detection !== undefined)
    .filter((detection) => detection.confidence >= confidenceThreshold);

  return Object.freeze({
    sourceId,
    capturedAt,
    detections: Object.freeze(detections)
  });
}

export function createPersonDetectionStream(
  options: PersonDetectionStreamOptions
): PersonDetectionStream {
  const frameIntervalMs = requirePositiveInteger(
    options.frameIntervalMs,
    "pico person detection frame interval"
  );
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;
  let stopped = true;

  const tick = (): void => {
    if (stopped || inFlight) {
      return;
    }

    inFlight = true;
    void Promise.resolve()
      .then(() => options.captureFrame())
      .then(async (frame) => {
        if (frame === undefined) {
          return;
        }

        const detections = await options.model.detect(frame);
        if (stopped) {
          return;
        }

        options.publish(
          normalizePersonDetectionFrame({
            sourceId: options.sourceId,
            capturedAt: (options.now ?? (() => new Date().toISOString()))(),
            frameSize: options.frameSize,
            confidenceThreshold: options.confidenceThreshold,
            detections
          })
        );
      })
      .catch((error: unknown) => {
        options.reportError?.(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        inFlight = false;
      });
  };

  return {
    start() {
      if (timer !== undefined) {
        return;
      }

      stopped = false;
      timer = setInterval(tick, frameIntervalMs);
    },
    stop() {
      stopped = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    }
  };
}

function normalizeDetection(
  input: PersonDetectionInput,
  frameWidth: number,
  frameHeight: number
): PersonDetection | undefined {
  const label = requireDetectionText(input.label, "pico person detection label is required");

  if (label !== "person") {
    rejectIdentityLabel(label);

    return undefined;
  }

  return Object.freeze({
    label,
    confidence: requireConfidenceThreshold(input.confidence),
    boundingBox: normalizeBox(input.box, frameWidth, frameHeight)
  });
}

function normalizeBox(
  input: PersonDetectionBoxInput,
  frameWidth: number,
  frameHeight: number
): PersonDetection["boundingBox"] {
  const x = requireNonNegativeNumber(input.x, "pico person detection box x");
  const y = requireNonNegativeNumber(input.y, "pico person detection box y");
  const width = requirePositiveDimension(input.width, "pico person detection box width");
  const height = requirePositiveDimension(input.height, "pico person detection box height");

  return Object.freeze({
    xMin: clampUnit(x / frameWidth),
    yMin: clampUnit(y / frameHeight),
    xMax: clampUnit((x + width) / frameWidth),
    yMax: clampUnit((y + height) / frameHeight)
  });
}

function rejectIdentityLabel(label: string): void {
  if (label.includes(":") || label.includes("#") || label.toLowerCase().includes("face")) {
    throw new Error("pico person detection must not include identity labels");
  }
}

function requireDetectionText(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new Error(message);
  }

  const trimmed = value.trim();

  if (trimmed === "") {
    throw new Error(message);
  }

  return trimmed;
}

function requireIsoTimestamp(value: unknown): string {
  const timestamp = requireDetectionText(value, "pico person detection timestamp is required");
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime()) || date.toISOString() !== timestamp) {
    throw new Error("pico person detection timestamp is invalid");
  }

  return timestamp;
}

function requirePositiveDimension(value: unknown, label: string): number {
  const parsed = requireNumber(value, label);

  if (parsed <= 0) {
    throw new Error(`${label} must be positive`);
  }

  return parsed;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const parsed = requireNumber(value, label);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }

  return parsed;
}

function requireNonNegativeNumber(value: unknown, label: string): number {
  const parsed = requireNumber(value, label);

  if (parsed < 0) {
    throw new Error(`${label} must be non-negative`);
  }

  return parsed;
}

function requireConfidenceThreshold(value: unknown): number {
  const parsed = requireNumber(value, "pico person detection confidence");

  if (parsed < 0 || parsed > 1) {
    throw new Error("pico person detection confidence must be >= 0 and <= 1");
  }

  return parsed;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }

  return value;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}
