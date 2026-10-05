# ページと実装

閲覧と編集は同じ画面を使用します。

| URL | 操作 |
| --- | --- |
| `/` | 月間／2週間カレンダー、選択日の詳細と最近の編集履歴を閲覧 |
| `/?edit=1` | PIN認証後にコマの見出し・内容をダイアログで編集、備考を編集 |
| `/base.example.json` | 時間割JSONの雛形 |
| `/.netlify/functions/planner` | 予定・設定・履歴の取得、PIN検証、保存 |

`public/index.html`、`style.css`、`app.mjs` が画面、`public/model.mjs` が共通検証、`netlify/functions/planner.mjs` がAPIです。設計判断とデータ形式の正本は `DESIGN.md`、公開手順は `README.md` です。

後回しにする同時更新の検証は `docs/concurrency-issue.md` に記録しています。

`public/nourin-base.json` は農林カレンダーの2026年10月・野菜／有機コースA班の取込データです。
