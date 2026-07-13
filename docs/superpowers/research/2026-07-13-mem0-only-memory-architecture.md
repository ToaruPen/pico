# Mem0 一本化調査

調査日: 2026-07-13

## 結論

Pico の durable long memory は Mem0 OSS を唯一の保存・検索・履歴管理境界とする。
独自 SQLite/FTS、candidate/review store、retry/dead-letter queue、独自 lifecycle/decay
は重複実装であり、後方互換を設けず削除する。

session cutoff の全 transcript を Mem0 に渡して再抽出させるのではなく、Pi worker が
施設知識だけを 0〜5 件の構造化 draft として抽出し、Pico の決定的 validation を通過した
draft だけを `infer: false` で Mem0 に保存する。この境界により、Mem0 は storage/retrieval
を所有し、Pico は施設知識限定という product policy と構造化 contract を所有する。

worker model は startup-only YAML から解決する。Luna は現在の運用選択肢にすぎず、
型、runtime、test、default、allowlist のいずれにもモデル固有名を固定しない。

## 現行実装で確認したこと

- `memory.longMemory` は独自 SQLite schema、FTS、candidate/review、queue、retry、
  dead-letter、archive/delete/decay を所有している。
- `memory.mem0` は Mem0 OSS、Qdrant、LLM、embedder を別経路として所有している。
- cutoff enqueue は Mem0 の history DB path を使う一方、drain/search は
  `memory.longMemory.databasePath` を使う箇所があり、二つの正本を同期する contract がない。
- 既存 extractor は 0〜5 件、source entry の参照整合性、施設知識限定、高リスク児童情報の
  構造的拒否をすでに実装している。これは Mem0 一本化後も必要である。

## Mem0 OSS の能力

公式 OSS 文書は、Mem0 を self-host 可能な adaptive memory engine とし、add、search、
update、delete、history、metadata filtering を提供している。

- [Open Source overview](https://docs.mem0.ai/open-source/overview)
- [OSS configuration](https://docs.mem0.ai/open-source/configuration)
- [OSS REST API](https://docs.mem0.ai/open-source/features/rest-api)
- [Add memory](https://docs.mem0.ai/core-concepts/memory-operations/add)
- [Search memory](https://docs.mem0.ai/core-concepts/memory-operations/search)
- [Update memory](https://docs.mem0.ai/core-concepts/memory-operations/update)
- [Delete memory](https://docs.mem0.ai/core-concepts/memory-operations/delete)

`infer: false` は入力本文をそのまま保存し、Mem0 の extraction/conflict-resolution を
迂回する。したがって Pico worker が抽出済み draft を保存する経路に適する。一方、
この経路では重複排除も行われない。現段階では独自 fingerprint、exactly-once queue、
reconciliation を追加せず、Mem0 add を await し、失敗を呼び出し元へ返す。

2026 年の新 memory algorithm は ADD-only extraction と semantic、BM25、entity matching
の hybrid retrieval を採用している。ただし Pico は worker 抽出済み draft を
`infer: false` で渡すため、Mem0 の LLM extraction に product policy を委譲しない。

- [OSS new memory algorithm migration](https://docs.mem0.ai/platform/features/graph-memory)
- [Mem0 releases](https://github.com/mem0ai/mem0/releases)

## Platform と OSS の差

Mem0 Platform の Memory Decay は project 単位の opt-in 機能であり、検索時に
`0.3x`〜`1.5x` の soft ranking bias を掛ける。削除、TTL、archive ではなく、
アクセス履歴を最大 20 件に制限した可逆な再順位付けである。

- [Platform vs OSS](https://docs.mem0.ai/platform/platform-vs-oss)
- [Memory Decay](https://docs.mem0.ai/platform/features/memory-decay)

この機能を現行の Mem0 OSS runtime に存在するものとして扱ってはならない。
retention/decay は別 Issue で、利用中の OSS version と provider の能力を前提に設計する。
OSS に native 機能がない場合も、第二の memory database を作らず、Mem0 metadata、
search、update/delete/history API の上に薄い maintenance job を置く範囲に限定する。

## Dependency 判断

現行 lockfile は `mem0ai` 3.0.7 を使用している。調査時点の latest Node SDK は 3.0.13
だが、一本化に必要な `add(..., { infer: false })`、search、delete は 3.0.7 に存在する。
今回の architecture migration と SDK upgrade を同時に行う必然性はないため、依存更新は
行わない。upgrade は release note と adapter compatibility を独立して検証できる。

## 採用する境界

```text
session cutoff
  -> configured Pi worker model
  -> 0..5 facility-memory drafts
  -> Pico structural and facility-scope validation
  -> Mem0 OSS add(infer: false)
  -> Qdrant-backed Mem0 search
  -> pico_memory_search
```

- Mem0 config/client factory が durable memory の唯一の runtime owner となる。
- worker と search tool は同じ Mem0 provider を使用する。
- configuration は startup-only immutable とし、変更は再起動で反映する。
- cutoff 処理中の extraction/add は shutdown 時に await する。
- persisted queue、retry、dead letter、fallback、auto-resume は設けない。
- worker model は YAML の任意文字列を Pi model registry へ渡す。
- durable memory は施設知識だけを対象にする。
- 児童追跡、評価、スコアリング、プロファイリング、氏名に結び付く個別児童記録、
  健康・障害・虐待・家庭事情は保存しない。

## retention/decay Issue への含意

- stable facility knowledge は年齢だけで削除しない。
- temporary operational note は metadata の明示期限を利用できる設計を検討する。
- supersession、search-time decay、retention、physical deletion を分ける。
- Mem0 Platform の decay を OSS の既存能力として前提にしない。
- custom SQLite lifecycle を復活させない。
