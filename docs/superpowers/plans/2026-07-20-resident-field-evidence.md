# Resident Field Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** resident voiceのmetadata reportを共有stdoutではなくprivate fileへ直接保存し、実provider計測を単発E2E smokeから反復benchmarkへ進める手順を固定する。

**Architecture:** `src/runtime/resident-voice-validation.ts`に既存のdirectory、owner、mode、no-overwrite規則を再利用するprivate artifact ownerを置く。field CLIは任意のreport sinkをprovider起動前に確保し、`ResidentVoicePseudoAudioReport`だけを一度書く。検証順序は`TOOLS.md`に置き、production runtimeや通常telemetryは変更しない。

**Tech Stack:** TypeScript、Node.js filesystem API、Vitest、Just、Secretlint

---

### Task 1: Private artifact filesystem ownerを共通化する

**Files:**
- Modify: `src/runtime/resident-voice-validation.ts`
- Modify: `tests/resident-voice-validation.test.ts`

- [ ] **Step 1: 新しいartifact writerの失敗testを書く**

`tests/resident-voice-validation.test.ts`へ、次のAPIを期待するtestを追加する。

```ts
import {
  createPrivateResidentVoiceArtifact,
  createPrivateResidentVoiceValidationSink
} from "../src/runtime/resident-voice-validation.js";

it("writes one private metadata artifact without overwrite or symlink traversal", () => {
  const directory = mkdtempSync(join(tmpdir(), "pico-voice-report-"));
  const path = join(directory, "report.json");
  const artifact = createPrivateResidentVoiceArtifact({ path });

  artifact.write('{"status":"passed"}\n');
  artifact.close();

  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(path, "utf8")).toBe('{"status":"passed"}\n');
  expect(() => createPrivateResidentVoiceArtifact({ path })).toThrow(
    "private artifact must not already exist"
  );
});
```

既存のvalidation sink testも保持し、共通化後にvalidation JSONLが同じ内容とmodeを維持することを
確認する。

- [ ] **Step 2: REDを確認する**

Run:

```bash
npx vitest run tests/resident-voice-validation.test.ts
```

Expected: `createPrivateResidentVoiceArtifact`がexportされていないためFAIL。

- [ ] **Step 3: 最小のprivate artifact ownerを実装する**

`src/runtime/resident-voice-validation.ts`へ次を追加する。

```ts
export type PrivateResidentVoiceArtifact = {
  readonly write: (content: string) => void;
  readonly close: () => void;
};

export function createPrivateResidentVoiceArtifact(options: {
  readonly path: string;
}): PrivateResidentVoiceArtifact {
  const directory = dirname(options.path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  requirePrivateArtifactDirectory(directory);
  const descriptor = openNewPrivateArtifact(options.path);
  let closed = false;

  return {
    write(content) {
      if (closed) throw new Error("pico resident voice private artifact is closed");
      writeSync(descriptor, content, undefined, "utf8");
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(descriptor);
    }
  };
}
```

既存のdirectory validationと`openSync(path, "wx", 0o600)`をこのownerへ移し、validation sinkは
`artifact.write()`と`artifact.close()`を委譲する。filesystem規則は一か所に保つ。

- [ ] **Step 4: GREENと既存回帰を確認する**

Run:

```bash
npx vitest run tests/resident-voice-validation.test.ts
npm run typecheck
```

Expected: focused testsとtypecheckがPASS。

- [ ] **Step 5: commitする**

```bash
git add src/runtime/resident-voice-validation.ts tests/resident-voice-validation.test.ts
git commit -m "refactor(voice): share private artifact ownership"
```

### Task 2: Metadata reportをprivate fileへ直接保存する

**Files:**
- Modify: `scripts/field/resident-voice-pseudo-audio.ts`
- Modify: `tests/resident-voice-pseudo-audio-field.test.ts`

- [ ] **Step 1: CLI parseとpath衝突の失敗testを書く**

引数testへ`--report-output`を追加する。

```ts
expect(
  readResidentVoicePseudoAudioArguments([
    "--audio-fixture", "/tmp/pico-ja.wav",
    "--validation-output", "/tmp/private/events.jsonl",
    "--report-output", "/tmp/private/report.json"
  ])
).toMatchObject({ reportOutputPath: "/tmp/private/report.json" });

expect(() =>
  readResidentVoicePseudoAudioArguments([
    "--audio-fixture", "/tmp/pico-ja.wav",
    "--validation-output", "/tmp/private/events.jsonl",
    "--report-output", "/tmp/private/events.jsonl"
  ])
).toThrow("--report-output must differ");
```

- [ ] **Step 2: Report file分離の失敗testを書く**

`runResidentVoicePseudoAudioCommand`を期待するtestを追加する。test用`run`は次のcontent-freeな
`ResidentVoicePseudoAudioReport`を返し、stdout writerには通知文字列を先に書いてもreport fileへ
混入しないことを確認する。

```ts
function pseudoAudioReport(status: "passed" | "failed"): ResidentVoicePseudoAudioReport {
  return {
    status,
    audioFixturePath: "/tmp/pico-ja.wav",
    validationOutputPath: "/tmp/private/events.jsonl",
    validationEventCount: 4,
    validation: { staffTranscriptPresent: true, finalPiResponsePresent: true },
    requiredToolName: "stackchan_get_status",
    toolExecutions: [
      { toolName: "stackchan_get_status", isError: false, durationMs: 12 }
    ],
    agent: { provider: "openai-codex", id: "gpt-5.6-sol", thinkingLevel: "medium" },
    runtime: {
      acceptedHolds: 1,
      completedTurns: 1,
      emptyHolds: 0,
      ignoredBusyTalkPresses: 0,
      cancelledTurns: 0,
      lateResultsSuppressed: 0,
      failedCaptures: 0,
      failedTurns: 0
    },
    playback: { sinkOpenCount: 1 },
    telemetry: {
      mode: "in_process",
      health: { logs: { consecutiveFailures: 0 }, metrics: { consecutiveFailures: 0 } },
      logRecordCount: 1,
      metricDataPointCount: 1
    },
    stages: []
  };
}
```

```ts
const writes: string[] = ["unrelated Pi extension output"];
const exitCode = await runResidentVoicePseudoAudioCommand(arguments_, {
  run: () => Promise.resolve(pseudoAudioReport("passed")),
  writeStdout: (value) => writes.push(value)
});

expect(exitCode).toBe(0);
expect(JSON.parse(readFileSync(arguments_.reportOutputPath ?? "", "utf8"))).toEqual(
  pseudoAudioReport("passed")
);
expect(readFileSync(arguments_.reportOutputPath ?? "", "utf8")).not.toContain(
  "unrelated Pi extension output"
);
expect(statSync(arguments_.reportOutputPath ?? "").mode & 0o777).toBe(0o600);
```

`failed` reportはfileへ保存してexit 1とする。`run`がthrowした場合はartifactをcloseし、bounded stderrを
書いてexit 2を返し、予約済みreport fileが空で有効なJSON証拠にならないこともtestする。

- [ ] **Step 3: REDを確認する**

Run:

```bash
npx vitest run tests/resident-voice-pseudo-audio-field.test.ts
```

Expected: 未対応flagと未定義command functionによりFAIL。

- [ ] **Step 4: 引数とcommand boundaryを最小実装する**

`ResidentVoicePseudoAudioArguments`へ`reportOutputPath?: string`を追加し、argument reader、help、usageを
更新する。`reportOutputPath`がfixtureまたはvalidation pathと同じ場合はprovider起動前に拒否する。

次のcommand boundaryを追加する。

```ts
export async function runResidentVoicePseudoAudioCommand(
  arguments_: ResidentVoicePseudoAudioArguments,
  dependencies: {
    readonly run?: typeof runResidentVoicePseudoAudio;
    readonly writeStdout?: (value: string) => void;
    readonly writeStderr?: (value: string) => void;
  } = {}
): Promise<number> {
  const writeStdout = dependencies.writeStdout ?? ((value) => process.stdout.write(value));
  const writeStderr = dependencies.writeStderr ?? ((value) => process.stderr.write(value));
  let artifact: PrivateResidentVoiceArtifact | undefined;

  try {
    artifact =
      arguments_.reportOutputPath === undefined
        ? undefined
        : createPrivateResidentVoiceArtifact({ path: arguments_.reportOutputPath });
    const report = await (dependencies.run ?? runResidentVoicePseudoAudio)(arguments_);
    const serialized = `${JSON.stringify(report, undefined, 2)}\n`;
    if (artifact === undefined) {
      writeStdout(serialized);
    } else {
      artifact.write(serialized);
      writeStdout(
        `pico pseudo-audio ${report.status}; metadata report written to ${arguments_.reportOutputPath}\n`
      );
    }
    return report.status === "passed" ? 0 : 1;
  } catch (error) {
    writeStderr(`pico pseudo-audio validation failed: ${boundedErrorMessage(error)}\n`);
    return 2;
  } finally {
    artifact?.close();
  }
}
```

`boundedErrorMessage`はerror messageをUTF-8で1,024 bytes以下に切る。direct executionはhelp以外を
このfunctionへ委譲する。

- [ ] **Step 5: GREENとprivacy assertionを確認する**

Run:

```bash
npx vitest run tests/resident-voice-pseudo-audio-field.test.ts tests/resident-voice-validation.test.ts
npm run typecheck
npm run lint -- --no-warn-ignored scripts/field/resident-voice-pseudo-audio.ts \
  src/runtime/resident-voice-validation.ts \
  tests/resident-voice-pseudo-audio-field.test.ts \
  tests/resident-voice-validation.test.ts
```

Expected: focused tests、typecheck、scoped lintがPASS。report serializationはtranscript、assistant本文、
tool body、expected hashを含まない。

- [ ] **Step 6: commitする**

```bash
git add scripts/field/resident-voice-pseudo-audio.ts \
  src/runtime/resident-voice-validation.ts \
  tests/resident-voice-pseudo-audio-field.test.ts \
  tests/resident-voice-validation.test.ts
git commit -m "feat(voice): write private field reports"
```

### Task 3: 検証ラダーを還元し、PRをマージ可能にする

**Files:**
- Modify: `TOOLS.md`
- Modify: `docs/superpowers/plans/2026-07-19-resident-tts-pipeline.md`
- Modify: `docs/superpowers/research/2026-07-19-resident-tts-pipeline-validation.md`

- [ ] **Step 1: TOOLS.mdへ実provider検証ラダーを書く**

次の順序と停止条件を追加する。

```markdown
## Real-Provider Field Validation

1. Run focused tests and type/lint checks while iterating.
2. Run `just smoke-voice-providers` for Apple Speech and AivisSpeech reachability.
3. Run one strict full-turn pseudo-audio smoke with canonical fixture hash, required tool,
   private validation output, and `--report-output`.
4. Do not benchmark until that report is `passed`.
5. Without changing code, config, or fixture, collect at least three sequential runs.
6. Report Pi TTFT separately from Pico stages.
7. Run `just check` and Secretlint on the final tree.

Never use shared raw stdout as the metadata evidence artifact. If a diagnostic pipeline uses
`tee`, enable `set -o pipefail`; the authoritative report comes from `--report-output`.
```

- [ ] **Step 2: 計画と研究記録のcommandを更新する**

既存の3-run commandへrunごとの`--report-output`を追加し、raw stdoutの`tee`を正式証拠から外す。
研究記録には、旧runでshell filterが必要だった事実と、今後はfield-owned reportがその依存を除くことを
追記する。既存の実測値は変更しない。

- [ ] **Step 3: format、polishment、ai-slop-cleanerを通す**

Run:

```bash
just format
git diff --check
```

今回のdiffだけを対象に、重複filesystem規則、不要wrapper、曖昧なreport命名、本文を含み得る出力を
点検する。behavior変更が生じた場合はfocused testsを再実行する。

- [ ] **Step 4: 全local gateとsecret scanを通す**

Run:

```bash
just check
npx --yes --package secretlint \
  --package @secretlint/secretlint-rule-preset-recommend secretlint .
git diff --check
```

Expected: Swift sidecar builds/tests、TypeScript、ESLint、ast-grep、Biome、Vitest、Secretlintが全てPASS。

- [ ] **Step 5: 単発real-provider smokeを行う**

mode `0700`の新規directoryを作り、canonical fixture、期待hash、`stackchan_get_status`、
`--report-output`を指定して1 runを実行する。

Expected: exit 0、report `status: passed`、report mode `0600`、validation mode `0600`、tool 1回成功、
playback sink open 1、failed/cancelled turn 0。raw stdoutに何が出てもreport JSONはmetadata-onlyである。

- [ ] **Step 6: docsと実装をcommitしてpushする**

```bash
git add TOOLS.md \
  docs/superpowers/plans/2026-07-19-resident-tts-pipeline.md \
  docs/superpowers/research/2026-07-19-resident-tts-pipeline-validation.md \
  docs/superpowers/plans/2026-07-20-resident-field-evidence.md
git commit -m "docs(voice): codify real-provider validation"
git push origin codex/resident-latency-observability
```

- [ ] **Step 7: PR #100を再収束してmergeする**

`gh pr view 100`とreview thread queryで、remote head、checks、review、未解決thread、baseを確認する。
PR本文へprivate reportと検証ラダーを追記する。最新HEADのrequired checkが成功し、未解決threadが0、
mergeableであることを確認してからDraftを解除し、repositoryが提示するmerge methodでPR #100を
`feat/hold-to-talk-resident-control`へmergeする。#99はmergeしない。

- [ ] **Step 8: merge後のremote状態を確認する**

Run:

```bash
gh pr view 100 --json state,mergedAt,mergeCommit,url,baseRefName,headRefName
git status --short
```

Expected: PR #100は`MERGED`、baseは`feat/hold-to-talk-resident-control`、worktreeはclean。worktreeとbranchは
自動削除せず、merge結果の確認用に保持する。
