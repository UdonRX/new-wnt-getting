# V2.2.2 - Vercel Hobby Function上限修正

## 原因

V2.2.1 の `api/` 直下には 13 個の Serverless Function がありました。
Vercel Hobby は 1 Deployment あたり 12 Functions までのため、デプロイが停止していました。

## 修正

機能は削除していません。

1. Gemini接続確認を `api/rank-items.mjs` に統合
   - 新URL: `/api/rank-items?mode=gemini-check&live=1`
2. ブラウザ公開設定を `api/twitch-feed.mjs` に統合
   - 新URL: `/api/twitch-feed?mode=config`
3. `api/gemini-check.mjs` と `api/public-config.mjs` を削除

結果: **13 → 11 Functions**

## なぜ12ではなく11まで減らしたか

今後APIを1つ追加してもすぐ上限に当たらないよう、1枠の余裕を確保するためです。

## 確認

```bash
npm run check:functions
npm run check
```
