# Functionsの共通処理

`packaging-export.mjs` は販売準備データの読み取り専用exportと、ローカル同期で共有するmanifest検証を担当します。SKU・日付別シート・全SKUコメント・参照中の写真メタデータを扱い、キー・参照整合・型・容量を検証します。写真の実データは既存の写真GETで取得します。Netlifyの独立したFunctionとして公開しないため、`functions` ディレクトリの外に配置しています。
