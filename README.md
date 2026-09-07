# Personal Dashboard

iPhone Safari / PWA を主対象にした個人ダッシュボードです。`main` が本番ブランチで、Vercel Git Integration により `main` への反映が本番デプロイになります。

- Repository: https://github.com/UdonRX/new-wnt-getting
- Production: https://new-wnt-getting.vercel.app/
- Current baseline: v2.21.0

## 現行アーキテクチャ

### Browser / PWA

```text
index.html
├─ src/styles/
│  ├─ tokens.css / base.css / navigation.css
│  ├─ screens.css / app.css / motion.css
│  ├─ active-overrides.css
│  ├─ fullscreen-cleanup.css
│  └─ weather-detail.css
├─ src/features/twitch/twitch-sync.js
└─ src/bootstrap.js
   ├─ 起動時に必要な現行補助モジュール
   └─ src/main.js
      ├─ src/runtime.js
      ├─ src/app/*
      └─ src/features/* を画面単位で遅延読込
```

`sw.js` が PWA の App Shell とキャッシュを管理します。

### 固定ファイル方針

バージョンごとの差分ファイルを積み重ねる方式は廃止しました。

- Browser runtime: `src/runtime.js`
- Browser bootstrap: `src/bootstrap.js`
- UI override CSS: `src/styles/active-overrides.css`
- Summary stream: `lib/summary-stream.mjs`
- Summary dispatch: `lib/summary-dispatch.mjs`

今後の修正では上記の既存ファイルを直接更新します。`runtime-vXXXX.js`、`vXXXX.css`、`bootstrap-vXXXX*.js`、`summary-vXXXX.mjs` のようなバージョン名付き実装ファイルを新しく作成しません。

URLのキャッシュ破棄用 `?v=...` や localStorage の移行キー、診断レスポンス中の旧version文字列は、ファイルを増やす仕組みではないため必要に応じて維持できます。ただし実装ファイル名にはversion番号を使いません。

### API

```text
vercel.json
└─ api/
   ├─ ai.mjs
   ├─ research.mjs
   ├─ feeds.mjs
   └─ youtube.mjs
        ↓
      server/
        ↓
      lib/
```

`api/` 直下は Vercel Function の入口だけです。処理本体は `server/`、共通処理は `lib/` に置きます。Function はプロジェクト運用ルールとして最大4個を維持します。詳細は `VERCEL_HOBBY.md` を参照してください。

## ディレクトリの役割

- `api/`: 4つの Vercel Function router
- `server/`: API route の実処理
- `lib/`: サーバー側の共通処理、Gemini、記事解析、RSS処理
- `src/app/`: Router / Store / Home共通UI
- `src/features/`: Home、Weather、Reader、Media、SNS、Wikipedia、Settings等の機能単位コード
- `src/shared/`: クライアント共通処理
- `src/styles/`: 現行UIのCSS
- `shared/`: クライアント・サーバーで共有する定義
- `scripts/`: 構文、Function数、Reader、要約、おすすめ等の回帰チェック
- `icons/`, `manifest.webmanifest`, `sw.js`: PWA資産

## 今後の修正・デプロイルール

1. 必ず作業開始時に最新 `main` を確認する。
2. 既存の正規ファイルを修正し、`-vXXXX`、`*_FIX`、`ALL_CODE.txt`、`FILE_TREE.txt` のような版別コピーや一時スナップショットを増やさない。
3. 特に `runtime-vXXXX.js` / `vXXXX.css` / `bootstrap-vXXXX*.js` / `summary-vXXXX.mjs` は作らず、固定名ファイルを更新する。
4. 実装を置き換えた場合、旧実装・旧UI・旧CSSは参照が無いことを確認し、同じコミットで削除する。
5. `index.html`、`sw.js`、import、`vercel.json`、回帰テストの参照を同時に確認する。
6. 可能な作業環境では反映前に `npm run check` を実行する。
7. 1つの改善依頼は、調査・修正・テストをまとめて **mainへ1コミット**で反映する。
8. main反映後は GitHub の `Vercel` commit status が `success` になることを確認する。
9. Vercelのbuild/deploy rate limit中は追加の「再試行用コミット」を作らない。
10. 通常はGit連携に任せ、不要な手動Production Deployを追加しない。

## 回帰チェック

```bash
npm run check
npm run check:syntax
npm run check:functions
npm run check:hobby
```

`npm run check` は構文、Vercel Function構成、AI要約、Reader flow、prefetch、おすすめ選定の主要チェックをまとめて実行します。

## 構成を増やすときの原則

- 新APIは原則として既存4 routerのどれかへrouteを追加する。
- 新しいUI改善は既存featureへ統合し、バージョン別ファイルを横に増やさない。
- 複数の後付けoverrideが同じ役割になった場合は、次の改善時に既存の固定ファイルへ統合する。
- 診断コードは恒久的に必要なら既存のdebug/diagnostic導線へ統合し、一時診断ファイルを残さない。
- Home表示を外部API待ちで止めない。キャッシュ即表示・バックグラウンド更新を維持する。
- iPhone Safari / PWAを最優先し、不要な大型依存を追加しない。

## ドキュメント

- `VERCEL_HOBBY.md`: Hobby制限とデプロイ運用ルール
- `PAPER_CREATIVE_KEYWORDS.md`: 独創研究の検索キーワード・選定方針

Secrets / API keys はリポジトリへ保存せず、Vercel Environment Variables で管理します。
