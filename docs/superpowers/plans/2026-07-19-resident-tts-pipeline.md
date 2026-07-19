# Resident TTS逐次合成・連続再生 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LLMとreasoning effortを変更せず、Aivis Speechの第1文完成時に再生を始め、1つのPCM playback processで後続文を連続再生する。

**Architecture:** Pi adapterが確定した最終assistant本文をモデル非依存の発話分割器へ渡し、Aivis adapterは型付き非同期event streamとして文単位のchunkを順次返す。Resident runtimeは1 chunkだけ先読みし、turn単位のcontinuous playback sessionへPCMを投入することで、現在文の再生と次文の合成を重ねる。cancel、部分失敗、echo、OTelは同じturn generationで収束させる。

**Tech Stack:** TypeScript 6、Node.js 24、Vitest、AivisSpeech Engine HTTP API、`ffplay`（macOS）、`aplay`（Linux）、OpenTelemetry、Biome、ESLint、ast-grep。

---

## File map

- `src/modules/voice/index.ts`: 発話分割、TTS event contract、Aivis逐次合成、provider substage観測。
- `src/runtime/voice-playback.ts`: provider非依存のturn単位playback session contract。
- `src/runtime/tts-playback-pipeline.ts`: 1-chunk先読み、echo tee、TTS/playbackの収束。
- `src/runtime/resident-audio-playback.ts`: `ffplay`/`aplay` continuous PCM child ownershipとreadiness。
- `src/runtime/resident-audio-io.ts`: capture専用へ縮小し、旧chunk単位playbackを除去。
- `src/runtime/voice-resident.ts`: state machineから新pipelineを呼び、generationとcounterを確定。
- `src/runtime/voice-stage-probe.ts`: TTS first-chunk/provider substageと部分失敗属性のallowlist。
- `src/runtime/resident-voice-runner.ts`: TTS observer、playback provider、startup readinessのcomposition root。
- `src/config/index.ts`: macOS出力を明示的な`ffplay` providerへ変更。
- `config/pico.example.yaml`: production configuration例を`ffplay`へ更新。
- `tests/voice.test.ts`: 分割器、TTS event順序、Aivis直列request、substage観測。
- `tests/tts-playback-pipeline.test.ts`: 先読み、部分失敗、cancel、echo、high-level telemetry。
- `tests/resident-audio-io.test.ts`: 既存capture testを維持し、旧playback testを新provider testへ移管。
- `tests/resident-audio-playback.test.ts`: process 1個、PCM順序、backpressure、format、terminal settlement。
- `tests/voice-resident.test.ts`: state transition、farewell、cancel、counter、late result。
- `tests/voice-stage-probe.test.ts`: 新stageと属性allowlist。
- `tests/config.test.ts`: `ffplay` config acceptanceと`afplay` rejection。
- `tests/resident-voice-runner.test.ts`: TTS observer/readiness wiring。
- `scripts/smoke/voice-providers.ts`: event streamを収集して既存TTS smoke reportへ変換。
- `tests/voice-smoke.test.ts`: streaming TTS smoke success/failure。
- `docs/superpowers/research/2026-07-19-resident-tts-pipeline-validation.md`: baseline/candidate実測。

### Task 1: モデル非依存の発話分割を固定する

**Files:**
- Modify: `tests/voice.test.ts:682-699`
- Modify: `src/modules/voice/index.ts:164-190,354-415`

- [ ] **Step 1: 120 code point上限とsoft boundaryの失敗testを書く**

```ts
it("bounds punctuation-free speech without splitting Unicode code points", () => {
  const softBounded = `${"あ".repeat(118)}、${"い".repeat(10)}`;

  expect(segmentJapaneseSentences(softBounded)).toEqual([
    `${"あ".repeat(118)}、`,
    "い".repeat(10)
  ]);
  expect(segmentJapaneseSentences("😀".repeat(121)).map((part) => Array.from(part).length)).toEqual([
    120,
    1
  ]);
});
```

- [ ] **Step 2: REDを確認する**

Run: `npx vitest run tests/voice.test.ts -t "bounds punctuation-free speech"`

Expected: FAIL。現行実装は句読点のない121文字を1 segmentのまま返す。

- [ ] **Step 3: 固定上限の分割を実装する**

```ts
const MAX_SPEECH_SEGMENT_CODE_POINTS = 120;
const SOFT_SPEECH_BOUNDARIES = new Set(["、", ",", "，", ";", "；", ":", "：", " ", "　"]);

function splitBoundedSpeechSegment(text: string): readonly string[] {
  const remaining = Array.from(text.trim());
  const segments: string[] = [];

  while (remaining.length > MAX_SPEECH_SEGMENT_CODE_POINTS) {
    const window = remaining.slice(0, MAX_SPEECH_SEGMENT_CODE_POINTS);
    const softIndex = window.findLastIndex((character) => SOFT_SPEECH_BOUNDARIES.has(character));
    const end = softIndex < 0 ? MAX_SPEECH_SEGMENT_CODE_POINTS : softIndex + 1;
    pushSentenceSegment(segments, remaining.splice(0, end).join(""));
  }

  pushSentenceSegment(segments, remaining.join(""));
  return segments;
}
```

`segmentJapaneseSentences()`は`complete`と`residual`を結合した後、各要素を
`splitBoundedSpeechSegment()`へ通してflat化する。既存の閉じ括弧処理は変更しない。

- [ ] **Step 4: focused testをGREENにする**

Run: `npx vitest run tests/voice.test.ts -t "segments Japanese|bounds punctuation-free speech"`

Expected: 2 tests PASS。

- [ ] **Step 5: identifier配置を確認してcommitする**

Run: `rg -n "MAX_SPEECH_SEGMENT_CODE_POINTS|SOFT_SPEECH_BOUNDARIES" src tests`

Expected: 定義は`src/modules/voice/index.ts`だけ、利用とtestは意図した箇所だけ。

```bash
git add src/modules/voice/index.ts tests/voice.test.ts
git commit -m "feat(voice): bound model-independent speech segments"
```

### Task 2: Aivis TTSを型付きevent streamへ変更する

**Files:**
- Modify: `tests/voice.test.ts:701-935`
- Modify: `src/modules/voice/index.ts:86-126,253-296,867-1099`
- Modify: `src/runtime/voice-resident.ts:7,844-938`
- Modify: `tests/voice-resident.test.ts:6-12,1083-1155,1428-1455`
- Modify: `scripts/smoke/voice-providers.ts:140-175`
- Modify: `tests/voice-smoke.test.ts`

- [ ] **Step 1: 第1chunkを第2文完成前に取得できる失敗testを書く**

```ts
it("publishes the first chunk before the next sentence synthesis completes", async () => {
  const secondSynthesis = createGate<Response>();
  const requests: string[] = [];
  const client = createAivisSpeechTtsClient(aivisService, {
    fetch: async (input) => {
      const url = requestUrl(input);
      requests.push(url);
      if (url.includes("/audio_query")) return buildSidecarResponse({});
      if (requests.filter((value) => value.includes("/synthesis")).length === 2) {
        return secondSynthesis.promise;
      }
      return new Response(bytesToArrayBuffer(buildWav(Buffer.from([1, 0]))));
    }
  });
  const iterator = client.synthesize({ text: "一文目。二文目。" })[Symbol.asyncIterator]();

  await expect(iterator.next()).resolves.toMatchObject({
    value: { kind: "chunk", chunk: { sentenceIndex: 0, text: "一文目。" } }
  });
  const second = iterator.next();
  await vi.waitFor(() => expect(requests.filter((url) => url.includes("/synthesis"))).toHaveLength(2));
  secondSynthesis.resolve(new Response(bytesToArrayBuffer(buildWav(Buffer.from([2, 0])))));
  await expect(second).resolves.toMatchObject({ value: { kind: "chunk", chunk: { sentenceIndex: 1 } } });
});

function createGate<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
```

- [ ] **Step 2: REDを確認する**

Run: `npx vitest run tests/voice.test.ts -t "publishes the first chunk"`

Expected: FAIL。現行`TtsClient.synthesize()`は`Promise<TtsSynthesisResult>`でiteratorを返さない。

- [ ] **Step 3: event contractとasync generatorを実装する**

```ts
export type TtsSynthesisSource = {
  readonly serviceId: string;
  readonly provider: "aivis-speech";
  readonly speakerId: number;
};

export type TtsSynthesisEvent =
  | { readonly kind: "chunk"; readonly chunk: TtsAudioChunk }
  | {
      readonly kind: "completed";
      readonly chunkCount: number;
      readonly totalDurationMs: number;
      readonly source: TtsSynthesisSource;
    }
  | { readonly kind: "failed"; readonly failure: TtsSynthesisFailure };

export type TtsClient = {
  readonly synthesize: (request: TtsSynthesisRequest) => AsyncIterable<TtsSynthesisEvent>;
};

export type AivisSpeechTtsClientOptions = {
  readonly fetch?: typeof fetch;
};
```

`createAivisSpeechTtsClient()`は`async *synthesize(request)`を返す。文ごとに既存の
`synthesizeSentenceWithAivisSpeech()`をawaitし、成功直後に`chunk`をyieldする。失敗時は
`failed`を1回yieldしてreturnし、全成功時は累積`chunkCount`と`totalDurationMs`を持つ
`completed`を最後にyieldする。Aivis requestはgenerator内の単一loopに残し、同時実行しない。
第2引数は`AivisSpeechTtsClientOptions`とし、既存testの直接fetch引数を全て`{ fetch }`へ更新する。

既存のfield外smokeが全chunk完了を必要とするため、event streamを最後まで読み、既存の
`TtsSynthesisResult`へ変換する`collectTtsSynthesisEvents()`を同じmoduleへ追加する。これは
provider fallbackではなく、有限smoke report用のconsumer helperとする。

- [ ] **Step 4: structured failureと直列性のtestを追加する**

```ts
const events = await collectAsync(
  createAivisSpeechTtsClient(aivisService, { fetch: failingFetch }).synthesize({
    text: "成功文。失敗文。"
  })
);
expect(events.map((event) => event.kind)).toEqual(["chunk", "failed"]);
expect(events[1]).toMatchObject({
  kind: "failed",
  failure: { reason: "backend_error", sentenceIndex: 1 }
});
expect(maximumConcurrentAivisRequests).toBe(1);
```

- [ ] **Step 5: voice boundary testをGREENにする**

`voice-resident.ts`はTask 5まで現在の一括再生動作を維持するため、`requestTts()`内で
`collectTtsSynthesisEvents()`を使用する。test driverの`TtsClient` fakeは既存
`ttsResponse`をevent streamへ変換するasync generatorに更新する。`voice-providers.ts`もcollectorを
使い、既存smoke reportのshapeを維持する。

Run: `npx vitest run tests/voice.test.ts tests/voice-resident.test.ts tests/voice-smoke.test.ts && just typecheck`

Expected: 全testとtypecheck PASS。timeout、caller abort、response body stallの既存testは
event収集後の`failed` eventを検証する形へ更新し、削除しない。Resident runtimeの再生開始時点は
このTaskではまだ変えない。

- [ ] **Step 6: commitする**

```bash
git add src/modules/voice/index.ts src/runtime/voice-resident.ts \
  scripts/smoke/voice-providers.ts tests/voice.test.ts tests/voice-resident.test.ts \
  tests/voice-smoke.test.ts
git commit -m "feat(voice): stream ordered Aivis synthesis events"
```

### Task 3: 1-chunk先読みpipelineを独立モジュールで実装する

**Files:**
- Create: `src/runtime/voice-playback.ts`
- Create: `src/runtime/tts-playback-pipeline.ts`
- Create: `tests/tts-playback-pipeline.test.ts`
- Modify: `src/runtime/voice-stage-probe.ts:7-60`
- Modify: `tests/voice-stage-probe.test.ts:1-205`

- [ ] **Step 1: provider非依存playback contractを書く**

```ts
export type VoicePlaybackSession = {
  readonly write: (chunk: TtsAudioChunk) => Promise<void>;
  readonly finish: () => Promise<void>;
};

export type VoicePlaybackSink = {
  readonly open: (firstChunk: TtsAudioChunk, signal?: AbortSignal) => VoicePlaybackSession;
  readonly stop: () => Promise<void>;
  readonly close: () => Promise<void>;
};

export type TtsPlaybackPipelineOptions = {
  readonly text: string;
  readonly signal: AbortSignal;
  readonly tts: TtsClient;
  readonly playback: VoicePlaybackSink;
  readonly echoControl: EchoControlProvider;
  readonly probe?: VoiceStageProbe;
  readonly now: () => string;
  readonly monotonicNow: () => number;
  readonly onFirstPlaybackStart?: () => boolean;
};
```

- [ ] **Step 2: 先読みの失敗testを書く**

```ts
it("starts the next synthesis before writing the current chunk", async () => {
  const order: string[] = [];
  const secondChunk = createGate<TtsSynthesisEvent>();
  const tts = ttsFromEvents(async function* () {
    yield chunkEvent(0);
    order.push("second-synthesis-started");
    yield await secondChunk.promise;
    yield completedEvent(2);
  });
  const playback = recordingPlayback({ onWrite: (chunk) => order.push(`write-${chunk.sentenceIndex}`) });
  const running = runTtsPlaybackPipeline(pipelineInput({ tts, playback }));

  await vi.waitFor(() => expect(order).toEqual(["second-synthesis-started", "write-0"]));
  secondChunk.resolve(chunkEvent(1));
  await expect(running).resolves.toMatchObject({ status: "completed", playedChunkCount: 2 });
});
```

- [ ] **Step 3: REDを確認する**

Run: `npx vitest run tests/tts-playback-pipeline.test.ts -t "starts the next synthesis"`

Expected: FAIL。`runTtsPlaybackPipeline`が存在しない。

- [ ] **Step 4: pipelineのtyped resultとlook-ahead loopを実装する**

```ts
export type TtsPlaybackPipelineResult =
  | { readonly status: "completed"; readonly playedChunkCount: number; readonly durationMs: number }
  | { readonly status: "empty"; readonly playedChunkCount: 0 }
  | { readonly status: "cancelled"; readonly playedChunkCount: number }
  | {
      readonly status: "failed";
      readonly errorCode: string;
      readonly playedChunkCount: number;
      readonly sentenceIndex?: number;
    };
```

実装loopは、現在eventが`chunk`なら先に`iterator.next()`を呼び、そのPromiseを保持したまま
echo referenceと`session.write()`を行う。次eventが`completed`なら`session.finish()`、`failed`
なら投入済みchunkだけ`session.finish()`でdrainする。caller abortは`playback.stop()`を使い、
provider/playback失敗時はpipeline専用AbortControllerでpending Aivis requestをabortする。
`onFirstPlaybackStart`が`false`を返した場合はgenerationが無効化済みなのでplaybackを開かず、
pipelineを`cancelled`へ収束させる。

- [ ] **Step 5: failure、cancel、echoの失敗testを追加してGREENにする**

```ts
expect(await partialFailure).toMatchObject({
  status: "failed",
  errorCode: "backend_error",
  playedChunkCount: 1,
  sentenceIndex: 1
});
expect(playback.finishedSessions()).toBe(1);
expect(playback.stoppedSessions()).toBe(0);

controller.abort(new Error("cancelled"));
expect(await cancelled).toMatchObject({ status: "cancelled" });
expect(playback.stoppedSessions()).toBe(1);
```

Run: `npx vitest run tests/tts-playback-pipeline.test.ts`

Expected: 先読み、empty、first failure、partial failure、playback failure、cancel、format-neutral
順序、echo offsetの全test PASS。

- [ ] **Step 6: high-level telemetry policyを追加する**

`voiceRuntimeStagePolicies`へ`tts_time_to_first_chunk`、`tts_audio_query`、`tts_synthesize`を追加し、
属性allowlistへ`pico.voice.sentence_index`と`pico.voice.played_chunk_count`を追加する。
pipelineは`tts_request_wall`、`tts_time_to_first_chunk`、`tts_playback`を正確な開始・terminal境界で
1回ずつ記録する。

Run: `npx vitest run tests/voice-stage-probe.test.ts tests/tts-playback-pipeline.test.ts`

Expected: 新stageを受理し、本文・音声・未知属性を拒否するtestがPASS。

- [ ] **Step 7: commitする**

```bash
git add src/runtime/voice-playback.ts src/runtime/tts-playback-pipeline.ts \
  src/runtime/voice-stage-probe.ts tests/tts-playback-pipeline.test.ts \
  tests/voice-stage-probe.test.ts
git commit -m "feat(voice): pipeline synthesis into continuous playback"
```

### Task 4: `ffplay`/`aplay` continuous PCM providerを実装する

**Files:**
- Create: `src/runtime/resident-audio-playback.ts`
- Create: `tests/resident-audio-playback.test.ts`
- Reference: `src/runtime/resident-audio-io.ts:266-396,760-990`
- Reference: `tests/resident-audio-io.test.ts:628-1235`

- [ ] **Step 1: 2 chunkを1 processへ書く失敗testを書く**

```ts
it("writes every sentence to one ffplay process in order", async () => {
  const process = createAudioProcess({ stdin: new PassThrough() });
  const spawn = vi.fn(() => process.child);
  const sink = createResidentContinuousPlaybackSink(
    { provider: "ffplay", command: "ffplay", route: "system_default" },
    spawn
  );
  const session = sink.open(chunk(0, [1, 0]));
  await session.write(chunk(0, [1, 0]));
  await session.write(chunk(1, [2, 0]));
  const finishing = session.finish();
  process.emitExit(0);
  await finishing;

  expect(spawn).toHaveBeenCalledTimes(1);
  expect(process.stdinBytes()).toEqual([1, 0, 2, 0]);
});
```

- [ ] **Step 2: REDを確認する**

Run: `npx vitest run tests/resident-audio-playback.test.ts -t "one ffplay process"`

Expected: FAIL。continuous providerが存在しない。

- [ ] **Step 3: process planとPCM sessionを実装する**

```ts
export type ResidentAudioOutputPlan =
  | { readonly provider: "alsa"; readonly command: "aplay"; readonly device: string }
  | { readonly provider: "ffplay"; readonly command: "ffplay"; readonly route: "system_default" };

function createPlaybackArguments(plan: ResidentAudioOutputPlan, chunk: TtsAudioChunk): string[] {
  return plan.provider === "ffplay"
    ? ["-nodisp", "-autoexit", "-loglevel", "error", "-f", "s16le", "-ar",
        String(chunk.sampleRateHz), "-ac", String(chunk.channels), "-i", "pipe:0"]
    : ["-q", "-f", "S16_LE", "-r", String(chunk.sampleRateHz), "-c",
        String(chunk.channels), "-t", "raw", "-D", plan.device];
}
```

`open()`で1 childだけspawnし、`write()`はencoding/sample rate/channels一致を検証してstdinへ
書き、`false`の場合は`drain`を待つ。`finish()`はstdinを1回だけendしてchild `close`を待つ。
`stop()`は既存のSIGTERM→1秒→SIGKILL→1秒terminal settlementを移植し、同じError instanceを
sessionとstop callerへ返す。

- [ ] **Step 4: 既存playback failure coverageを新contractへ移す**

次の既存testを削除せず、`tests/resident-audio-playback.test.ts`で新APIへ書き換える。

- stdin error後もchild closeまでownershipを保持する。
- spawn error、exit non-zero、exit-only、close-onlyを正しく収束する。
- stopはidempotentで、SIGTERM/SIGKILL timeoutを共有する。
- abort済みsignalではchildを残さない。
- backpressure中のcancelで`drain` listenerを残さない。
- 途中chunkのformat不一致を拒否する。
- `finish()`後とactive session中の再openを拒否する。

Run: `npx vitest run tests/resident-audio-playback.test.ts`

Expected: 全test PASS、spawn countはturn当たり1。

- [ ] **Step 5: command readinessを追加する**

```ts
export async function assertResidentPlaybackReadiness(
  plan: ResidentAudioOutputPlan,
  run: PlaybackCommandProbe = runPlaybackCommandProbe
): Promise<void> {
  const args = plan.provider === "ffplay" ? ["-version"] : ["--version"];
  await run(plan.command, args, 5_000);
}
```

`PlaybackCommandProbe`は
`(command: string, args: readonly string[], timeoutMs: number) => Promise<void>`として同じfileに
定義する。

command missing、non-zero、5秒timeoutを明示Errorへ変換するtestを追加する。fallbackは行わない。

- [ ] **Step 6: commitする**

```bash
git add src/runtime/resident-audio-playback.ts tests/resident-audio-playback.test.ts
git commit -m "feat(voice): add continuous PCM playback providers"
```

### Task 5: Resident state machine、continuous provider、configを統合する

**Files:**
- Modify: `src/runtime/voice-resident.ts:7-26,572-674,820-1025,1110-1155,1225-1250`
- Modify: `tests/voice-resident.test.ts:1-178,420-600,630-980,1083-1245,1428-1455`
- Modify: `src/runtime/resident-voice-runner.ts:20-35,162-213,590-600`
- Modify: `scripts/field/resident-voice-pseudo-audio.ts:12-24,250-390`
- Modify: `tests/resident-voice-pseudo-audio-field.test.ts`
- Modify: `src/runtime/resident-audio-io.ts:1-10,53-63,154-177,266-396,760-990`
- Modify: `tests/resident-audio-io.test.ts:106-235,628-1235`
- Modify: `src/config/index.ts:250-268,950-971`
- Modify: `tests/config.test.ts:274-338,397-420`
- Modify: `config/pico.example.yaml:78-90`

- [ ] **Step 1: first chunkで`speaking`へ進む失敗testを書く**

```ts
it("starts speaking after the first chunk while the next synthesis remains pending", async () => {
  const second = createGate<TtsSynthesisEvent>();
  const driver = createDriver({
    ttsEvents: async function* () {
      yield chunkEvent(0);
      yield await second.promise;
      yield completedEvent(2);
    }
  });

  await startReleasedHold(driver);
  await vi.advanceTimersByTimeAsync(250);
  await vi.waitFor(() => expect(driver.runtime.state()).toBe("speaking"));
  expect(driver.playedChunks.map((chunk) => chunk.sentenceIndex)).toEqual([0]);
  second.resolve(chunkEvent(1));
  await vi.waitFor(() => expect(driver.runtime.state()).toBe("idle"));
});
```

- [ ] **Step 2: REDを確認する**

Run: `npx vitest run tests/voice-resident.test.ts -t "starts speaking after the first chunk"`

Expected: FAIL。現行runtimeはTTS全完了まで`synthesizing`に留まる。

- [ ] **Step 3: normal turnとfarewellを共通pipelineへ移す**

`requestTts()`と`playTurnChunks()`を削除し、`runTtsPlaybackPipeline()`をnormal turnとfarewellの
両方から呼ぶ。最初のplayback callbackでのみ
`controller.advance(generationId, "synthesizing", "speaking")`と
`settlePttReleaseMeasurement(..., "ok")`を実行する。

result処理は次に固定する。

```ts
switch (result.status) {
  case "completed":
    acknowledgeDeferredResults(options, deferredResults);
    refreshSession(options.sessionLifecycle, sessionId);
    counters.completedTurns += 1;
    break;
  case "failed":
    counters.failedTurns += 1;
    break;
  case "cancelled":
  case "empty":
    break;
}
```

終了stageは実際のcontroller stateを読み、`synthesizing`または`speaking`のどちらからでも1回だけ
idleへ戻す。invalid generationのresultはcounter、deferred acknowledgement、stateを変更しない。

- [ ] **Step 4: test driverをevent/playback session contractへ更新する**

`ttsResponse`を`ttsEvents`へ、`play()` fakeを`open()`/`write()`/`finish()` fakeへ置き換える。
既存のcancel、late synthesis、farewell、shutdown、echo reference testは同じ保証を新contractで
維持し、削除しない。

Run: `npx vitest run tests/voice-resident.test.ts tests/tts-playback-pipeline.test.ts`

Expected: 全test PASS。

- [ ] **Step 5: composition rootとfield harnessを新playbackへ切り替える**

`resident-voice-runner.ts`と`resident-voice-pseudo-audio.ts`は
`resident-audio-playback.ts`からfactoryをimportする。`resident-audio-io.ts`から旧playback型、
一時WAV、`afplay`、playback termination codeを除去し、captureだけを残す。

同じRED/GREEN cycleで`PicoResidentAudioOutputConfig`と`defineResidentAudioOutput()`を
`ffplay`へ変更する。`tests/config.test.ts`は`ffplay`をacceptし、`afplay`を
`pico config voice.resident.audioOutput.provider must be alsa or ffplay`でrejectする。
`config/pico.example.yaml`も`ffplay`へ更新し、aliasとfallbackは追加しない。
`createResidentAudioOutputPlan()`は`resident-audio-playback.ts`へ移し、macOS `ffplay`を
`{ provider: "ffplay", command: "ffplay", route: "system_default" }`、Linux ALSAを
`{ provider: "alsa", command: "aplay", device }`へ変換する。platform不一致は起動前にrejectする。

Run: `rg -n "mkdtemp|tts\.wav|afplay|playTurnChunks|requestTts" src tests scripts config`

Expected: production codeに旧一時WAV/`afplay`/旧helperが0件。旧仕様名を説明する設計文書だけは
検索結果に残ってよい。

- [ ] **Step 6: focused runtime gatesを通してcommitする**

Run: `npx vitest run tests/voice-resident.test.ts tests/resident-audio-io.test.ts tests/resident-audio-playback.test.ts tests/resident-voice-pseudo-audio-field.test.ts tests/config.test.ts && just typecheck`

Expected: 全test PASS。

```bash
git add src/runtime/voice-resident.ts src/runtime/resident-voice-runner.ts \
  src/runtime/resident-audio-io.ts scripts/field/resident-voice-pseudo-audio.ts \
  src/config/index.ts config/pico.example.yaml \
  tests/voice-resident.test.ts tests/resident-audio-io.test.ts \
  tests/resident-voice-pseudo-audio-field.test.ts tests/config.test.ts
git commit -m "feat(voice): integrate streaming resident playback"
```

### Task 6: Aivis substage telemetryとreadinessを配線する

**Files:**
- Modify: `src/modules/voice/index.ts:253-296,902-1099`
- Modify: `src/runtime/resident-voice-runner.ts:150-180,590-615`
- Modify: `tests/voice.test.ts:701-935`
- Modify: `tests/resident-voice-runner.test.ts`

- [ ] **Step 1: Aivis substage観測の失敗testを書く**

```ts
expect(observations).toEqual([
  expect.objectContaining({ stage: "audio_query", sentenceIndex: 0, status: "ok" }),
  expect.objectContaining({ stage: "synthesis", sentenceIndex: 0, status: "ok" })
]);
expect(JSON.stringify(observations)).not.toContain("観測対象の本文");
```

- [ ] **Step 2: REDを確認する**

Run: `npx vitest run tests/voice.test.ts -t "observes Aivis substages"`

Expected: FAIL。現行Aivis clientはprovider内部stageを公開しない。

- [ ] **Step 3: provider-neutral observerをAivis clientへ追加する**

```ts
export type TtsProviderStageObservation = {
  readonly stage: "audio_query" | "synthesis";
  readonly sentenceIndex: number;
  readonly status: "ok" | "error" | "skipped";
  readonly startedAt: string;
  readonly durationMs: number;
  readonly errorCode?: string;
};

export type AivisSpeechTtsClientOptions = {
  readonly fetch?: typeof fetch;
  readonly now?: () => string;
  readonly monotonicNow?: () => number;
  readonly observeStage?: (observation: TtsProviderStageObservation) => void;
};
```

`runAivisSpeechStage()`は`finally`でなくresult確定地点からobserverをbest-effortで1回呼ぶ。
observerがthrowしてもAivis resultを変更しない。本文、query payload、WAV bytesはobservationへ含めない。

- [ ] **Step 4: runnerでOTel stageへ変換する**

`createConfiguredTts(config, probe)`が`audio_query`を`tts_audio_query`、`synthesis`を
`tts_synthesize`へ写像し、sentence indexとerror codeだけを`recordVoiceStageProbe()`へ渡す。
`assertResidentVoiceStartupReadiness()`はAivis healthとplayback command readinessを両方awaitする。

- [ ] **Step 5: telemetry testをGREENにする**

Run: `npx vitest run tests/voice.test.ts tests/voice-stage-probe.test.ts tests/resident-voice-runner.test.ts`

Expected: stage success/error/cancel、observer failure isolation、本文非記録、`ffplay` readinessの全test PASS。

- [ ] **Step 6: local field configをテスト可能な状態へ更新する**

`config/pico.local.yaml`が存在する場合だけ、ignored local fileの
`voice.resident.audioOutput.provider`を`ffplay`へ変更する。このファイルはstageしない。

Run: `git check-ignore config/pico.local.yaml && rg -n "provider: ffplay" config/pico.local.yaml config/pico.example.yaml`

Expected: local fileはignored、両configが`ffplay`。

- [ ] **Step 7: commitする**

```bash
git add src/modules/voice/index.ts src/runtime/resident-voice-runner.ts \
  tests/voice.test.ts \
  tests/resident-voice-runner.test.ts
git commit -m "feat(voice): expose continuous playback telemetry"
```

### Task 7: 全gate、polish、実機telemetry、PR更新を完了する

**Files:**
- Create: `docs/superpowers/research/2026-07-19-resident-tts-pipeline-validation.md`
- Review: all files changed by Tasks 1-6

- [ ] **Step 1: formatterと全local gateを通す**

Run: `just format && just check`

Expected: TypeScript、ESLint、ast-grep rule/test、Biome、Vitest、Apple Speech Swift、macOS control
Swiftが全てPASS。既存testを削除・skipして通さない。

- [ ] **Step 2: polishmentを実行する**

`polishment` skillを読み、今回のdiffだけを対象に標準polishを実行する。変更が生じた場合はfocused
testと`just check`を再実行する。

- [ ] **Step 3: ai-slop-cleanerを実行する**

`ai-slop-cleaner` skillを読み、重複event handling、不要なwrapper、dead compatibility path、曖昧な
命名だけを今回のdiff内で整理する。behavior変更を行わず、変更後に`just check`を再実行する。

- [ ] **Step 4: 疑似音声をreal providerへ注入する**

```bash
umask 077
pico_validation_dir=$(mktemp -d /tmp/pico-tts-pipeline.XXXXXX)
for pico_run in 1 2 3; do
  npm run field:resident-voice-pseudo-audio -- \
    --audio-fixture /tmp/pico-otel-stackchan-check-20260719.wav \
    --validation-output "$pico_validation_dir/events-$pico_run.jsonl" \
    --required-tool-name stackchan_get_status \
    --expected-transcript-sha256 a4704845dc50a8c392ce82e6b9544e88f3a79b65543ed23320bfd147ae23d266 \
    --timeout-ms 120000 | tee "$pico_validation_dir/report-$pico_run.txt"
done
```

Expected:

- STT transcriptが既知の日本語fixtureと一致する。
- `stackchan_get_status`が`isError: false`で1回成功する。
- final assistant本文がvalidation artifactへ存在する。
- agent settingsは`openai-codex/gpt-5.6-sol`、thinking levelは`medium`のまま。
- `tts_time_to_first_chunk`、各`tts_audio_query`、各`tts_synthesize`、`tts_playback`が記録される。
- `tts_time_to_first_chunk`の中央値がbaseline `tts_request_wall` 2,762.335 msより1,000 ms以上短い。
- `ptt_release_to_playback_start`の中央値が12,792.912 ms baselineより1,000 ms以上短い。Pi TTFTも
  併記し、モデル側の変動とPico側の短縮を混同しない。
- playback childは1つで、health failureは0。

- [ ] **Step 5: field結果を研究記録へ固定する**

`docs/superpowers/research/2026-07-19-resident-tts-pipeline-validation.md`へfixture、モデル、thinking
level、tool result、stage timings、first-chunk短縮量、chunk数、playback process数、private artifact
path/mode、残課題を記録する。本文とtool bodyはprivate artifactから文書へ転載しない。

- [ ] **Step 6: verification commitを作る**

Run: `git diff --check && npx --yes --package secretlint --package @secretlint/secretlint-rule-preset-recommend secretlint docs/superpowers/research/2026-07-19-resident-tts-pipeline-validation.md`

Expected: 両方PASS。

```bash
git add docs/superpowers/research/2026-07-19-resident-tts-pipeline-validation.md
git commit -m "docs(voice): validate incremental TTS latency"
```

- [ ] **Step 7: clean worktreeとcommit範囲を確認してpushする**

Run: `git status --short && git log --oneline --decorate -10 && gh pr view 100 --json headRefName,baseRefName,state,isDraft,url`

Expected: worktree clean、head branchは`codex/resident-latency-observability`、PR #100のheadと一致。

Run: `git push origin codex/resident-latency-observability`

Expected: push成功。PR本文へ、モデル設定不変、first-chunk改善、連続process、全gate、field evidenceを
追記する。`github-pr-convergence` skillでreview threadとrequired checkを確認し、actionable feedbackが
あれば修正・再検証・再pushしてPRを収束させる。
