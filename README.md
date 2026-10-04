# 2週間共有プランナー — Netlify版

今後14日分を「1コマ目 / 2コマ目 / 備考」で共有する小規模プランナーです。

- 通常URLは閲覧専用
- `?edit=1` で編集モード
- 編集PINはNetlify Environment Variableで保持
- 編集者名・最近30件の履歴
- 約3秒ごとの自動同期
- Netlify Blobsへの保存
- ETag条件付き書き込みによる競合対策
- スマホ対応 / 印刷・PDF対応

## Deploy

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/hogehonya/month-planner#EDIT_PIN=)

デプロイ時に `EDIT_PIN` を設定してください。PIN値はGitHubリポジトリには保存しません。

`netlify.toml` により以下を使用します。

- Build command: なし
- Publish directory: `public`
- Functions directory: `netlify/functions`

## 公開後

閲覧用:

```text
https://<site>.netlify.app/
```

編集用:

```text
https://<site>.netlify.app/?edit=1
```

## 構成

```text
public/index.html
netlify/functions/planner.mjs
netlify.toml
package.json
DESIGN.md
```

データ保存はNetlify Blobsを使用するため、Supabase等の外部DBは不要です。

## セキュリティ

PINはHTMLやJavaScriptには埋めず、Netlify Function内で `process.env.EDIT_PIN` と比較します。

短いPINは身内向けの簡易ロックです。公開範囲が広い用途ではログイン認証への変更を推奨します。

## ローカル確認

```bash
npm install
netlify dev
```

詳細設計は [DESIGN.md](./DESIGN.md) を参照してください。
