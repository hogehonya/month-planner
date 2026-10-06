# ページと実装

閲覧と編集は同じ画面を使用します。

| URL | 操作 |
| --- | --- |
| `/` | 月間／2週間カレンダー、選択日の詳細・コメントと最近の編集履歴を閲覧 |
| `/#help` / `/?edit=1#help` | SPA内の取説を表示。編集状態を保持してカレンダーへ戻る |
| `/?edit=1` | PIN認証後にコマの見出し・内容をダイアログで編集、備考を編集、選択日のコメントを追加、追加予定JSONを検証・プレビューして取込 |
| `/entries.example.json` | 追加予定JSONの雛形 |
| `/base.example.json` | 時間割JSONの雛形 |
| `/.netlify/functions/planner` | 予定・設定・履歴の取得、PIN検証、保存 |

`public/index.html`、`style.css`、`app.mjs` が画面、`public/help.mjs` が取説ビューの切替、`public/font-size.mjs` が文字サイズ設定、`public/model.mjs` が共通検証、`netlify/functions/planner.mjs` がAPIです。設計判断とデータ形式の正本は `DESIGN.md`、公開手順は `README.md` です。

後回しにする同時更新の検証は `docs/concurrency-issue.md` に記録しています。

`public/nourin-base.json` は農林カレンダーの2026年10月・野菜／有機コースA班の取込データです。
