# 2週間共有プランナー 設計ドキュメント

## 1. 目的

今後14日間について、各日ごとに以下を複数人で共有・編集する。

- 1コマ目
- 2コマ目
- 備考

Google Calendar等よりも単純な、少人数向けの共有予定表を目的とする。

## 2. 構成

```text
Browser
  │
  ├─ public/index.html
  │    - 14日分表示
  │    - 閲覧 / 編集UI
  │    - 3秒ごとの同期
  │
  ▼
Netlify Function
  netlify/functions/planner.mjs
  │
  ├─ PIN検証
  ├─ 予定取得
  ├─ 予定保存
  ├─ 編集履歴保存
  └─ 競合制御
  │
  ▼
Netlify Blobs
  ├─ entries/YYYY-MM-DD.json
  └─ history/{timestamp}-{uuid}.json
```

外部DBやSupabaseは使わず、Netlifyだけで完結する。

## 3. URL

閲覧用:

```text
https://<site>.netlify.app/
```

編集用:

```text
https://<site>.netlify.app/?edit=1
```

PINはURLに含めない。

## 4. 編集認証

編集時のみPINを要求する。

初期PINは `0831`。

PINはソースコードには保存せず、Netlify Environment Variableとして設定する。

```text
EDIT_PIN=0831
```

Function側で `process.env.EDIT_PIN` を読み、`crypto.timingSafeEqual()` で比較する。

4桁PINは身内利用向けの簡易ロックであり、強い認証用途ではない。

## 5. データ構造

### 予定

Blob key:

```text
entries/2026-10-05.json
```

```json
{
  "entry_date": "2026-10-05",
  "slot1": "午前作業",
  "slot2": "午後作業",
  "note": "雨天時変更",
  "last_editor": "新添",
  "updated_at": "2026-10-05T03:20:00.000Z"
}
```

### 編集履歴

```json
{
  "id": "timestamp-uuid",
  "entry_date": "2026-10-05",
  "editor_name": "新添",
  "field_name": "slot1",
  "changed_at": "2026-10-05T03:20:00.000Z"
}
```

履歴には本文の旧値・新値は保存しない。

## 6. API

エンドポイント:

```text
/.netlify/functions/planner
```

### GET

```text
GET /.netlify/functions/planner?start=2026-10-05&end=2026-10-18
```

レスポンス:

```json
{
  "entries": [],
  "history": []
}
```

### PIN確認

```json
{
  "action": "verify",
  "pin": "0831"
}
```

### 保存

```json
{
  "action": "save",
  "pin": "0831",
  "editor_name": "新添",
  "entry_date": "2026-10-05",
  "field": "slot1",
  "value": "午前作業"
}
```

更新可能なfieldは以下のみ。

- `slot1`
- `slot2`
- `note`

## 7. 同期

WebSocketは使わず、3秒ごとにGETする。

理由:

- 少人数利用
- 更新頻度が低い
- 数秒の反映遅延で問題ない
- 構成を単純に保てる

入力中のtextareaは自動同期で上書きしない。

## 8. 競合制御

Netlify BlobsのETag条件付き書き込みを使う。

更新時:

1. 最新BlobとETagを取得
2. 編集されたセルだけ変更
3. `onlyIfMatch` で保存
4. 競合した場合は最新データを再取得
5. 対象セルだけ再適用して再試行

新規作成時は `onlyIfNew` を使う。

最大6回まで再試行する。

別ユーザーが同じ日の別セルを編集した場合、古い1日分JSONで相手の変更を消しにくい。

同じセルを同時編集した場合は最後に正常保存された値を採用する。

## 9. UI

表示列:

```text
日付 | 1コマ目 | 2コマ目 | 備考
```

- 今日を強調
- 土日を別背景
- 通常URLではreadonly
- 編集URLではPIN認証後に編集可能
- 最終編集者・更新時刻を表示
- 最近30件の履歴を折りたたみ表示
- スマートフォン対応
- 印刷 / PDF対応

## 10. 保存タイミング

入力ごとに即送信せず500msのデバウンスを入れる。

目的:

- Function呼び出し削減
- Blob書き込み削減
- タイピング途中の過剰保存防止

## 11. 入力制限

- 編集者名: 40文字
- 1コマ目: 1200文字
- 2コマ目: 1200文字
- 備考: 3000文字

Function側で検証する。

## 12. Netlify設定

`netlify.toml`:

```toml
[build]
  publish = "public"
  functions = "netlify/functions"

[functions]
  node_bundler = "esbuild"
```

Build commandは不要。

必須Environment Variable:

```text
EDIT_PIN=0831
```

## 13. 非対象

初期版では以下は実装しない。

- ユーザーアカウント
- 強い認証
- 権限ロール
- 月表示
- 通知
- Google Calendar連携
- 過去値ロールバック
- WebSocket共同編集

## 14. 完成条件

- Netlifyで公開できる
- 通常URLで閲覧できる
- `?edit=1` で編集モードに入れる
- PIN `0831` で編集できる
- データがNetlify Blobsに保存される
- 他端末へ数秒以内に反映される
- 編集者名と履歴が確認できる
- スマートフォンから利用できる
