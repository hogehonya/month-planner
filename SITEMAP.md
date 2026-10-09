# ページと実装

閲覧と編集は同じ画面を使用します。

| URL | 操作 |
| --- | --- |
| `/` | 月間カレンダーとスマートフォンの週選択、選択日の詳細・コメントと最近の編集履歴を閲覧 |
| `/#help` / `/?edit=1#help` | SPA内の取説を表示。編集状態を保持してカレンダーへ戻る |
| `/?edit=1` | PIN認証後にコマの見出し・内容をダイアログで編集、備考を編集、選択日のコメントを追加、午前・午後の写真を添付・差替え、追加予定JSONを検証・プレビューして取込 |
| `/entries.example.json` | 追加予定JSONの雛形 |
| `/base.example.json` | 基本予定JSONの雛形 |
| `/.netlify/functions/planner` | 予定・設定・履歴の取得、PIN検証、保存、写真アップロード・公開画像取得 |

`public/index.html`、`style.css`、`app.mjs` が画面、`public/help.mjs` が取説ビューの切替、`public/font-size.mjs` が文字サイズ設定、`public/model.mjs` が共通検証、`netlify/functions/planner.mjs` がAPIです。設計判断とデータ形式の正本は `DESIGN.md`、公開手順は `README.md` です。

後回しにする同時更新の検証は `docs/concurrency-issue.md` に記録しています。

- `/packaging.html`: 販売準備表・荷姿写真マスタ（`packaging.mjs`、`menu-sheet.mjs`、`packaging-model.mjs`、`packaging.css`）。`/.netlify/functions/packaging` で日付別販売準備表・共通SKU・写真を読み書き。

- `/packaging.html#sku=品目ID%2FSKU_ID`: 販売準備表の独立詳細ビュー。同じフォームの入力を保持し、一覧へ戻る／ブラウザ履歴で復帰。

SKU詳細の共有コメントは `public/sku-comments.mjs` が表示・追記・再試行・未送信入力の保護を担当します。包装APIの選択日・品目・SKU専用取得と投稿を使用し、販売準備表・写真とは独立して保存します。

- `local-runtime/server.mjs`: LAN配置用の静的配信・既存API接続・`/healthz`。
- `local-runtime/healthcheck.mjs`: Docker・Compose・CI共通のHTTP healthcheck。正規Host・応答・revisionを検証。
- `test/local-healthcheck.test.mjs`: 別プロセスから実HTTPサーバーへのhealthcheck回帰テスト。
- `local-runtime/store.mjs`: 独立した永続ディスクストア。運用条件は `local-runtime/README.md`。
- `Dockerfile`: 非rootのLANコンテナ。`/app/data` を永続化。
- `docs/local-deployment.md`: LAN版のCI・デプロイ運用。
- `.woodpecker.yml`: テスト・commit SHA付きコンテナビルド・mainのLANデプロイ。
- `docker-compose.yml`: LAN版コンテナ・永続領域・Traefik接続・healthcheck。
- `config.env.example`: LAN版の非機密設定。APP_REVISIONはCIが追記。
- `ops/README.md`: ホスト運用設定の索引。
- `ops/month-planner-secrets-only.conf`: Infisicalの秘密値準備だけを行うsystemd override。

- `public/online-sync.mjs`: LAN版だけの同期ボタン、実値差分プレビュー・置き換え確認。
- `local-runtime/online-sync.mjs`: 固定オンラインoriginからの取得検証・差分token・ローカル保存世代切替。
- `netlify/lib/packaging-export.mjs`: 包装APIの読み取り用export補助。
- `test/online-sync-ui.test.mjs`: 同期の表示・差分・入力保護・確認・再試行の回帰テスト。

Issue #82: `public/packaging.css` のカード表示と `public/menu-sheet.mjs` の補助操作領域で、情報階層と数量・操作の区切りを実装。
