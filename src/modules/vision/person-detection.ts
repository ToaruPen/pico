import { createRequire } from "node:module";

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

export type OnnxPersonDetectionTensorInput = {
  readonly data: Float32Array;
  readonly dims: readonly number[];
};

export type OnnxPersonDetectionPreprocessor = (
  frame: Uint8Array
) => Promise<OnnxPersonDetectionTensorInput>;

export type SharpRgbTensorPipeline = {
  readonly rotate: () => SharpRgbTensorPipeline;
  readonly resize: (options: {
    readonly width: number;
    readonly height: number;
    readonly fit: "fill";
  }) => SharpRgbTensorPipeline;
  readonly removeAlpha: () => SharpRgbTensorPipeline;
  readonly raw: () => SharpRgbTensorPipeline;
  readonly toBuffer: (options: { readonly resolveWithObject: true }) => Promise<{
    readonly data: Uint8Array;
    readonly info: {
      readonly width: number;
      readonly height: number;
      readonly channels: number;
    };
  }>;
};

export type SharpRgbTensorRuntime = (frame: Uint8Array) => SharpRgbTensorPipeline;

export type SharpRgbTensorPreprocessorOptions = {
  readonly inputWidth: number;
  readonly inputHeight: number;
  readonly runtime?: SharpRgbTensorRuntime;
};

export type OnnxPersonDetectionTensor = {
  readonly data: Float32Array | readonly number[];
  readonly dims: readonly number[];
};

export type OnnxPersonDetectionSession = {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  readonly run: (
    feeds: Record<string, unknown>
  ) => Promise<Record<string, OnnxPersonDetectionTensor>>;
};

export type OnnxPersonDetectionRuntime = {
  readonly Tensor: new (type: "float32", data: Float32Array, dims: readonly number[]) => unknown;
  readonly InferenceSession: {
    readonly create: (modelPath: string, options?: unknown) => Promise<OnnxPersonDetectionSession>;
  };
};

export type OnnxPersonDetectionOutputLayout =
  | "xyxy_score_class"
  | "cxcywh_score_class"
  | "yolox_coco_raw";

export type OnnxPersonDetectionCoordinateScale = "pixel" | "normalized";

export type OnnxPersonDetectionModelOptions = {
  readonly modelPath: string;
  readonly frameSize: PersonDetectionFrameInput["frameSize"];
  readonly runtime?: OnnxPersonDetectionRuntime;
  readonly preprocessFrame: OnnxPersonDetectionPreprocessor;
  readonly inputName?: string;
  readonly outputName?: string;
  readonly outputLayout?: OnnxPersonDetectionOutputLayout;
  readonly coordinateScale?: OnnxPersonDetectionCoordinateScale;
  readonly confidenceThreshold?: number;
  readonly personClassId?: number;
  readonly nmsIouThreshold?: number;
  readonly sessionOptions?: unknown;
};

export type CoremlPersonDetectionModelOptions = Omit<
  OnnxPersonDetectionModelOptions,
  "outputLayout" | "sessionOptions"
> & {
  readonly coremlFlags?: number;
};

type ResolvedOnnxPersonDetectionOptions = {
  readonly modelPath: string;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly outputLayout: OnnxPersonDetectionOutputLayout;
  readonly coordinateScale: OnnxPersonDetectionCoordinateScale;
  readonly confidenceThreshold: number;
  readonly personClassId: number;
  readonly nmsIouThreshold: number;
};

type OnnxDetectionRow = {
  readonly first: number;
  readonly second: number;
  readonly third: number;
  readonly fourth: number;
  readonly score: number;
  readonly classId: number;
};

type YoloxGridCell = {
  readonly x: number;
  readonly y: number;
  readonly stride: number;
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
  readonly drain: () => Promise<void>;
  readonly start: () => void;
  readonly stop: () => void;
};

const nodeRequire = createRequire(import.meta.url);
const defaultCoremlFlags = 18;

export async function createOnnxPersonDetectionModel(
  options: OnnxPersonDetectionModelOptions
): Promise<PersonDetectionModel> {
  const resolved = resolveOnnxPersonDetectionOptions(options);
  const runtime = options.runtime ?? loadOnnxRuntime();
  const session = await runtime.InferenceSession.create(resolved.modelPath, options.sessionOptions);
  const inputName = resolveSessionName(
    options.inputName,
    session.inputNames,
    "pico person detection ONNX model has no input"
  );
  const outputName = resolveSessionName(
    options.outputName,
    session.outputNames,
    "pico person detection ONNX model has no output"
  );

  return {
    async detect(frame) {
      const tensorInput = await options.preprocessFrame(frame);
      const feeds = {
        [inputName]: new runtime.Tensor("float32", tensorInput.data, tensorInput.dims)
      };
      const outputs = await session.run(feeds);
      const output = outputs[outputName] ?? fail("pico person detection ONNX output is missing");

      return parseOnnxPersonDetections({
        output,
        ...resolved
      });
    }
  };
}

export function createCoremlPersonDetectionModel(
  options: CoremlPersonDetectionModelOptions
): Promise<PersonDetectionModel> {
  const coremlFlags = requireNonNegativeInteger(
    options.coremlFlags ?? defaultCoremlFlags,
    "pico person detection CoreML flags"
  );

  return createOnnxPersonDetectionModel({
    ...options,
    outputLayout: "yolox_coco_raw",
    coordinateScale: options.coordinateScale ?? "pixel",
    sessionOptions: {
      executionProviders: [
        {
          name: "coreml",
          coreMlFlags: coremlFlags
        }
      ]
    }
  });
}

function resolveOnnxPersonDetectionOptions(
  options: OnnxPersonDetectionModelOptions
): ResolvedOnnxPersonDetectionOptions {
  const modelPath = requireDetectionText(
    options.modelPath,
    "pico person detection ONNX model path is required"
  );
  const frameWidth = requirePositiveDimension(
    options.frameSize.width,
    "pico person detection frame width"
  );
  const frameHeight = requirePositiveDimension(
    options.frameSize.height,
    "pico person detection frame height"
  );
  const outputLayout = options.outputLayout ?? "xyxy_score_class";
  const coordinateScale = options.coordinateScale ?? "pixel";
  const confidenceThreshold = options.confidenceThreshold ?? 0;
  const personClassId = options.personClassId ?? 0;
  const nmsIouThreshold = options.nmsIouThreshold ?? 0.45;
  requireConfidenceThreshold(confidenceThreshold);
  requireNonNegativeInteger(personClassId, "pico person detection ONNX person class id");
  requireNmsIouThreshold(nmsIouThreshold);

  return {
    modelPath,
    frameWidth,
    frameHeight,
    outputLayout,
    coordinateScale,
    confidenceThreshold,
    personClassId,
    nmsIouThreshold
  };
}

function resolveSessionName(
  preferredName: string | undefined,
  names: readonly string[],
  message: string
): string {
  return preferredName ?? names[0] ?? fail(message);
}

export function createSharpRgbTensorPreprocessor(
  options: SharpRgbTensorPreprocessorOptions
): OnnxPersonDetectionPreprocessor {
  const inputWidth = requirePositiveInteger(
    options.inputWidth,
    "pico person detection tensor input width"
  );
  const inputHeight = requirePositiveInteger(
    options.inputHeight,
    "pico person detection tensor input height"
  );
  const runtime = options.runtime ?? loadSharpRuntime();

  return async (frame) => {
    const { data, info } = await runtime(frame)
      .rotate()
      .resize({
        width: inputWidth,
        height: inputHeight,
        fit: "fill"
      })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (info.width !== inputWidth || info.height !== inputHeight || info.channels !== 3) {
      throw new Error("pico person detection image tensor must be RGB at configured dimensions");
    }

    return {
      data: toNchwRgbFloatTensor(data, inputWidth, inputHeight),
      dims: [1, 3, inputHeight, inputWidth]
    };
  };
}

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
  let activeTick: Promise<void> | undefined;
  let runToken = 0;
  let stopped = true;

  const tick = (): void => {
    if (stopped || inFlight) {
      return;
    }

    inFlight = true;
    const activeRunToken = runToken;
    const tickPromise = Promise.resolve()
      .then(() => options.captureFrame())
      .then(async (frame) => {
        if (frame === undefined) {
          return;
        }

        if (stopped || activeRunToken !== runToken) {
          return;
        }

        const capturedAt = (options.now ?? (() => new Date().toISOString()))();
        const detections = await options.model.detect(frame);
        if (activeRunToken !== runToken) {
          return;
        }

        options.publish(
          normalizePersonDetectionFrame({
            sourceId: options.sourceId,
            capturedAt,
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
        if (activeTick === tickPromise) {
          activeTick = undefined;
        }
      });
    activeTick = tickPromise;
  };

  return {
    async drain() {
      await activeTick;
    },
    start() {
      if (timer !== undefined) {
        return;
      }

      stopped = false;
      runToken += 1;
      timer = setInterval(tick, frameIntervalMs);
    },
    stop() {
      stopped = true;
      runToken += 1;
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

function parseOnnxPersonDetections(input: {
  readonly output: OnnxPersonDetectionTensor;
  readonly outputLayout: OnnxPersonDetectionOutputLayout;
  readonly coordinateScale: OnnxPersonDetectionCoordinateScale;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly personClassId: number;
  readonly confidenceThreshold: number;
  readonly nmsIouThreshold: number;
}): readonly PersonDetectionInput[] {
  const rows = toOnnxRows(input.output);
  const yoloxGridCells =
    input.outputLayout === "yolox_coco_raw"
      ? buildYoloxGridCellsForRows(rows.length, input.frameWidth, input.frameHeight)
      : undefined;
  const detections = rows
    .map((row, index) =>
      parseOnnxPersonDetectionRow(
        row,
        yoloxGridCells?.[index] === undefined
          ? input
          : {
              ...input,
              yoloxGridCell: yoloxGridCells[index]
            }
      )
    )
    .filter((detection): detection is PersonDetectionInput => detection !== undefined);

  return input.outputLayout === "yolox_coco_raw"
    ? suppressOverlappingDetections(detections, input.nmsIouThreshold)
    : detections;
}

function toOnnxRows(output: OnnxPersonDetectionTensor): readonly (readonly number[])[] {
  const rowLength = output.dims.at(-1);

  if (rowLength === undefined || rowLength < 6) {
    throw new Error("pico person detection ONNX output row must contain at least 6 values");
  }

  const values = Array.from(output.data);

  if (values.length % rowLength !== 0) {
    throw new Error("pico person detection ONNX output is malformed");
  }

  const rows: number[][] = [];
  for (let index = 0; index < values.length; index += rowLength) {
    rows.push(values.slice(index, index + rowLength));
  }

  return rows;
}

function parseOnnxPersonDetectionRow(
  row: readonly number[],
  options: {
    readonly outputLayout: OnnxPersonDetectionOutputLayout;
    readonly coordinateScale: OnnxPersonDetectionCoordinateScale;
    readonly frameWidth: number;
    readonly frameHeight: number;
    readonly personClassId: number;
    readonly confidenceThreshold: number;
    readonly yoloxGridCell?: YoloxGridCell;
  }
): PersonDetectionInput | undefined {
  if (options.outputLayout === "yolox_coco_raw") {
    return parseYoloxCocoRawPersonDetectionRow(row, options);
  }

  const parsed = readOnnxDetectionRow(row);
  const confidence = roundDetectionScore(requireConfidenceThreshold(parsed.score));

  if (isIgnoredOnnxDetection(confidence, parsed.classId, options)) {
    return undefined;
  }

  return {
    label: "person",
    confidence,
    box:
      options.outputLayout === "xyxy_score_class"
        ? parseXyxyBox(parsed.first, parsed.second, parsed.third, parsed.fourth, options)
        : parseCxcywhBox(parsed.first, parsed.second, parsed.third, parsed.fourth, options)
  };
}

function parseYoloxCocoRawPersonDetectionRow(
  row: readonly number[],
  options: {
    readonly coordinateScale: OnnxPersonDetectionCoordinateScale;
    readonly frameWidth: number;
    readonly frameHeight: number;
    readonly personClassId: number;
    readonly confidenceThreshold: number;
    readonly yoloxGridCell?: YoloxGridCell;
  }
): PersonDetectionInput | undefined {
  if (row.length !== 85) {
    throw new Error("pico person detection YOLOX COCO output row must contain 85 values");
  }

  const centerX = requireNumber(row[0], "pico person detection YOLOX center x");
  const centerY = requireNumber(row[1], "pico person detection YOLOX center y");
  const width = requireNumber(row[2], "pico person detection YOLOX box width");
  const height = requireNumber(row[3], "pico person detection YOLOX box height");
  const objectness = requireConfidenceThreshold(row[4], "pico person detection YOLOX objectness");
  const personScoreIndex = 5 + options.personClassId;
  const personScore = requireConfidenceThreshold(
    row[personScoreIndex],
    "pico person detection YOLOX person score"
  );
  const confidence = roundDetectionScore(objectness * personScore);

  if (confidence < options.confidenceThreshold) {
    return undefined;
  }

  const decodedBox =
    options.yoloxGridCell === undefined
      ? parseCxcywhBox(centerX, centerY, width, height, options)
      : decodeYoloxCocoRawBox(centerX, centerY, width, height, options.yoloxGridCell);
  const box = clampBoxToFrame(decodedBox, options.frameWidth, options.frameHeight);

  if (box === undefined) {
    return undefined;
  }

  return {
    label: "person",
    confidence,
    box
  };
}

function buildYoloxGridCellsForRows(
  rowCount: number,
  frameWidth: number,
  frameHeight: number
): readonly YoloxGridCell[] | undefined {
  const cells = buildYoloxGridCells(frameWidth, frameHeight);

  return cells.length === rowCount ? cells : undefined;
}

function buildYoloxGridCells(frameWidth: number, frameHeight: number): readonly YoloxGridCell[] {
  const strides = [8, 16, 32] as const;
  const cells: YoloxGridCell[] = [];

  for (const stride of strides) {
    const width = Math.floor(frameWidth / stride);
    const height = Math.floor(frameHeight / stride);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        cells.push({ x, y, stride });
      }
    }
  }

  return cells;
}

function decodeYoloxCocoRawBox(
  centerXOffset: number,
  centerYOffset: number,
  widthLog: number,
  heightLog: number,
  grid: YoloxGridCell
): PersonDetectionBoxInput {
  const width =
    Math.exp(requireNumber(widthLog, "pico person detection YOLOX box width")) * grid.stride;
  const height =
    Math.exp(requireNumber(heightLog, "pico person detection YOLOX box height")) * grid.stride;
  const centerX =
    (requireNumber(centerXOffset, "pico person detection YOLOX center x") + grid.x) * grid.stride;
  const centerY =
    (requireNumber(centerYOffset, "pico person detection YOLOX center y") + grid.y) * grid.stride;

  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width: requirePositiveDimension(width, "pico person detection ONNX box width"),
    height: requirePositiveDimension(height, "pico person detection ONNX box height")
  };
}

function readOnnxDetectionRow(row: readonly number[]): OnnxDetectionRow {
  const [first, second, third, fourth, score, classId] = row;

  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    score === undefined ||
    classId === undefined
  ) {
    throw new Error("pico person detection ONNX output row must contain at least 6 values");
  }

  return { first, second, third, fourth, score, classId };
}

function isIgnoredOnnxDetection(
  confidence: number,
  classId: number,
  options: {
    readonly personClassId: number;
    readonly confidenceThreshold: number;
  }
): boolean {
  return confidence < options.confidenceThreshold || Math.round(classId) !== options.personClassId;
}

function parseXyxyBox(
  xMin: number,
  yMin: number,
  xMax: number,
  yMax: number,
  options: {
    readonly coordinateScale: OnnxPersonDetectionCoordinateScale;
    readonly frameWidth: number;
    readonly frameHeight: number;
  }
): PersonDetectionBoxInput {
  const scaledXMin = scaleCoordinate(xMin, options.coordinateScale, options.frameWidth);
  const scaledYMin = scaleCoordinate(yMin, options.coordinateScale, options.frameHeight);
  const scaledXMax = scaleCoordinate(xMax, options.coordinateScale, options.frameWidth);
  const scaledYMax = scaleCoordinate(yMax, options.coordinateScale, options.frameHeight);

  return {
    x: scaledXMin,
    y: scaledYMin,
    width: requirePositiveDimension(
      scaledXMax - scaledXMin,
      "pico person detection ONNX box width"
    ),
    height: requirePositiveDimension(
      scaledYMax - scaledYMin,
      "pico person detection ONNX box height"
    )
  };
}

function parseCxcywhBox(
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  options: {
    readonly coordinateScale: OnnxPersonDetectionCoordinateScale;
    readonly frameWidth: number;
    readonly frameHeight: number;
  }
): PersonDetectionBoxInput {
  const scaledWidth = scaleCoordinate(width, options.coordinateScale, options.frameWidth);
  const scaledHeight = scaleCoordinate(height, options.coordinateScale, options.frameHeight);
  const scaledCenterX = scaleCoordinate(centerX, options.coordinateScale, options.frameWidth);
  const scaledCenterY = scaleCoordinate(centerY, options.coordinateScale, options.frameHeight);

  return {
    x: scaledCenterX - scaledWidth / 2,
    y: scaledCenterY - scaledHeight / 2,
    width: requirePositiveDimension(scaledWidth, "pico person detection ONNX box width"),
    height: requirePositiveDimension(scaledHeight, "pico person detection ONNX box height")
  };
}

function suppressOverlappingDetections(
  detections: readonly PersonDetectionInput[],
  nmsIouThreshold: number
): readonly PersonDetectionInput[] {
  const kept: PersonDetectionInput[] = [];
  const sorted = [...detections].sort((left, right) => right.confidence - left.confidence);

  for (const detection of sorted) {
    if (
      kept.every((keptDetection) => boxIou(detection.box, keptDetection.box) <= nmsIouThreshold)
    ) {
      kept.push(detection);
    }
  }

  return kept;
}

function boxIou(left: PersonDetectionBoxInput, right: PersonDetectionBoxInput): number {
  const leftXMax = left.x + left.width;
  const leftYMax = left.y + left.height;
  const rightXMax = right.x + right.width;
  const rightYMax = right.y + right.height;
  const intersectionWidth = Math.max(0, Math.min(leftXMax, rightXMax) - Math.max(left.x, right.x));
  const intersectionHeight = Math.max(0, Math.min(leftYMax, rightYMax) - Math.max(left.y, right.y));
  const intersectionArea = intersectionWidth * intersectionHeight;
  const leftArea = left.width * left.height;
  const rightArea = right.width * right.height;
  const unionArea = leftArea + rightArea - intersectionArea;

  return unionArea <= 0 ? 0 : intersectionArea / unionArea;
}

function clampBoxToFrame(
  box: PersonDetectionBoxInput,
  frameWidth: number,
  frameHeight: number
): PersonDetectionBoxInput | undefined {
  const xMin = Math.max(0, box.x);
  const yMin = Math.max(0, box.y);
  const xMax = Math.min(frameWidth, box.x + box.width);
  const yMax = Math.min(frameHeight, box.y + box.height);
  const width = xMax - xMin;
  const height = yMax - yMin;

  if (width <= 0 || height <= 0) {
    return undefined;
  }

  return {
    x: xMin,
    y: yMin,
    width,
    height
  };
}

function scaleCoordinate(
  value: number,
  coordinateScale: OnnxPersonDetectionCoordinateScale,
  dimension: number
): number {
  const parsed = requireNumber(value, "pico person detection ONNX coordinate");

  return coordinateScale === "normalized" ? parsed * dimension : parsed;
}

function toNchwRgbFloatTensor(
  pixels: Uint8Array,
  inputWidth: number,
  inputHeight: number
): Float32Array {
  const pixelCount = inputWidth * inputHeight;
  const expectedLength = pixelCount * 3;

  if (pixels.byteLength !== expectedLength) {
    throw new Error("pico person detection image tensor has unexpected byte length");
  }

  const tensor = new Float32Array(expectedLength);

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const sourceIndex = pixelIndex * 3;
    const red = pixels[sourceIndex];
    const green = pixels[sourceIndex + 1];
    const blue = pixels[sourceIndex + 2];

    if (red === undefined || green === undefined || blue === undefined) {
      throw new Error("pico person detection image tensor has unexpected byte length");
    }

    tensor[pixelIndex] = red / 255;
    tensor[pixelCount + pixelIndex] = green / 255;
    tensor[2 * pixelCount + pixelIndex] = blue / 255;
  }

  return tensor;
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

function requireNonNegativeInteger(value: unknown, label: string): number {
  const parsed = requireNonNegativeNumber(value, label);

  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be a non-negative integer`);
  }

  return parsed;
}

function requireConfidenceThreshold(
  value: unknown,
  label = "pico person detection confidence"
): number {
  const parsed = requireNumber(value, label);

  if (parsed < 0 || parsed > 1) {
    throw new Error(`${label} must be >= 0 and <= 1`);
  }

  return parsed;
}

function requireNmsIouThreshold(value: unknown): number {
  const parsed = requireNumber(value, "pico person detection NMS IoU threshold");

  if (parsed <= 0 || parsed > 1) {
    throw new Error("pico person detection NMS IoU threshold must be > 0 and <= 1");
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

function roundDetectionScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function loadOnnxRuntime(): OnnxPersonDetectionRuntime {
  return nodeRequire("onnxruntime-node") as OnnxPersonDetectionRuntime;
}

function loadSharpRuntime(): SharpRgbTensorRuntime {
  return nodeRequire("sharp") as SharpRgbTensorRuntime;
}

function fail(message: string): never {
  throw new Error(message);
}
