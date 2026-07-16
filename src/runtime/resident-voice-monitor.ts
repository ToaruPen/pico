export type ResidentVoicePhase =
  | "waiting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "preparing"
  | "working"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "error";

type ResidentVoicePhaseDetail = {
  readonly toolName?: string;
  readonly completedTool?: {
    readonly toolName: string;
    readonly succeeded: boolean;
  };
  readonly errorDetail?: "audio_output";
  readonly resumePhase?: "waiting" | "listening";
};

export type ResidentVoiceMonitor = {
  readonly resetTurn?: () => void;
  readonly setPhase: (phase: ResidentVoicePhase, detail?: ResidentVoicePhaseDetail) => void;
  readonly showAcceptedTranscript: (text: string) => void;
  readonly notifyTerminal: (
    state: "completed" | "failed" | "cancelled",
    detail?: { readonly reason?: "audio_output" }
  ) => void;
  readonly describeCurrentWork: () => string;
  readonly close: () => void;
};

type ResidentVoiceMonitorUi = {
  readonly setWidget: (
    id: string,
    lines: string[] | undefined,
    options?: { readonly placement?: "aboveEditor" | "belowEditor" }
  ) => void;
  readonly setStatus: (id: string, text: string | undefined) => void;
  readonly setTitle: (title: string) => void;
  readonly notify: (message: string, level?: "info" | "warning" | "error") => void;
};

const phaseLabels: Readonly<Record<ResidentVoicePhase, string>> = {
  waiting: "待機中",
  listening: "聞き取り中",
  transcribing: "文字起こし中",
  thinking: "考え中",
  speaking: "読み上げ中",
  preparing: "準備中",
  working: "作業中",
  cancelling: "中止中",
  cancelled: "中止",
  completed: "完了",
  error: "エラー"
};

const terminalNotifications = {
  completed: { message: "Picoの作業が完了しました", level: "info" },
  failed: { message: "Picoの作業に失敗しました", level: "error" },
  cancelled: { message: "Picoの作業を中止しました", level: "warning" }
} as const;

export function createResidentVoiceMonitor(options: {
  readonly ui: ResidentVoiceMonitorUi;
  readonly notifySystem?: (message: string) => void;
  readonly nowMs?: () => number;
  readonly scheduleInterval?: (callback: () => void, intervalMs: number) => () => void;
  readonly scheduleTimeout?: (callback: () => void, timeoutMs: number) => () => void;
}): ResidentVoiceMonitor {
  let closed = false;
  let currentPhase: ResidentVoicePhase = "waiting";
  let toolName: string | undefined;
  let lastCompletedTool: { readonly toolName: string; readonly succeeded: boolean } | undefined;
  let errorDetail: "audio_output" | undefined;
  let turnStartedAtMs: number | undefined;
  let acceptedTranscript: string | undefined;
  let cancelWorkTicker: (() => void) | undefined;
  let cancelTransientPhase: (() => void) | undefined;
  const nowMs = options.nowMs ?? (() => performance.now());
  const scheduleInterval = options.scheduleInterval ?? defaultScheduleInterval;
  const scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;
  const invokeUi = (operation: () => void): void => {
    if (closed) {
      return;
    }

    try {
      operation();
    } catch {
      // Monitoring must never break the resident runtime.
    }
  };

  return {
    resetTurn() {
      if (closed) {
        return;
      }

      toolName = undefined;
      lastCompletedTool = undefined;
      errorDetail = undefined;
      turnStartedAtMs = nowMs();
      cancelWorkTicker?.();
      cancelWorkTicker = undefined;
    },
    setPhase(phase, detail = {}) {
      if (closed) {
        return;
      }

      cancelTransientPhase?.();
      cancelTransientPhase = undefined;
      applyToolDetail(detail);
      errorDetail = phase === "error" ? detail.errorDetail : undefined;
      updateWorkTicker(phase, detail.toolName);
      currentPhase = phase;
      render();
      cancelTransientPhase = scheduleTransientReset(phase, detail.resumePhase);
    },
    showAcceptedTranscript(text) {
      if (closed) {
        return;
      }

      acceptedTranscript = text;
      invokeUi(() => options.ui.notify(`聞き取り: ${text}`, "info"));
    },
    notifyTerminal(state, detail = {}) {
      if (closed) {
        return;
      }

      const notification =
        state === "failed" && detail.reason === "audio_output"
          ? {
              message: "Picoの作業に失敗しました（音声出力障害）",
              level: "error" as const
            }
          : terminalNotifications[state];
      invokeUi(() => options.ui.notify(notification.message, notification.level));

      try {
        options.notifySystem?.(notification.message);
      } catch {
        // OS notification failure does not change the completed task state.
      }
    },
    describeCurrentWork() {
      if (currentPhase !== "working" || turnStartedAtMs === undefined) {
        return `${phaseLabels[currentPhase]}です。`;
      }

      const elapsedSeconds = readElapsedSeconds(nowMs(), turnStartedAtMs);
      const currentWork = toolName === undefined ? "作業中です。" : `${toolName}を実行中です。`;
      const completed =
        lastCompletedTool === undefined
          ? ""
          : `直近の${lastCompletedTool.toolName}は${lastCompletedTool.succeeded ? "成功" : "失敗"}しました。`;

      return `${currentWork}${completed}開始から${elapsedSeconds}秒です。`;
    },
    close() {
      if (closed) {
        return;
      }

      closed = true;
      const workTickerCleanup = cancelWorkTicker;
      cancelWorkTicker = undefined;
      const transientPhaseCleanup = cancelTransientPhase;
      cancelTransientPhase = undefined;

      for (const cleanup of [
        workTickerCleanup,
        transientPhaseCleanup,
        () => options.ui.setStatus("pico", undefined),
        () => options.ui.setWidget("pico", undefined),
        () => options.ui.setTitle("Pico")
      ]) {
        if (cleanup === undefined) {
          continue;
        }

        try {
          cleanup();
        } catch {
          // UI cleanup is best effort during shutdown.
        }
      }
    }
  };

  function render(): void {
    const label = phaseLabels[currentPhase];
    const summary = buildStatusSummary(label);
    const lines = buildWidgetLines(summary);
    invokeUi(() => options.ui.setStatus("pico", summary));
    invokeUi(() =>
      options.ui.setWidget("pico", lines, {
        placement: "aboveEditor"
      })
    );
    invokeUi(() => options.ui.setTitle(`Pico — ${label}`));
  }

  function applyToolDetail(detail: ResidentVoicePhaseDetail): void {
    if (detail.completedTool === undefined) {
      toolName = detail.toolName ?? toolName;
      return;
    }

    lastCompletedTool = detail.completedTool;

    if (toolName === detail.completedTool.toolName) {
      toolName = undefined;
    }
  }

  function updateWorkTicker(phase: ResidentVoicePhase, nextToolName: string | undefined): void {
    if (phase === "working") {
      turnStartedAtMs ??= nowMs();
      cancelWorkTicker ??= scheduleInterval(render, 1_000);
      return;
    }

    cancelWorkTicker?.();
    cancelWorkTicker = undefined;
    toolName = nextToolName;
  }

  function buildStatusSummary(label: string): string {
    const tool = toolName === undefined ? "" : ` ${toolName}`;
    const completed =
      currentPhase === "working" && lastCompletedTool !== undefined
        ? `・直近 ${lastCompletedTool.toolName} ${lastCompletedTool.succeeded ? "成功" : "失敗"}`
        : "";
    const failureDetail = errorDetail === "audio_output" ? "・音声出力障害" : "";
    const elapsed =
      currentPhase === "working" && turnStartedAtMs !== undefined
        ? `・${formatElapsed(readElapsedSeconds(nowMs(), turnStartedAtMs))}`
        : "";
    return `${label}${tool}${completed}${failureDetail}${elapsed}`;
  }

  function buildWidgetLines(summary: string): string[] {
    return [
      `［Pico］${summary}`,
      ...(lastCompletedTool === undefined
        ? []
        : [
            `直近のtool: ${lastCompletedTool.toolName}（${lastCompletedTool.succeeded ? "成功" : "失敗"}）`
          ]),
      ...(acceptedTranscript === undefined ? [] : [`聞き取り: ${acceptedTranscript}`])
    ];
  }

  function scheduleTransientReset(
    phase: ResidentVoicePhase,
    resumePhase: "waiting" | "listening" | undefined
  ): (() => void) | undefined {
    const targetPhase =
      phase === "completed" || phase === "error" || phase === "cancelled"
        ? (resumePhase ?? "listening")
        : undefined;

    if (targetPhase === undefined) {
      return undefined;
    }

    return scheduleTimeout(() => {
      if (closed) {
        return;
      }

      cancelTransientPhase = undefined;
      errorDetail = undefined;
      currentPhase = targetPhase;
      render();
    }, 2_000);
  }
}

function readElapsedSeconds(nowMs: number, startedAtMs: number): number {
  return Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
}

function formatElapsed(elapsedSeconds: number): string {
  const minutes = Math.floor(elapsedSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (elapsedSeconds % 60).toString().padStart(2, "0");

  return `${minutes}:${seconds}`;
}

function defaultScheduleInterval(callback: () => void, intervalMs: number): () => void {
  const interval = setInterval(callback, intervalMs);
  interval.unref();

  return () => clearInterval(interval);
}

function defaultScheduleTimeout(callback: () => void, timeoutMs: number): () => void {
  const timeout = setTimeout(callback, timeoutMs);
  timeout.unref();

  return () => clearTimeout(timeout);
}
