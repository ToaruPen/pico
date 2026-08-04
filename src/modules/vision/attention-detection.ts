import { createRequire } from "node:module";

export type AttentionTargetLabel = "head" | "face";

export type AttentionDetection = {
  readonly label: AttentionTargetLabel;
  readonly confidence: number;
  readonly boundingBox: {
    readonly xMin: number;
    readonly yMin: number;
    readonly xMax: number;
    readonly yMax: number;
  };
};

export type AttentionDetectionModel = {
  readonly detect: (jpeg: Uint8Array) => Promise<readonly AttentionDetection[]>;
};

export type PintoAttentionParserOptions = {
  readonly inputWidth: number;
  readonly inputHeight: number;
  readonly headConfidenceThreshold: number;
  readonly faceConfidenceThreshold: number;
};

export type AttentionTensorInput = {
  readonly data: Float32Array;
  readonly dims: readonly number[];
};

export type AttentionPreprocessor = (jpeg: Uint8Array) => Promise<AttentionTensorInput>;

export type AttentionSharpPipeline = {
  readonly rotate: () => AttentionSharpPipeline;
  readonly resize: (options: {
    readonly width: number;
    readonly height: number;
    readonly fit: "fill";
  }) => AttentionSharpPipeline;
  readonly removeAlpha: () => AttentionSharpPipeline;
  readonly raw: () => AttentionSharpPipeline;
  readonly toBuffer: (options: { readonly resolveWithObject: true }) => Promise<{
    readonly data: Uint8Array;
    readonly info: {
      readonly width: number;
      readonly height: number;
      readonly channels: number;
    };
  }>;
};

export type AttentionSharpRuntime = (jpeg: Uint8Array) => AttentionSharpPipeline;

export type AttentionOnnxTensor = {
  readonly data: Float32Array | readonly number[];
  readonly dims: readonly number[];
};

export type AttentionOnnxSession = {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  readonly run: (feeds: Record<string, unknown>) => Promise<Record<string, AttentionOnnxTensor>>;
};

export type AttentionOnnxRuntime = {
  readonly Tensor: new (type: "float32", data: Float32Array, dims: readonly number[]) => unknown;
  readonly InferenceSession: {
    readonly create: (modelPath: string) => Promise<AttentionOnnxSession>;
  };
};

export type SharpBgrTensorPreprocessorOptions = {
  readonly inputWidth: number;
  readonly inputHeight: number;
  readonly runtime?: AttentionSharpRuntime;
};

export type PintoAttentionDetectionModelOptions = PintoAttentionParserOptions & {
  readonly modelPath: string;
  readonly runtime?: AttentionOnnxRuntime;
  readonly preprocess?: AttentionPreprocessor;
  readonly inputName?: string;
  readonly outputName?: string;
};

const nodeRequire = createRequire(import.meta.url);
const pintoHeadClassId = 1;
const pintoFaceClassId = 3;
const pintoOutputRowLength = 7;
const attentionLabelPriority: readonly AttentionTargetLabel[] = ["face", "head"];

export function parsePintoAttentionDetections(
  data: Float32Array,
  dimensions: readonly number[],
  options: PintoAttentionParserOptions
): readonly AttentionDetection[] {
  requireParserOptions(options);
  requireOutputDimensions(data, dimensions);
  const detections: AttentionDetection[] = [];

  for (let offset = 0; offset < data.length; offset += pintoOutputRowLength) {
    const detection = parsePintoAttentionRow(data, offset, options);
    if (detection !== undefined) {
      detections.push(detection);
    }
  }

  return detections;
}

export function selectAttentionTarget(
  detections: readonly AttentionDetection[]
): AttentionDetection | undefined {
  return highestPriorityAttentionTarget(detections);
}

function highestPriorityAttentionTarget(
  detections: readonly AttentionDetection[]
): AttentionDetection | undefined {
  for (const label of attentionLabelPriority) {
    const candidates = detections.filter((detection) => detection.label === label);
    if (candidates.length > 0) {
      return highestRankedAttentionTarget(candidates);
    }
  }
  return undefined;
}

function highestRankedAttentionTarget(
  candidates: readonly AttentionDetection[]
): AttentionDetection | undefined {
  return candidates.reduce<AttentionDetection | undefined>((selected, candidate) => {
    if (selected === undefined) {
      return candidate;
    }

    return attentionTargetRank(candidate) > attentionTargetRank(selected) ? candidate : selected;
  }, undefined);
}

export function createSharpBgrTensorPreprocessor(
  options: SharpBgrTensorPreprocessorOptions
): AttentionPreprocessor {
  const inputWidth = requirePositiveInteger(options.inputWidth, "PINTO attention input width");
  const inputHeight = requirePositiveInteger(options.inputHeight, "PINTO attention input height");
  const runtime = options.runtime ?? loadSharpRuntime();

  return async (jpeg) => {
    const { data, info } = await runtime(jpeg)
      .rotate()
      .resize({
        width: inputWidth,
        height: inputHeight,
        fit: "fill"
      })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (
      info.width !== inputWidth ||
      info.height !== inputHeight ||
      info.channels !== 3 ||
      data.byteLength !== inputWidth * inputHeight * 3
    ) {
      throw new Error("PINTO attention image tensor must be RGB at configured dimensions");
    }

    return {
      data: toNchwBgrFloatTensor(data, inputWidth, inputHeight),
      dims: [1, 3, inputHeight, inputWidth]
    };
  };
}

export async function createPintoAttentionDetectionModel(
  options: PintoAttentionDetectionModelOptions
): Promise<AttentionDetectionModel> {
  requireParserOptions(options);
  const modelPath = requireText(options.modelPath, "PINTO attention model path is required");
  const runtime = options.runtime ?? loadOnnxRuntime();
  const preprocess =
    options.preprocess ??
    createSharpBgrTensorPreprocessor({
      inputWidth: options.inputWidth,
      inputHeight: options.inputHeight
    });
  const session = await runtime.InferenceSession.create(modelPath);
  const inputName =
    options.inputName ?? session.inputNames[0] ?? fail("PINTO attention ONNX model has no input");
  const outputName =
    options.outputName ??
    session.outputNames[0] ??
    fail("PINTO attention ONNX model has no output");

  return {
    async detect(jpeg) {
      const tensorInput = await preprocess(jpeg);
      const outputs = await session.run({
        [inputName]: new runtime.Tensor("float32", tensorInput.data, tensorInput.dims)
      });
      const output = outputs[outputName] ?? fail("PINTO attention ONNX output is missing");
      const data =
        output.data instanceof Float32Array ? output.data : Float32Array.from(output.data);

      return parsePintoAttentionDetections(data, output.dims, options);
    }
  };
}

// eslint-disable-next-line complexity
function parsePintoAttentionRow(
  data: Float32Array,
  offset: number,
  options: PintoAttentionParserOptions
): AttentionDetection | undefined {
  const classId = data[offset + 1];
  const confidence = data[offset + 2];
  const label = attentionLabelForClassId(classId);

  if (
    label === undefined ||
    confidence === undefined ||
    !Number.isFinite(confidence) ||
    confidence < confidenceThreshold(label, options)
  ) {
    return undefined;
  }

  const xMin = normalizedCoordinate(data[offset + 3], options.inputWidth);
  const yMin = normalizedCoordinate(data[offset + 4], options.inputHeight);
  const xMax = normalizedCoordinate(data[offset + 5], options.inputWidth);
  const yMax = normalizedCoordinate(data[offset + 6], options.inputHeight);

  if (
    xMin === undefined ||
    yMin === undefined ||
    xMax === undefined ||
    yMax === undefined ||
    xMax <= xMin ||
    yMax <= yMin
  ) {
    return undefined;
  }

  return {
    label,
    confidence,
    boundingBox: {
      xMin,
      yMin,
      xMax,
      yMax
    }
  };
}

function attentionLabelForClassId(classId: number | undefined): AttentionTargetLabel | undefined {
  if (classId === pintoHeadClassId) {
    return "head";
  }
  if (classId === pintoFaceClassId) {
    return "face";
  }
  return undefined;
}

function confidenceThreshold(
  label: AttentionTargetLabel,
  options: PintoAttentionParserOptions
): number {
  return label === "face" ? options.faceConfidenceThreshold : options.headConfidenceThreshold;
}

function normalizedCoordinate(value: number | undefined, dimension: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.min(1, Math.max(0, value / dimension));
}

function attentionTargetRank(detection: AttentionDetection): number {
  const box = detection.boundingBox;
  const area = (box.xMax - box.xMin) * (box.yMax - box.yMin);
  return detection.confidence * Math.sqrt(area);
}

function requireOutputDimensions(data: Float32Array, dimensions: readonly number[]): void {
  if (dimensions.length < 2 || dimensions.at(-1) !== pintoOutputRowLength) {
    throw new Error("PINTO attention output must end in rows of seven values");
  }
  const elementCount = dimensions.reduce((product, dimension) => product * dimension, 1);
  if (
    dimensions.some((dimension) => !Number.isInteger(dimension) || dimension < 0) ||
    elementCount !== data.length
  ) {
    throw new Error("PINTO attention output dimensions do not match its data");
  }
}

function requireParserOptions(options: PintoAttentionParserOptions): void {
  requirePositiveInteger(options.inputWidth, "PINTO attention input width");
  requirePositiveInteger(options.inputHeight, "PINTO attention input height");
  requireConfidenceThreshold(
    options.headConfidenceThreshold,
    "PINTO attention head confidence threshold"
  );
  requireConfidenceThreshold(
    options.faceConfidenceThreshold,
    "PINTO attention face confidence threshold"
  );
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }

  return value;
}

function requireConfidenceThreshold(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be from 0 through 1`);
  }
}

function requireText(value: string, message: string): string {
  if (value.trim() === "") {
    throw new Error(message);
  }

  return value;
}

function toNchwBgrFloatTensor(rgb: Uint8Array, width: number, height: number): Float32Array {
  const pixelCount = width * height;
  const tensor = new Float32Array(pixelCount * 3);

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const rgbOffset = pixel * 3;
    tensor[pixel] = rgb[rgbOffset + 2] ?? 0;
    tensor[pixelCount + pixel] = rgb[rgbOffset + 1] ?? 0;
    tensor[pixelCount * 2 + pixel] = rgb[rgbOffset] ?? 0;
  }

  return tensor;
}

function loadSharpRuntime(): AttentionSharpRuntime {
  return nodeRequire("sharp") as AttentionSharpRuntime;
}

function loadOnnxRuntime(): AttentionOnnxRuntime {
  return nodeRequire("onnxruntime-node") as AttentionOnnxRuntime;
}

function fail(message: string): never {
  throw new Error(message);
}
