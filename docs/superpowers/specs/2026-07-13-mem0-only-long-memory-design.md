# Mem0 一本化 long memory 設計

## 目的

Pico の durable long memory を Mem0 OSS に一本化する。独自 SQLite/FTS と Mem0 の
二重実装を廃止し、session cutoff から施設知識を抽出する worker、Mem0 への保存、
Mem0/Qdrant 検索を一つの明確な経路にする。

## 決定

1. Mem0 OSS を durable memory の唯一の保存・検索・履歴管理境界にする。
2. Pi worker は cutoff から 0〜5 件の facility-memory draft を抽出する。
3. Pico は既存の exact-schema validation と、明示的な child-profile field の構造的拒否を維持する。
4. validation 済み draft を Mem0 へ `infer: false` で一件ずつ保存する。
5. `pico_memory_search` は Mem0 provider を直接検索する。
6. `memory.longMemory` と独自 SQLite/FTS/lifecycle/queue を後方互換なしで削除する。
7. worker model は `memory.mem0` 配下の startup-only YAML で指定し、任意の model id を
   Pi model registry へそのまま渡す。Luna 固有の型、分岐、allowlist、default を作らない。
8. Privacy Filter、可逆マスキング、仮 adapter、fallback、custom policy engine は追加しない。

## 非目標

- Mem0 SDK の同時 upgrade。
- retention/decay mutation の本番有効化。
- persisted delivery queue、retry、dead letter、exactly-once、fingerprint deduplication。
- Mem0 Platform への移行。
- child tracking、評価、scoring、profiling。
- 氏名に結び付く個別児童記録や健康、障害、虐待、家庭事情の保存。

## Configuration contract

`memory` は `mem0` だけを持つ。enabled な設定は vector store、worker model、embedder を
明示する。

```yaml
memory:
  mem0:
    enabled: true
    historyDbPath: ~/.local/share/pico/mem0-history.db
    vectorStore:
      provider: qdrant
      localBaseUrl: http://127.0.0.1:6333
      collectionName: pico_facility_memory
    worker:
      provider: pi_model
      piProvider: openai-codex
      api: openai-codex-responses
      model: <configured-model-id>
      thinkingLevel: high
      timeoutMs: 120000
    embedder:
      provider: sidecar
      localBaseUrl: http://127.0.0.1:8791
      model: <configured-embedding-model>
      embeddingDims: 1024
```

`worker.model` は非空文字列だけを要求する。特定モデル名を schema や runtime で検証しない。
`thinkingLevel` は Pi worker extraction のため必須とする。Mem0 の内部 LLM adapter が同じ
設定を利用する場合も、model 固有の挙動は持たない。

`infer` は設定から削除する。Pico が抽出済み draft を渡す経路は常に `infer: false` であり、
運用設定によって facility-scope validation を迂回できないようにする。

## Runtime flow

### Write

1. resident conversation が session cutoff を確定する。
2. resident runner は一回限りの in-process worker operation を開始する。
3. worker は YAML の `provider/api/model/thinkingLevel/timeoutMs` で Pi session を生成する。
4. extractor は tool を持たず、cutoff だけから exact JSON を生成する。
5. Pico は件数、field、source entry、category を検証し、明示的な child-profile field を
   構造的に拒否する。extractor instruction は個別児童・高リスク情報を出力対象から除外する。
6. draft ごとに title と body を一つの保存本文へ正規化し、category、tags、source session、
   source entries、createdAt を metadata に含める。
7. Mem0 provider は `infer: false` で add を await する。
8. 成功件数と memory id だけを audit に記録する。本文、transcript、query は記録しない。
9. extraction または add が失敗した場合は、その cutoff operation を失敗として表面化する。
   自動 retry、fallback、別 DB への保存は行わない。

draft が 0 件なら Mem0 add は行わず正常終了する。

### Search

1. `pico_memory_search` は startup config から Mem0 provider を lazy initialize する。
2. query と limit を既存境界で検証する。
3. facility scope id を filter として Mem0 search を行う。
4. id、content、metadata、score を bounded result に変換する。
5. memory 本文を untrusted data として扱う既存 tool guidance を維持する。
6. Mem0 が disabled/unavailable の場合は bounded unavailable result を返し、SQLite fallback
   は行わない。

## State boundary checklist

### State owner

- YAML: startup configuration の唯一の owner。
- Mem0 OSS: memory records、vector search、history の唯一の durable owner。
- Qdrant: Mem0 adapter 配下の vector store。
- resident runner: 現在実行中の cutoff operation の owner。

### Lifecycle

- config は startup-only immutable であり、変更には restart が必要。
- migration/dual-read/dual-write/backward compatibility はない。
- old SQLite schema、FTS、candidate/review/job tables は削除する。
- old DB の自動 import、backup、fallback は行わない。

### Mutation paths

- YAML load。
- session cutoff worker による Mem0 add。
- explicit Mem0 delete API を使う管理/検証経路。
- test/field harness。

hot reload、environment-specific alternate owner、第二の database writer は作らない。

### Consumers

- config parser/types/example。
- resident voice runner。
- facility memory extractor / Pi session factory。
- Mem0 runtime/provider。
- `pico_memory_search`。
- audit、field/smoke scripts、tests、運用文書。

### Async ownership and shutdown

- cutoff ごとに一つの Promise を resident runner が追跡する。
- 同一 runner の in-flight operation を shutdown grace 内で await する。
- hard kill 後の自動再開や persisted queue は作らない。
- failure は audit と呼び出し元へ返す。silent success にしない。

## 削除対象

- `PicoLongMemoryConfig` / `PicoLongMemoryExtractionConfig`。
- `memory.longMemory` config parser/default/example/tests。
- custom `LongMemoryStore`、SQLite schema、FTS、candidate/review APIs。
- session candidate queue、retry/dead-letter、decay/archive/delete state。
- resident memory drain worker と独立 memory LaunchAgent。
- SQLite field harness とそれ専用 npm/Just targets。
- SQLite provenance/lifecycle を前提にする search serialization。

long-memory module folder 自体は、extractor、Mem0 adapter/runtime、facility-memory contract の
owner として維持してよい。

## TDD acceptance criteria

- arbitrary model id を含む YAML が parse され、同じ文字列で Pi model lookup が呼ばれる。
- model id に `luna` を含むことを要求する assertion、branch、allowlist、default がない。
- enabled Mem0 config は `thinkingLevel` を必須とする。
- `memory.longMemory` は unknown field として拒否される。
- worker は extractor の 0 件を no-op とし、1〜5 件を `infer: false` で Mem0 に保存する。
- invalid draft と明示的な child-profile field は Mem0 add より前に拒否される。
- extractor instruction は個別児童・高リスク情報を除外し、自然言語 privacy classifier は追加しない。
- Mem0 add failure は retry/fallback されず呼び出し元へ返る。
- `pico_memory_search` は Mem0 search を使用し、SQLite store を開かない。
- search result は既存の文字数上限と untrusted-data guidance を維持する。
- shutdown は in-flight worker operation を await する。
- old queue/drain/SQLite lifecycle entrypoints と production launch configuration が存在しない。
- `just check` と secret scan が成功する。

## Rollout

1. tests を Mem0-only contract へ Red で更新する。
2. config と provider contract を一本化する。
3. write worker と resident ownership を置き換える。
4. search tool を Mem0 に切り替える。
5. old store/queue/scripts/tests/docs を削除する。
6. field smoke で arbitrary configured model による extraction と Mem0/Qdrant add/search を確認する。
7. polishment、ai-slop-cleaner、independent review、CI/review convergence を行う。

## 調査根拠

[Mem0 一本化調査](../research/2026-07-13-mem0-only-memory-architecture.md) を参照する。
