# Pi 所有 memory 責務境界設計

## 目的

Pico から short-term memory、durable memory、Mem0 integration を完全に除去する。
conversation context、transcript、history、working summary は Pi が所有し、durable memory が
必要な場合は Pico とは独立した Pi-level plugin として導入する。Pi plugin である Pico の
内部へ memory plugin を組み込まない。

## 決定

1. Pi core は non-persistent host session、interaction AgentSession、transcript、context、history、
   session persistence能力、tool registry、subagent context を所有する。
2. Durable memory は、必要な環境だけが Pico と同列の Pi-level plugin として導入する。
3. Pi-level memory plugin は Mem0/Qdrant の設定、抽出、保存、検索、更新、削除、history、
   retention、tool registration、runtime lifecycle を所有する。
4. Pico は memory config、type、module、store、worker、provider、tool を持たない。
   Mem0/Qdrant を import、初期化、呼び出し、wrap、proxy しない。
5. Pico の interaction ending は facility audio と address/attention lifecycle だけを終了する。
   memory extraction や durable write の成否で終了処理や shutdown を待たせない。
6. Memory tool の読込みと可視性は Pi settings が所有する。Pico は memory tool の存在、名称、
   load order に依存しない。
7. `pico_memory_search` と `pico_session` は廃止する。互換 alias、adapter、fallback、no-op
   provider は設けない。
8. Pi-level memory plugin の実装、設定、運用、検証はこの repository の scope 外とする。

## Ownership

| Owner | Responsibilities |
| --- | --- |
| Pi core | Host/interaction AgentSession、transcript、context/history、session persistence能力、tool registry、subagents |
| Pi-level memory plugin | Durable-memory provider、tools、config、extraction、mutation、retention、lifecycle |
| Pico | Facility audio、address/attention、TTS/echo、facility runtime restrictions |
| Pi settings | Plugin loading と tool visibility |

## Runtime boundary

通常の会話経路は次のとおりとする。

```text
facility input -> Pico audio/attention -> Pi in-memory interaction session -> Pico speech output
```

Durable memory を利用する場合も、その経路は Pico を通らない。

```text
Pi-level memory plugin -> Pi hooks/tools -> Mem0/Qdrant
```

Pico から Pi-level memory plugin への直接呼び出し、共有 client factory、cutoff callback、
config pass-through は存在しない。

## Pico interaction lifecycle

Pico は resident audio と address/attention 制御に必要な process-local state だけを保持する。

- session ID
- `active | ended` state
- start/end timestamps
- trusted activation trigger
- inactivity timer

Pico は staff/assistant utterance、transcript、summary、source entry ID、memory candidate、cutoff
payload を保持しない。

Interaction ending は次の順序で処理する。

1. Interaction state を ended にする。
2. 必要な場合だけ farewell turn を完了する。
3. Session-owned deferred tool を cancel する。
4. Pi SDK session を dispose する。
5. Pico lifecycle record を削除する。

Memory write、memory acknowledgement、memory retry、memory drain はこの順序に含めない。

## State Boundary

1. **State being changed:** Pico の session record から conversation entries、cutoff payload、
   memory worker/provider state を除去し、interaction-control state だけを残す。
2. **Lifecycle boundary:** `restart-required`。変更は新しい Pi/Pico process の起動後に有効になる。
   既存 process の session state を migrate しない。
3. **Mutation path inventory:** resident activation が start、accepted input/turn completion が activity
   refresh、inactivity/shutdown が end、voice runtime cleanup が remove を行う。config、environment、
   API、admin job、background memory worker、migration、rollback からの mutation path はない。
4. **Consumer/invariant inventory:** resident voice runtime、farewell、deferred-tool cancellation、Pi SDK
   session disposal、audit/probe、startup/shutdown、tests が session state を消費する。Mem0、Qdrant、
   embedder、memory smoke、memory health check は consumer ではない。
5. **Central enforcement point:** `SessionLifecycle` が interaction state の唯一の mutation boundary と
   なる。voice runtime は内部 map や timer を直接変更しない。
6. **Forbidden paths:** transcript の Pico state への複製、cutoff-to-memory hook、memory tool name の
   hard-code、Pico YAML からの memory config 読込み、Pico runtime からの provider 初期化、test-only
   memory fallback を禁止する。
7. **Required tests:** one-active-session、activity refresh、timed end、shutdown end、farewell、deferred
   cancellation、Pi session disposal、terminal record removal、extension tool/metadata/config/package に
   memory ownership がないことを検証する。
8. **Async ownership and terminal states:** resident voice runtime が farewell、deferred cancellation、
   Pi session disposal、shutdown error aggregation を所有する。cleanup 完了後に lifecycle record を
   削除する。memory queue、background worker、delivery acknowledgement は存在しない。

## Removal scope

Pico repository から以下を削除する。

- `memory` / `long_memory` module と metadata
- short-term memory store
- session transcript entries と memory cutoff contract
- `pico_memory_search` と `pico_session`
- `memory.*` YAML config と parser/types
- Mem0、Qdrant、embedding dependencies
- extraction worker、provider adapter、embedding sidecar
- memory-specific smoke、field harness、LaunchAgent、audit/probe events
- Pico memory ownership を前提とする tests と current documentation

旧 SQLite/FTS、candidate queue、custom memory worker、memory LaunchAgent は復活させない。

## Documentation handling

- Current source documents はこの ownership boundary に更新する。
- 却下された Mem0-only architecture の spec、research、plan は削除する。
- 過去の実装計画と field-test evidence は historical record として保持し、先頭にこの設計への
  supersession note を追加する。
- Child tracking、scoring、profiling を禁止する product policy は維持するが、Pico 内の memory
  validator や privacy filter として実装しない。

## Acceptance criteria

- `src/modules/memory/`、`src/modules/long-memory/`、`src/runtime/memory-tool.ts`、
  `src/runtime/session-tool.ts` が存在しない。
- Pico config、package、scripts、launchd から Mem0、Qdrant、embedder、extraction worker が消える。
- Pico extension は memory provider の有無に関係なく起動し、memory/session tool を登録しない。
- Resident voice は発話本文を Pico state に複製せず、memory 処理なしで timed ending と shutdown
  cleanup を完了する。
- Session terminal state は farewell、deferred cancellation、Pi session disposal 後に削除される。
- Tests は registry、tool list、config schema、package dependency、runtime lifecycle に Pico-owned
  memory が残らないことを証明する。
- Current source documents は Pi、Pi-level plugin、Pico、Pi settings の責務を同じ表現で記述する。
- Backward compatibility alias、fallback、dual path は存在しない。

## PR migration

既存 PR #97 で完了済みの SQLite/FTS、candidate queue、custom worker、memory LaunchAgent の削除は
維持する。PR 内で追加された Mem0 replacement は削除し、最終 diff を「Pico から memory ownership
を除去する変更」として収束させる。
