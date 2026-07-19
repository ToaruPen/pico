# Resident Field Evidence Design

## 目的

実providerを使うresident voice検証で、計測前の環境不備を早期に検出し、共有stdoutへ出た
無関係なPi extension出力をmetadata証拠へ混入させない。

この変更はfield harnessと開発手順だけを対象とする。production runtime、Pi extension設定、
model、thinking level、音声provider、通常telemetryの内容は変更しない。

## 振り返り

### Fixture identity

- Initial failure: ファイル形式が正しい別用途のfixtureを使い、想定toolが選ばれないrunを開始した。
- Final solution: 認識結果のUTF-8 SHA-256完全一致をfield evaluatorで要求した。
- Insight: 音声形式の検査だけでは質問内容を証明できない。期待する振る舞いとfixture identityを同じ
  実行契約で検証する必要がある。

この教訓は`--expected-transcript-sha256`とfail-closed testへ還元済みである。

### Playback compatibility

- Initial failure: command availabilityだけでは、FFmpeg 8.1がraw PCM用の`-ac`を拒否することを
  検出できなかった。
- Final solution: `-ch_layout Nc`へ修正し、実stdinとunit testで再生契約を確認した。
- Insight: providerのversion表示成功と、実際の引数・入出力契約の成功は別である。

この教訓はcontinuous playbackの引数testと、full-turn field validationへ還元済みである。

### Evidence integrity

- Initial failure: 非空transcript、非空response、1件以上のstageだけで成功判定できたため、誤認識や
  重複eventを偽陽性にできた。
- Final solution: transcript hash、event cardinality、同一session、tool start/end pairing、stage
  cardinality、playback process数を一つのfail-closed evaluatorで検証した。
- Insight: 実測値は、計測対象のturnが意味的にも構造的にも正しい場合だけ採用できる。

この教訓はfield evaluatorと回帰testへ還元済みである。

### Shared stdout

- Initial failure: Pi-level notification extensionがassistant本文をstdoutへ書き、`tee`で保存する
  metadata reportへ混入し得た。
- Final solution: 診断時はshell filterで除去したが、呼び出し側の注意に依存している。
- Insight: 複数extensionが共有するstdoutはartifact boundaryではない。field harnessが所有するfileへ
  reportを直接書かなければならない。

この仕様で決定的に還元する。

### Validation order

- Initial failure: fixtureとplayback契約が確定する前に3回の反復計測へ入り、修正後に全runを
  取り直した。
- Final solution: 正しいfull-turn runを1回通してから反復計測した。
- Insight: provider単体smoke、full-turn smoke、benchmark、全gateを段階化し、前段の失敗時は後段を
  開始しない。

この仕様で`TOOLS.md`へ還元する。

## 既に還元済みの境界

次の教訓は既存の仕様、AGENTS、型境界、testで固定済みのため、新しいruleを重ねない。

- 1 activationは1 turnであり、talk中や再生中の追加talkを受け付けない。
- cancelは独立controlで、capture、Pi turn、TTS、playbackを同じgeneration内で停止する。
- PiがinteractionごとのAgentSessionを所有し、Picoはturn終了時にdisposeする。
- durable memoryはPi-level pluginの責務であり、Picoは抽出workerやmemory storeを持たない。
- modelとthinking levelを変えず、Pico側は文単位合成とcontinuous playbackで待ち時間を短縮する。
- 通常のauditとOpenTelemetryは本文、tool body、音声、session identifierを保持しない。

## Private metadata report

`field:resident-voice-pseudo-audio`へ任意の`--report-output <path>`を追加する。

- 指定時は最終`ResidentVoicePseudoAudioReport`をJSONとしてfield harness自身が直接保存する。
- reportは現在stdoutへ出しているmetadata contractと同じ内容だけを保持する。
- transcript、assistant本文、tool arguments/results、期待hash、実hash、音声を含めない。
- validation JSONLは従来どおり`--validation-output`だけが保持する。
- `--report-output`、`--validation-output`、`--audio-fixture`は互いに異なるpathを要求する。
- report出力後もprocess exit codeはreportの`passed` / `failed`に対応する。
- stdoutは人間向け表示であり、証拠artifactとして扱わない。

report sinkはprovider起動前にfileを新規作成してdescriptorを保持する。runが`passed`または`failed`の
reportを返したらJSONを1回だけ書いてcloseする。reportを構成できない例外ではdescriptorをcloseし、
空fileを有効な証拠として扱わずexit 2にする。

### File contract

report fileは既存のprivate validation artifactと同じfilesystem contractに従う。

- 親directoryを必要時に`0700`で作る。
- 親directoryはsymlinkではない実directoryで、現在userが所有し、modeが`0700`である。
- fileは`wx`で新規作成し、既存file、symlink、append、overwriteを拒否する。
- file modeを`0600`へ固定する。
- write失敗時もdescriptorをcloseする。

private artifactのfilesystem実装は一つのownerへ集約し、validation sinkとmetadata reportで安全規則を
複製しない。

## Real-provider validation ladder

`TOOLS.md`に次の順序を記載する。

1. focused unit testとtype/lintを先に通す。
2. `smoke:voice-providers`でApple SpeechとAivisSpeechの接続を確認する。
3. canonical fixture、期待transcript hash、期待tool、private validation output、private report outputを
   指定したfull-turn runを1回行う。
4. full-turn reportが`passed`になるまでbenchmarkへ進まない。
5. code、config、fixtureを変更せず、同じ条件で合計3回以上を直列実行する。
6. Pi TTFTとPico stageを別々に記録し、model側の変動をPico改善として扱わない。
7. 最終treeで`just check`とSecretlintを通す。

shell pipelineで補助表示を保存する場合は`set -o pipefail`を必須とする。ただし正式なmetadata証拠は
`--report-output`で作り、raw stdoutを`tee`したfileを採用しない。

## Error handling

- 不正flag、空path、path衝突はprovider起動前にusage errorとする。
- private reportを作れない場合はrunを開始しない。
- run中に失敗した場合も、生成可能な最終metadata reportを保存してexit 1にする。
- runtime例外でreport自体を構成できない場合は、validation、telemetry、playbackのcleanupを優先し、
  例外をbounded stderrへ返す。
- shared stdoutの内容はreport fileへ転送しない。

## Tests

TDDで次を固定する。

- `--report-output`のparse、help表示、path衝突拒否。
- mode `0700`の実directoryに新規`0600` reportを作る。
- 既存file、symlink leaf、symlink parent、unsafe directory modeを拒否する。
- report JSONがmetadata contractと一致し、contentful validation fieldと期待hashを含まない。
- validation sinkとreport writerが共通のprivate artifact ownerを使う。
- report指定の有無にかかわらず既存CLIとexit codeを維持する。

## 受け入れ条件

- raw stdoutを保存しなくても、1 runのmetadata reportを安全に取得できる。
- Pi extensionがstdoutへ任意の通知を書いてもreport fileのJSONは汚染されない。
- canonical fixtureと期待toolを満たさないrunはbenchmark sampleにならない。
- private artifactのmode、owner、no-overwrite、no-symlink規則が決定的testで守られる。
- production runtimeと通常telemetryの契約に変更がない。
- `just check`、Secretlint、field focused testsが成功する。
