import { describe, expect, it } from "vitest";

import { createResidentVoiceMonitor } from "../src/runtime/resident-voice-monitor.js";

function createUi(events: string[]) {
  return {
    setWidget(
      id: string,
      lines: readonly string[] | undefined,
      options?: { readonly placement?: "aboveEditor" | "belowEditor" }
    ) {
      events.push(`widget:${id}:${lines?.join("|") ?? "undefined"}:${String(options?.placement)}`);
    },
    setStatus(id: string, text: string | undefined) {
      events.push(`status:${id}:${String(text)}`);
    },
    setTitle(title: string) {
      events.push(`title:${title}`);
    },
    notify(message: string, level?: "info" | "warning" | "error") {
      events.push(`notify:${String(level)}:${message}`);
    }
  };
}

describe("resident voice monitor", () => {
  it("projects phases and accepted speech into the Pi TUI only", () => {
    const events: string[] = [];
    const monitor = createResidentVoiceMonitor({ ui: createUi(events) });

    monitor.setPhase("waiting");
    monitor.showAcceptedTranscript("文書を作って");
    monitor.setPhase("working", { toolName: "write" });

    expect(events).toContain("status:pico:待機中");
    expect(events).toContain("widget:pico:［Pico］待機中:aboveEditor");
    expect(events).toContain("notify:info:聞き取り: 文書を作って");
    expect(events).toContain(
      "widget:pico:［Pico］作業中 write・00:00|聞き取り: 文書を作って:aboveEditor"
    );
    expect(events).toContain("status:pico:作業中 write・00:00");
    expect(events).toContain("title:Pico — 作業中");
  });

  it("keeps accepted speech visible while a terminal outcome briefly converges to listening", () => {
    const events: string[] = [];
    let expire = (): void => undefined;
    const monitor = createResidentVoiceMonitor({
      ui: createUi(events),
      scheduleTimeout: (callback) => {
        expire = callback;
        return () => undefined;
      }
    });

    monitor.showAcceptedTranscript("確認して");
    monitor.setPhase("completed");

    expect(events).toContain("status:pico:完了");
    expect(events).toContain("widget:pico:［Pico］完了|聞き取り: 確認して:aboveEditor");

    expire();

    expect(events).toContain("status:pico:聞き取り中");
    expect(events).toContain("widget:pico:［Pico］聞き取り中|聞き取り: 確認して:aboveEditor");
  });

  it("briefly distinguishes failed and cancelled terminal outcomes", () => {
    const events: string[] = [];
    const expirations: Array<() => void> = [];
    const monitor = createResidentVoiceMonitor({
      ui: createUi(events),
      scheduleTimeout: (callback) => {
        expirations.push(callback);
        return () => undefined;
      }
    });

    monitor.setPhase("error");
    expirations.shift()?.();
    monitor.setPhase("cancelled", { resumePhase: "waiting" });
    expirations.shift()?.();

    expect(events).toContain("status:pico:エラー");
    expect(events).toContain("status:pico:中止");
    expect(events.filter((event) => event === "status:pico:聞き取り中")).toHaveLength(1);
    expect(events).toContain("status:pico:待機中");
  });

  it("does not project unaccepted speech contents", () => {
    const events: string[] = [];
    const monitor = createResidentVoiceMonitor({ ui: createUi(events) });

    monitor.setPhase("waiting");

    expect(events.join("\n")).not.toContain("キコ聞こえていますか");
  });

  it("shows factual elapsed time while a tool is working", () => {
    const events: string[] = [];
    let nowMs = 0;
    let tick = (): void => undefined;
    let cancelled = false;
    const monitor = createResidentVoiceMonitor({
      ui: createUi(events),
      nowMs: () => nowMs,
      scheduleInterval: (callback) => {
        tick = callback;
        return () => {
          cancelled = true;
        };
      }
    });

    monitor.setPhase("working", { toolName: "write" });
    nowMs = 12_400;
    tick();

    expect(events).toContain("widget:pico:［Pico］作業中 write・00:12:aboveEditor");
    expect(monitor.describeCurrentWork()).toBe("writeを実行中です。開始から12秒です。");

    monitor.close();
    expect(cancelled).toBe(true);
  });

  it("keeps elapsed time anchored to turn start across multiple tools", () => {
    const events: string[] = [];
    let nowMs = 0;
    let tick = (): void => undefined;
    const monitor = createResidentVoiceMonitor({
      ui: createUi(events),
      nowMs: () => nowMs,
      scheduleInterval: (callback) => {
        tick = callback;
        return () => undefined;
      }
    });

    monitor.resetTurn?.();
    monitor.setPhase("working", { toolName: "read" });
    nowMs = 10_000;
    monitor.setPhase("working", {
      completedTool: { toolName: "read", succeeded: true }
    });
    monitor.setPhase("preparing", { toolName: "write" });
    monitor.setPhase("working", { toolName: "write" });
    nowMs = 12_400;
    tick();

    expect(events).toContain(
      "widget:pico:［Pico］作業中 write・直近 read 成功・00:12|直近のtool: read（成功）:aboveEditor"
    );
    expect(monitor.describeCurrentWork()).toBe(
      "writeを実行中です。直近のreadは成功しました。開始から12秒です。"
    );
  });

  it("keeps the latest completed tool and its outcome visible", () => {
    const events: string[] = [];
    const monitor = createResidentVoiceMonitor({ ui: createUi(events) });

    monitor.setPhase("working", { toolName: "write" });
    monitor.setPhase("working", {
      completedTool: { toolName: "write", succeeded: false }
    });

    expect(events).toContain("status:pico:作業中・直近 write 失敗・00:00");
    expect(events).toContain(
      "widget:pico:［Pico］作業中・直近 write 失敗・00:00|直近のtool: write（失敗）:aboveEditor"
    );
    expect(monitor.describeCurrentWork()).toContain("直近のwriteは失敗しました。");
  });

  it("keeps completed tool state inside the voice turn that produced it", () => {
    const events: string[] = [];
    const monitor = createResidentVoiceMonitor({ ui: createUi(events) });

    monitor.setPhase("working", { toolName: "write" });
    monitor.setPhase("working", {
      completedTool: { toolName: "write", succeeded: true }
    });
    monitor.resetTurn?.();
    monitor.setPhase("working", { toolName: "read" });

    expect(monitor.describeCurrentWork()).toBe("readを実行中です。開始から0秒です。");
    expect(events.at(-3)).toBe("status:pico:作業中 read・00:00");
    expect(events.at(-2)).toBe("widget:pico:［Pico］作業中 read・00:00:aboveEditor");
  });

  it("distinguishes an audio output failure in TUI and system notifications", () => {
    const events: string[] = [];
    const systemNotifications: string[] = [];
    const monitor = createResidentVoiceMonitor({
      ui: createUi(events),
      notifySystem: (message) => systemNotifications.push(message)
    });

    monitor.setPhase("error", { errorDetail: "audio_output" });
    monitor.notifyTerminal("failed", { reason: "audio_output" });

    expect(events).toContain("status:pico:エラー・音声出力障害");
    expect(events).toContain("notify:error:Picoの作業に失敗しました（音声出力障害）");
    expect(systemNotifications).toEqual(["Picoの作業に失敗しました（音声出力障害）"]);
  });

  it("guards every public update and scheduled callback after close", () => {
    const events: string[] = [];
    const systemNotifications: string[] = [];
    const scheduledCallbacks: Array<() => void> = [];
    let scheduleCalls = 0;
    const monitor = createResidentVoiceMonitor({
      ui: createUi(events),
      notifySystem: (message) => systemNotifications.push(message),
      scheduleInterval: (callback) => {
        scheduleCalls += 1;
        scheduledCallbacks.push(callback);
        return () => undefined;
      },
      scheduleTimeout: (callback) => {
        scheduleCalls += 1;
        scheduledCallbacks.push(callback);
        return () => undefined;
      }
    });

    monitor.showAcceptedTranscript("閉じる前の本文");
    monitor.setPhase("working", { toolName: "write" });
    monitor.close();
    const eventsAfterClose = [...events];
    const statusAfterClose = monitor.describeCurrentWork();
    const scheduleCallsAfterClose = scheduleCalls;

    monitor.setPhase("error");
    monitor.showAcceptedTranscript("閉じた後の本文");
    monitor.notifyTerminal("failed");
    monitor.close();
    for (const callback of scheduledCallbacks) {
      callback();
    }

    expect(events).toEqual(eventsAfterClose);
    expect(systemNotifications).toEqual([]);
    expect(scheduleCalls).toBe(scheduleCallsAfterClose);
    expect(monitor.describeCurrentWork()).toBe(statusAfterClose);
  });

  it("reports terminal outcomes without including task contents", () => {
    const events: string[] = [];
    const systemNotifications: string[] = [];
    const monitor = createResidentVoiceMonitor({
      ui: createUi(events),
      notifySystem: (message) => systemNotifications.push(message)
    });

    monitor.notifyTerminal("completed");
    monitor.notifyTerminal("failed");
    monitor.notifyTerminal("cancelled");

    expect(events).toContain("notify:info:Picoの作業が完了しました");
    expect(events).toContain("notify:error:Picoの作業に失敗しました");
    expect(events).toContain("notify:warning:Picoの作業を中止しました");
    expect(systemNotifications).toEqual([
      "Picoの作業が完了しました",
      "Picoの作業に失敗しました",
      "Picoの作業を中止しました"
    ]);
  });

  it("isolates a system notification failure from terminal TUI state", () => {
    const events: string[] = [];
    const monitor = createResidentVoiceMonitor({
      ui: createUi(events),
      notifySystem: () => {
        throw new Error("notification service unavailable");
      }
    });

    expect(() => monitor.notifyTerminal("failed")).not.toThrow();
    monitor.setPhase("error");

    expect(events).toContain("notify:error:Picoの作業に失敗しました");
    expect(events).toContain("status:pico:エラー");
  });
});
