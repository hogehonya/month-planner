# 月ごとの共有プランナー設計

利用者が提示した共有プランナー設計を基礎とし、月単位の表示とJSON時間割の追加指示を反映する。少人数がスマートフォンとPCから同じ予定を見る用途である。

## 画面と操作

初期表示は端末の今月の1日から末日。前月・今月・翌月を選べる。日付、1コマ目、2コマ目、備考の表を表示し、600 CSS px以下では日別カードを縦に並べ、各欄にコマ名・時間を表示する。PCでは表を維持し、長文やフォームは画面内に収める。今日・土日を強調する。IBM Plex Sans JPを用い、明暗テーマはOS設定へ追従する。

通常URLは閲覧専用。`?edit=1` で編集者名とPINを入力し、認証成功後に編集する。PINはページのメモリ内だけで保持し、URL、HTML、ソース、ブラウザストレージには保存しない。初期PINの値はユーザー指定をNetlifyの環境変数 `EDIT_PIN` に設定し、本書にも記録しない。

保存はセルごとに500msのデバウンス。同一セルの送信を直列化し、新しい入力を古い応答で上書きしない。3秒ごとの同期でもフォーカス中・未保存・送信中のセルを上書きしない。日本語変換中は送信しない。保存失敗時は入力を保持して再試行操作を出す。未保存でページを離れる場合はブラウザの確認を出す。オフライン編集・ローカル永続保存は実装しない。

## 構成

Vanilla HTML/CSS/JavaScript、Netlify Functions、Netlify Blobsだけで構成する。フロントは `public/`、APIは `netlify/functions/planner.mjs`。共有の入力検証・日付処理は `public/model.mjs`。外部DB、アカウント、通知、ロールバック、バックアップ、月以外の表示は対象外。

## JSON時間割

編集モードの時間割設定からJSONを貼り付け、またはファイルで読み込み、内容を確認して共有設定へ反映する。雛形は `public/base.example.json`。

- `slots`: 2要素の配列。各要素に `label`（1〜20文字）と `time`（省略可、40文字まで）を指定する。
- `weekdays`: `sun`, `mon`, `tue`, `wed`, `thu`, `fri`, `sat` をキーとし、各曜日の `slot1`, `slot2`, `note` を指定する。省略可能。
- `dates`: `YYYY-MM-DD` をキーとする例外設定。各日で `slot1`, `slot2`, `note` を指定する。省略可能。最大366日。
- コマは1200文字、備考は3000文字まで。未知のキー、不正な日付、配列・型の誤りは拒否する。

セルの優先順位は **個別編集 > 日付例外 > 曜日設定 > 空欄**。明示的な空文字も個別編集として保持する。時間割の変更は個別編集を上書きしない。設定全体の同時更新はETag不一致で409を返し、再読込を促す。

## 保存形式と整合性

サイト単位の `shared-planner` ストアをstrong consistencyで使用する。再デプロイで予定を失わない。

- `entries/YYYY-MM-DD.json`: 日付、個別編集されたフィールドだけ、最終編集者、更新日時。
- `settings/base.json`: 時間割、最終編集者、更新日時。
- `history/{timestamp}-{uuid}.json`: 変更日、編集者、フィールド、日時だけ。変更前後の本文は保存しない。

未編集セルと明示的な空欄を区別するため、日別Blobには未編集フィールドを格納しない。GETでは時間割と合成した3フィールドを返す。

更新は最新のBlobとETagを読み、対象フィールドだけを適用して `onlyIfMatch`（新規は `onlyIfNew`）で書く。競合時は再読込して最大6回試行する。同一セルは最後に正常保存された値を採用する。成功判定はSDKの `modified` を確認する。

予定と履歴の別Blob間にはトランザクションがないため、予定の条件付き書き込みに未転記の履歴メタデータ `_pending_history` を含める。履歴Blobへ転記後にETag付きで除く。転記失敗時もメタデータは予定に残り、GETで履歴に含め、次回処理で再転記する。本文の履歴は保持しない。

## API

エンドポイントは `/.netlify/functions/planner`。全応答に `Cache-Control: no-store`。GETは認証不要、POSTはJSONとPINを要求する。

- GET `?start=YYYY-MM-DD&end=YYYY-MM-DD`: 最大31日。合成済み `entries`、最近30件の `history`、`base`、`base_etag` を返す。
- POST `action=verify`: PINを確認し `ok` を返す。
- POST `action=save`: `editor_name`, `entry_date`, `field`, `value` を検証してセルを保存。
- POST `action=base`: `editor_name`, `base`, `expected_etag` を検証して時間割を更新。

編集者名は空白のみ不可・40文字以内。PINはSHA-256で固定長にして `timingSafeEqual` で比較する。不一致は約300ms待って401。未設定は編集を503で拒否する。JSON入力は256KiBまで。エラーに秘密値・内部例外を含めない。同一origin以外からのPOSTを拒否する。

## 検証と公開

Node.jsの標準テストで月境界、入力検証、JSON優先順位、PIN、同時更新、履歴転記失敗、設定競合を検証する。ブラウザでは閲覧専用、認証、保存、別セッション同期、入力中保護、JSON取り込み、モバイル・明暗テーマを確認する。

GitHubは `hogehonya/month-planner`。Netlifyは `public` を公開しFunctionsをバンドルする。`EDIT_PIN` はFunctionsスコープの環境変数で設定し、公開資産へ含めない。

参考: [Netlify Blobs API](https://docs.netlify.com/build/data-and-storage/netlify-blobs/)。履歴一覧は少人数での低頻度更新を前提とする。将来履歴数が増えた場合は索引や保持期間を別途検討する。
