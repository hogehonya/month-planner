# LAN版のデプロイ

本番運用の構成です。GitHub `hogehonya/month-planner` をソースの正本とし、Gitea `honya-dev-web-app-month-planner/app` は10分間隔のpull mirrorとして利用します。変更はGitHubのPRへ集約し、ミラーへ直接コミットしません。実行・保存の仕様は[LAN実行環境](../local-runtime/README.md)を参照してください。

## 配置と更新

WoodpeckerはNode.js 24で`npm ci`、`npm test`、`npm run check`を実行します。mainへのpushまたはmainのmanual実行だけが、commit SHAをタグとするイメージをGitea RegistryへpushしてLAN版を更新します。ミラーされたブランチのpushでは検証を実行します。GitHubのPRとPRイベントはpull mirrorの対象ではなく、GitHub PRのチェックとは直接連携しません。Registryの認証は既存のglobal secret `gitea_username`、`gitea_token`を使い、トークンを標準入力で渡します。

CIリポジトリにはtrusted volumeの許可が必要です。Docker socket、`/home/honya/month-planner`、読み取り専用の`/run/infisical/month-planner`をdeploy stepへ渡します。Docker socketを利用するため、CI設定変更は管理者がレビューします。

CIはcomposeと非機密設定を`/home/honya/month-planner`へコピーし、`APP_REVISION`へ対象SHAを記録します。秘密値は`--env-file /run/infisical/month-planner/secrets.env`からのみ注入します。展開済みの`docker compose config`やコンテナ環境をログへ出力しません。pull後に`up -d --wait`を実行し、コンテナ内から`/healthz`のrevisionと対象SHAの一致を確認します。

`month-planner`コンテナはUID/GID 1000で実行します。永続領域`/mnt/8TBHDD/SERVICES/month-planner`を同じ所有者で事前作成し、`/app/data`へ接続します。root filesystemは読み取り専用、`/tmp`はtmpfsです。外部Docker network `traefik`とTraefikの`internal` entrypointを使い、NPMのワイルドカードHTTPSからNASの8088番を経由して接続します。Host `month-planner.honya.dev`を内部3000番へ転送します。ホストの公開ポートは割り当てません。DNS、TLS終端、LAN限定のアクセス境界はホスト側で管理します。

この配置は空の独立データで開始します。オンラインからの取得は、LAN画面で差分を確認して置き換えを確定した場合だけ行います。Netlify側へ書き込みません。同じイメージへの再デプロイでも永続領域を維持します。一つのデータ領域で動かすプロセスは一つだけです。

## 秘密値の準備と更新

Infisical Machine Identity `mi-svc-month-planner`（credential prefix: `month-planner`）には必要な`EDIT_PIN`だけの読み取り権限を与えます。既存の`docker-compose-infisical@.service`と承認済みrendererを利用し、リポジトリや通常のconfigへPINを保存しません。

[専用override](../ops/month-planner-secrets-only.conf)を`/etc/systemd/system/docker-compose-infisical@month-planner.service.d/override.conf`へ配置します。親templateの`RuntimeDirectory=infisical/%i`と`ExecStopPost`による秘密ファイル破棄を維持し、開始時はrenderだけを実行します。`Type=oneshot`と`RemainAfterExit=yes`によりruntime directoryを保持します。サービスの開始・停止ではcomposeを実行しません。アプリケーション更新はCIだけが担当します。

ホスト側でdaemon-reload後にこのインスタンスをenable/startし、`/run/infisical/month-planner/secrets.env`の存在・権限を値を表示せずに確認します。起動後の初回デプロイはmainのCIから実行します。PINを変更する際は実行中のCIと重ならないことを確認してからInfisicalを更新し、secretサービスをrestartした後にmainのCIを再実行して、コンテナへ反映します。秘密ディレクトリ全体をCIへ読み取り専用マウントするため、再生成されたファイルも次のdeploy stepで参照できます。secretサービスの停止は既存コンテナを停止しませんが、秘密ファイルを破棄するため次回のCIデプロイは失敗します。

## Netlifyとの版合わせとロールバック

この手順ではNetlifyの自動Git連携を前提にしません。Netlify版は公式のデプロイ経路から同じcommitを手動公開し、公開済みrevisionを別途確認します。LAN版CIはNetlifyへデプロイしません。

ロールバックもCI経由とし、以前成功したmainのcommitのpipelineを再実行して、そのSHAのイメージと設定を適用します。イメージタグに`latest`は使いません。手動のcompose更新やボリューム削除、イメージpruneは行いません。コードを戻してもデータは戻らないため、保存形式が変わる変更では互換性を確認します。データ復元はプロセス停止中に取得したバックアップを使う独立工程です。


## 手動同期の配備設定

`config.env.example`の`ONLINE_SOURCE_ORIGIN`をCompose環境へ渡して、LAN版の「オンラインと同期」を有効にします。同期元は`https://month-planner-13f9a0.netlify.app`です。オンライン版にも同じ版の読み取り用export実装を先に公開してください。未対応のオンライン版や取得失敗ではプレビューが失敗し、ローカルの現行データを置き換えません。

配備やCIはデータ同期を実行しません。利用者が差分を確認し、「オンラインの内容で置き換える」を押して確定します。オンライン→ローカルの一方向で、カレンダーは独立したままです。旧世代と未採用世代を保持するため、バックアップ対象はDATA_DIR全体です。詳細な保存・取得制限は[LAN実行環境](../local-runtime/README.md#販売準備表の手動同期)を参照してください。
