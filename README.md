# 2週間共有プランナー — Netlify版

このフォルダをGitHubリポジトリに入れてNetlifyへImportすれば、
**Supabaseなし・Netlifyだけ**で動きます。

## 機能

- 今日から14日
- 各日「1コマ目 / 2コマ目 / 備考」
- 通常URLは閲覧専用
- `?edit=1` で編集モード
- 編集PIN
- 編集者名と最近30件の編集履歴
- 約3秒ごとに他端末の変更を自動反映
- 同時編集対策（ETag条件付き書き込み + 再試行）
- スマホ対応
- 印刷 / PDF

## 保存先

Netlify Blobsを使います。

DBやSupabaseの契約は不要です。

---

# デプロイ直前までの準備

このリポジトリをGitHubへpushしたら、Netlifyで:

1. `Add new project`
2. `Import an existing project`
3. GitHubを選ぶ
4. このリポジトリを選ぶ

`netlify.toml` があるので通常は設定を自動認識します。

- Build command: なし
- Publish directory: `public`
- Functions directory: `netlify/functions`

## 必須: PINをEnvironment variableへ設定

**Deployする前に** NetlifyのEnvironment variablesへ追加:

- Key: `EDIT_PIN`
- Value: `0831`

PINはソースコードには入れていません。

Netlify UIのEnvironment variablesはFunctionsの実行時に利用できます。
`netlify.toml` に秘密値を書かないでください。

---

# 公開後

通常URL:

`https://xxxx.netlify.app/`

→ 閲覧専用

編集URL:

`https://xxxx.netlify.app/?edit=1`

→ 編集者名 + PIN `0831` で編集

画面上の「閲覧URLをコピー」「編集URLをコピー」から共有できます。

---

# 同期について

Supabase Realtimeのようなpush配信ではなく、約3秒ごとに自動取得します。

この予定表用途では操作感はほぼリアルタイムです。
入力中のセルは自動同期で上書きしません。

---

# 同時編集

各日をNetlify Blobに保存します。

保存時は:

1. 最新データ + ETagを取得
2. 編集したセルだけ反映
3. `onlyIfMatch` で条件付き保存
4. 同時更新されていたら最新値を再取得して再試行

という流れです。

別の人が同じ日の別セルを触っても、古い1日分データで
他人の変更を消しにくい構成です。

同じセルを同時に編集した場合は、最後に正常保存された値が残ります。

---

# PINについて

`0831` は身内利用向けの簡易ロックです。

PINはHTMLやJavaScriptには埋めず、Netlify Function内で
Environment variableと比較します。

ただし4桁PINなので強い認証ではありません。
公開範囲が広がる場合はログイン認証への変更を推奨します。

---

# ローカル確認（任意）

Netlify CLIがある場合:

```bash
npm install
netlify dev
```

ローカル用の環境変数を適切に設定して確認してください。

通常の公開はGitHub → Netlify Importだけで構いません。
