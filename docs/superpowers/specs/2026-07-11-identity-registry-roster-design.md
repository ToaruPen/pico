# pico Identity Registry・名簿設計

Status: Approved

Date: 2026-07-11

Revised: 2026-07-12

## 目的

`pico` がクラウド送信境界で児童名を仮名へ置換するには、ローカルで正式名、読み、明示登録されたあだ名を安定した内部参照へ解決できる必要がある。

この slice は、その前提となる最小のローカル Identity Registry と XLSX 名簿入出力を実装する。実際のクラウド送受信 Privacy Filter、書類変換、session payload 変換は後続の独立 slice とする。

## 設計判断

- ローカルの名簿、SQLite、import/export XLSX は平文とする。
- ローカルデータは OS user のファイル権限で保護する。
- application-level encryption、native keyring、暗号化 preview、暗号化 lookup は実装しない。
- Privacy Filter はローカル artifact を暗号化せず、クラウドへ渡す payload だけを必要最小限に仮名化する。
- LLM に人物の新規作成、人物統合、曖昧な呼称の推測、`subjectRef` 発行を任せない。
- registry は仮名解決に必要な identity field だけを扱う。

## 目標

- 登録児童ごとに stable opaque `subjectRef` を1つ持つ。
- schema-generated `.xlsx` で名簿の新規登録、更新、export を行う。
- TypeScript schema を runtime validation、型、template、import、export の共通契約にする。
- 正式名、読み、明示登録済みあだ名を deterministic exact lookup する。
- 同名児童は `ambiguous` とし、推測で1人を選ばない。
- alias collision と stale update を transaction 前に拒否する。
- bulk import は preview と owner の明示指示を必要とする。
- mutation は SQLite transaction で atomic に適用する。
- 通常の file permission は owner-only とする。

## 対象外

- クラウド送受信 Privacy Filter。
- Excel file、SQLite row、preview の暗号化。
- native keyring、key rotation、backup/recovery key lifecycle。
- custom ZIP parser、central-directory validation、CRC validation、deflate stream validation。
- application buffer の zero-fill。
- 話者登録、owner/guest authentication、user-presence proof。
- session、書類、memory からの identity または alias 自動学習。
- 生年月日、年齢、学年、所属、在籍日、退所日、連絡先、住所、医療、送迎、discipline、safeguarding 情報。
- 個別児童のイベント、傾向、採点、診断、profile。
- 任意列 mapping、旧 `.xls`、macro-enabled `.xlsm`、外部名簿システム同期。

## trust boundary

この slice は `pico` を実行する同一 OS user と、その user が開始したローカル Codex task を信頼する。同一 UID で任意 code を実行できる process、unlock 済み user session、悪意ある owner、端末全体の侵害から registry を守るものではない。

SQLite と XLSX の機密性は owner-only file permission と端末の標準 storage protection に委ねる。DB file だけが個別に流出する脅威を application encryption で保護することは、この slice の要件ではない。

`--owner-approved` は、agent が直前に受けた owner 指示を1回の mutation へ結び付ける workflow assertion である。話者認証や cryptographic approval proof ではない。

## architecture

```text
owner XLSX
  -> bounded file read
  -> ExcelJS workbook load
  -> fixed schema validation
  -> plaintext preview in local SQLite
  -> redacted change summary
  -> owner instruction
  -> owner-approved atomic apply
  -> plaintext local Identity Registry
  -> deterministic exact resolver
  -> opaque subjectRef
```

`src/modules/identity-registry/` が schema、normalization、workbook adapter、SQLite store、application service を所有する。CLI は application service だけを呼び、SQLite を直接操作しない。

後続 Privacy Filter は resolver API を読み取り専用で利用する。Privacy Filter は registry の persistence、名簿 mutation、Excel processing を所有しない。

## State Boundary

1. **State being changed:** SQLite の registry metadata、plaintext identity row、lookup index、plaintext preview、revision、registry epoch。
2. **Lifecycle boundary:** `migration-required`。schema shape または normalization policy を変更する場合は explicit schema migration が必要であり、open 中に hot reload しない。
3. **Mutation path inventory:** `init`、preview create、owner-approved apply、alias add/remove、activate/deactivate が適用対象。config watcher、environment、Pi tool、resident voice、background worker、LLM output、automatic migration は mutation path ではない。
4. **Consumer/invariant inventory:** schema validator、workbook parser/exporter、SQLite serializer、lookup resolver、preview diff、CLI、後続 Privacy Filter が同じ identity contract を消費する。
5. **Central enforcement point:** runtime mutation は `IdentityRegistryService` だけを通す。service が validation、collision check、revision/epoch check、transaction を所有する。
6. **Forbidden paths:** direct SQL mutation、LLM による `subjectRef` 発行、氏名による既存 row update、automatic alias learning、preview を介さない bulk import、Pi/resident voice からの管理 mutation を禁止する。
7. **Required tests:** init/open、全 mutation、owner approval 不在、stale revision/epoch、collision、ambiguous resolution、transaction rollback、permission、workbook validation、CLI routing を real SQLite と synthetic data で検証する。
8. **Async ownership and terminal states:** background queue、timer、long-lived preview worker は作らない。1 CLI invocation が workbook read、service、transaction、database close を完了して終了する。preview は applied または stale で消費される。明示 cleanup は未使用 preview を削除できる。

## data contract

```ts
type ChildIdentity = {
  readonly subjectRef: string;
  readonly revision: number;
  readonly name: {
    readonly family: string;
    readonly given: string;
    readonly familyKana: string;
    readonly givenKana: string;
  };
  readonly aliases: readonly string[];
  readonly status: "active" | "inactive";
  readonly updatedAt: string;
};
```

`subjectRef` は `pico` が `randomUUID()` で生成する。XLSX の新規 row と LLM output から受け取らない。既存 row は `subjectRef` と `revision` で更新し、氏名では update 対象を決定しない。

正式表示名は `family + given` から導出する。alias は lookup 専用であり、表示名を変更しない。

## lookup normalization

- input の前後 whitespace を除去する。
- Unicode NFKC normalization を適用する。
- 読みは Katakana を Hiragana へ変換する。
- 空文字、NUL、C0/C1 control、unpaired surrogate を拒否する。
- 正式漢字名、正式かな名、alias を exact lookup material とする。
- query は exact match を最初に検索する。
- exact match がない場合だけ、末尾の `さん`、`くん`、`君`、`ちゃん` を1回除去して検索する。
- 同じ正式名または読みを持つ複数児童は登録可能だが、resolver は `ambiguous` を返す。
- alias は全児童で一意とし、他児童の正式名、読み、alias と collision してはならない。
- inactive identity の lookup material は再利用せず、collision check に残す。

## XLSX contract

binary template を source of truth にせず、schema から生成する。

### sheets

- `児童名簿`: 編集対象。
- `入力ガイド`: 列説明と更新規則。
- `_pico_schema`: schema version と生成日時。hidden。

### columns

| column | create | update | meaning |
| --- | --- | --- | --- |
| `pico_id` | blank | required | `subjectRef` |
| `revision` | blank | required | optimistic revision |
| `姓` | required | blank keeps current | formal family name |
| `名` | required | blank keeps current | formal given name |
| `姓かな` | required | blank keeps current | family reading |
| `名かな` | required | blank keeps current | given reading |
| `あだ名` | optional | blank keeps current | newline-separated aliases |
| `状態` | required | blank keeps current | `active` or `inactive` |

一般 notes 列と未知列を許可しない。header は固定順序とし、重複、欠落、順序変更を error とする。optional field の全 alias 削除には `[[CLEAR]]` を使用する。

### workbook handling

- exact `.xlsx` extension だけを受け付ける。
- read 前に regular file と compressed size 10 MiB 以下を確認する。
- ExcelJS で workbook を load する。
- 定義済み sheet 以外を拒否する。
- editable sheet の formula、hyperlink、rich text、merged cell、hidden row/column を拒否する。
- 2,000 data rows、50,000 cells、1 cell 512 Unicode code point を上限とする。
- workbook 全体を validate してから preview を作り、partial mutation を起こさない。
- export は string を plain text cell として書き、formula-like prefix を式として設定しない。
- import/export XLSX は平文であり、通常の user file として扱う。

custom ZIP parser は作らない。ExcelJS または依存 package の archive parsing を再実装しない。将来、未信頼の外部 XLSX を自動受信する要件が生じた場合は、その ingestion boundary を独立した hardening slice として設計する。

## SQLite persistence

- default path: `${XDG_DATA_HOME:-$HOME/.local/share}/pico/identity-registry.sqlite`
- default parent directory は作成時に mode `0700` とする。
- DB、WAL、SHM は mode `0600` とする。
- plaintext identity table は `subjectRef`、revision、name fields、aliases、status、updated timestamp を持つ。
- lookup table は normalized text、subjectRef、lookup kind を持つ。
- preview table は random UUID、base registry epoch、change set、created timestamp を持つ。
- metadata は schema version、normalization version、registry epoch を持つ。
- `PRAGMA foreign_keys=ON` と transaction を使用する。
- application-level encryption、key metadata、ciphertext、nonce、authentication tag、HMAC digest を保存しない。

## preview and apply

`preview` は workbook 全体を parse・validateし、現在 registry と比較する。random preview UUID を生成し、plaintext change set と base registry epoch を SQLite に保存する。

返却 summary は preview ID、created/updated/unchanged/error count、各 changed row の row number、operation、changed field code を含む。raw identity value を persistent audit へ渡さない。ローカル CLI の validation error は operator が修正できるよう row number と field code を返す。

`apply` は preview ID と `--owner-approved` を要求する。transaction 内で registry epoch と各対象 revision を再確認し、stale なら何も変更しない。成功時は identity、lookup、epoch を更新して preview を削除する。失敗時は rollback する。

cryptographic approval code、encrypted staging、source commitment は使用しない。同一 UID 内の workflow gate を暗号認証として扱わない。

## management CLI

```text
pico roster init --owner-approved [--database absolute-path]
pico roster template --output path.xlsx
pico roster preview --input path.xlsx [--database absolute-path]
pico roster apply --preview <uuid> --owner-approved [--database absolute-path]
pico roster export --output path.xlsx --owner-approved [--database absolute-path]
pico roster add-alias --subject <subjectRef> --alias <value> --owner-approved
pico roster remove-alias --subject <subjectRef> --alias <value> --owner-approved
pico roster activate --subject <subjectRef> --owner-approved
pico roster deactivate --subject <subjectRef> --owner-approved
pico roster status [--database absolute-path]
```

CLI は agent が操作できる stable result code と bounded JSON を返す。local input path と local validation detail は cryptographic secret として扱わない。persistent audit と telemetry には raw name、reading、alias、workbook content を含めない。

## audit

registry 専用 audit table と registry 専用 audit schema は作らない。既存 `StructuredAuditLog` を使用し、mutation kind、owner approval assertion、row/change count、fixed result codeだけを記録する。

audit は registry transaction の source of truth ではない。mutation correctness は SQLite transaction、revision、registry epoch が所有する。

## error handling

- missing DB、invalid schema、permission failure は bounded error code で失敗する。
- workbook parse error は row number、field code、stable error codeを返す。
- stale revision、stale epoch、collision、ambiguous formal name は非破壊 failure とする。
- SQLite mutation は transaction failure 時に全 rollback する。
- CLI interruption が commit 前なら registry mutation を残さない。

## tests

- schema と workbook header parity。
- template generation、import、export round trip。
- create、update、alias clear、activate/deactivate、no implicit delete。
- formal name、reading、alias normalization。
- duplicate formal name ambiguity、alias collision、honorific exact-first lookup。
- stable `subjectRef` と revision。
- preview apply、owner approval rejection、stale epoch/revision、rollback。
- real SQLite persistence と `0700`/`0600` permission。
- formula、hyperlink、unexpected sheet/header、oversize、row/cell limit rejection。
- audit event に raw identity value が含まれないこと。
- keyring、encryption、custom ZIP preflight dependency が production path に存在しないこと。

test fixture は全て架空データを使用する。production code に mock、stub、fake、fallback provider を置かない。

## acceptance criteria

- schema-generated XLSX を記入し、preview、owner-approved apply できる。
- export を編集して再importしても stable `subjectRef` と revision が保たれる。
- exact resolver が正式名、読み、aliasを解決し、曖昧な場合は推測しない。
- local SQLite と XLSX が平文で動作し、owner-only permission を持つ。
- application encryption、native keyring、custom ZIP parser が実装・依存関係に残らない。
- focused tests、`just check`、変更ファイルを対象にした secretlint が完了する。

## PR scope review

PR 作成前に、引き継いだ全ファイルを責務、参照、test value の観点で再確認する。crypto、keyring、lifecycle、ZIP preflight、registry-specific audit のためだけに存在する source、test、script、dependency、tool note は削除する。簡素化後も責務が残る file は、必要な API と test だけを保持する。
