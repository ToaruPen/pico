export type ResidentVoiceMeasurementSummary = {
  readonly schemaVersion: 1;
  readonly eventCount: number;
  readonly invalidLineCount: number;
  readonly skippedLineCount: number;
  readonly runs: readonly ResidentVoiceRunMeasurement[];
};

export type ResidentVoiceRunMeasurement = {
  readonly runId: string;
  readonly stages: readonly ResidentVoiceStageMeasurement[];
};

export type ResidentVoiceStageMeasurement = {
  readonly stage: string;
  readonly status: string;
  readonly count: number;
  readonly errorCount: number;
  readonly durationMs: ResidentVoiceDurationMeasurement;
  readonly errorCodes: readonly string[];
};

export type ResidentVoiceDurationMeasurement = {
  readonly avg: number;
  readonly max: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
};

export type ResidentVoiceRunComparison = {
  readonly stage: string;
  readonly status: string;
  readonly baselineCount: number;
  readonly candidateCount: number;
  readonly avgDeltaMs: number;
  readonly p95DeltaMs: number;
};

type StageAccumulator = {
  readonly runId: string;
  readonly stage: string;
  readonly status: string;
  readonly durations: number[];
  readonly errorCodes: Set<string>;
};

const stageAttributeKey = "pico.voice.stage";
const statusAttributeKey = "pico.voice.stage_status";
const durationAttributeKey = "pico.voice.stage_duration_ms";
const errorCodeAttributeKey = "pico.voice.error_code";

export function summarizeResidentVoiceMetricsJsonl(jsonl: string): ResidentVoiceMeasurementSummary {
  const accumulators = new Map<string, StageAccumulator>();
  let eventCount = 0;
  let invalidLineCount = 0;
  let skippedLineCount = 0;

  for (const rawLine of jsonl.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (line === "") {
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      invalidLineCount += 1;
      continue;
    }

    const event = parseVoiceStageMetricEvent(parsed);

    if (event === undefined) {
      skippedLineCount += 1;
      continue;
    }

    eventCount += 1;
    const key = `${event.runId}\u0000${event.stage}\u0000${event.status}`;
    const existing =
      accumulators.get(key) ?? createStageAccumulator(event.runId, event.stage, event.status);

    existing.durations.push(event.durationMs);

    if (event.errorCode !== undefined) {
      existing.errorCodes.add(event.errorCode);
    }

    accumulators.set(key, existing);
  }

  return {
    schemaVersion: 1,
    eventCount,
    invalidLineCount,
    skippedLineCount,
    runs: buildRunMeasurements([...accumulators.values()])
  };
}

export function compareResidentVoiceRuns(
  baseline: ResidentVoiceRunMeasurement,
  candidate: ResidentVoiceRunMeasurement
): readonly ResidentVoiceRunComparison[] {
  const candidateStages = new Map(
    candidate.stages.map((stage) => [stageKey(stage.stage, stage.status), stage])
  );
  const comparisons: ResidentVoiceRunComparison[] = [];

  for (const baselineStage of baseline.stages) {
    const candidateStage = candidateStages.get(stageKey(baselineStage.stage, baselineStage.status));

    if (candidateStage === undefined) {
      continue;
    }

    comparisons.push({
      stage: baselineStage.stage,
      status: baselineStage.status,
      baselineCount: baselineStage.count,
      candidateCount: candidateStage.count,
      avgDeltaMs: roundMilliseconds(candidateStage.durationMs.avg - baselineStage.durationMs.avg),
      p95DeltaMs: roundMilliseconds(candidateStage.durationMs.p95 - baselineStage.durationMs.p95)
    });
  }

  return comparisons.sort(compareStageMeasurements);
}

export function requireSingleResidentVoiceRun(
  summary: ResidentVoiceMeasurementSummary,
  inputLabel: string
): ResidentVoiceRunMeasurement {
  if (summary.runs.length !== 1) {
    throw new Error(
      `resident voice metrics comparison requires exactly one run in ${inputLabel} input`
    );
  }

  return summary.runs[0] as ResidentVoiceRunMeasurement;
}

function parseVoiceStageMetricEvent(input: unknown):
  | {
      readonly runId: string;
      readonly stage: string;
      readonly status: string;
      readonly durationMs: number;
      readonly errorCode?: string;
    }
  | undefined {
  if (!isVoiceStageRecord(input)) {
    return undefined;
  }

  const stage = readStringAttribute(input.attributes, stageAttributeKey);
  const status = readStringAttribute(input.attributes, statusAttributeKey);
  const durationMs = readDurationAttribute(input.attributes);

  if (stage === undefined || status === undefined || durationMs === undefined) {
    return undefined;
  }

  return {
    runId: input.runId,
    stage,
    status,
    durationMs,
    ...readErrorCode(input.attributes)
  };
}

function isVoiceStageRecord(input: unknown): input is {
  readonly runId: string;
  readonly attributes: Record<string, unknown>;
} {
  return (
    isRecord(input) &&
    input.name === "voice.runtime.stage" &&
    typeof input.runId === "string" &&
    input.runId.trim() !== "" &&
    isRecord(input.attributes)
  );
}

function readStringAttribute(
  attributes: Readonly<Record<string, unknown>>,
  key: string
): string | undefined {
  const value = attributes[key];

  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readDurationAttribute(attributes: Readonly<Record<string, unknown>>): number | undefined {
  const value = attributes[durationAttributeKey];

  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readErrorCode(attributes: Readonly<Record<string, unknown>>): {
  readonly errorCode?: string;
} {
  const errorCode = readStringAttribute(attributes, errorCodeAttributeKey);

  return errorCode === undefined ? {} : { errorCode };
}

function buildRunMeasurements(
  accumulators: readonly StageAccumulator[]
): readonly ResidentVoiceRunMeasurement[] {
  const byRun = new Map<string, StageAccumulator[]>();

  for (const accumulator of accumulators) {
    const run = byRun.get(accumulator.runId) ?? [];

    run.push(accumulator);
    byRun.set(accumulator.runId, run);
  }

  return [...byRun.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([runId, runAccumulators]) => ({
      runId,
      stages: runAccumulators.map(toStageMeasurement).sort(compareStageMeasurements)
    }));
}

function toStageMeasurement(accumulator: StageAccumulator): ResidentVoiceStageMeasurement {
  return {
    stage: accumulator.stage,
    status: accumulator.status,
    count: accumulator.durations.length,
    errorCount: accumulator.status === "error" ? accumulator.durations.length : 0,
    durationMs: summarizeDurations(accumulator.durations),
    errorCodes: [...accumulator.errorCodes].sort()
  };
}

function summarizeDurations(durations: readonly number[]): ResidentVoiceDurationMeasurement {
  const sorted = [...durations].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);

  return {
    avg: roundMilliseconds(sum / sorted.length),
    max: roundMilliseconds(sorted.at(-1) ?? 0),
    min: roundMilliseconds(sorted[0] ?? 0),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95)
  };
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  if (sorted.length === 0) {
    return 0;
  }

  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)
  );

  return roundMilliseconds(sorted[index] ?? 0);
}

function createStageAccumulator(runId: string, stage: string, status: string): StageAccumulator {
  return {
    runId,
    stage,
    status,
    durations: [],
    errorCodes: new Set()
  };
}

function compareStageMeasurements(
  left: Pick<ResidentVoiceStageMeasurement, "stage" | "status">,
  right: Pick<ResidentVoiceStageMeasurement, "stage" | "status">
): number {
  const stageComparison = left.stage.localeCompare(right.stage);

  return stageComparison === 0 ? left.status.localeCompare(right.status) : stageComparison;
}

function stageKey(stage: string, status: string): string {
  return `${stage}\u0000${status}`;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
