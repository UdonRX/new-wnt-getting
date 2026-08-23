# Vercel Hobby 運用ルール

このプロジェクトは Vercel Hobby 前提で運用する。

## デプロイ方針

- 1つの改善依頼に対して、Production へ反映する Git push / Vercel deployment は原則1回にまとめる。
- main へ試行錯誤の小分けコミットを連続で送らない。調査・修正・テストをまとめてから1つのコミットにする。
- デプロイが rate limit で失敗している間は、追加の再試行コミットを作らない。制限解除後は最新コミットを1回だけ Redeploy する。
- 実装前後に `npm run check` を実行する。

## API Function 構成

Hobby の Vercel Function 上限と build rate を守るため、`api/` 直下の Function は最大4個をプロジェクト内ルールとする。

- `api/ai.mjs`: summary / chat / rank-items / paper-titles
- `api/research.mjs`: papers / creative papers / Wikipedia
- `api/feeds.mjs`: news / RSS proxy / Twitch
- `api/youtube.mjs`: YouTube（native canvas を他bundleから分離）

各エンドポイントの実装本体は `server/` に置き、`vercel.json` の rewrite で上記4 Functionへ振り分ける。
新しいAPIを追加するときは、原則として新しい `api/*.mjs` を増やさず既存routerへ追加する。

## Hobbyで特に監視する値

2026-08時点のVercel公式ドキュメントを基準にする。値は変更される可能性があるため、大きな構成変更時は公式ドキュメントを再確認する。

- Vercel Functions: 12 / deployment（直接Functionsを使う構成）
- Builds: 32 / hour
- Deployments: 100 / day
- Concurrent builds: 1
- Function bundle: 250 MB gzip後
- Active CPU: 4 CPU-hours included
- Provisioned Memory: 360 GB-hours included
- Function Invocations: 1,000,000 included
- Edge Requests: 1,000,000 / month included
- Fast Data Transfer: 100 GB / month included
- Runtime Logs retention: 1 hour
- Cron: Hobbyでは1日に1回を超えるスケジュールを設定しない

## 実装上の注意

- `pdf.worker.mjs` の `includeFiles` はAI Functionだけに限定する。`api/*.mjs` 全体へ付けない。
- RSS/ニュース/YouTubeなど更新頻度を許容できるGET APIはCDNキャッシュを利用し、不要なFunction Invocationと外部API呼び出しを減らす。
- Gemini要約はarticleId単位で重複実行を抑止し、表示中1件 + 次1件prefetchを上限とする。
- PDF/HTML解析はCPU負荷が高いため、RSS本文が十分な場合はリンク先の再解析を避ける。
- 新しい定期ポーリングやcronを追加する場合は、Vercel UsageのActive CPU / Provisioned Memory / Invocationsへの影響を先に確認する。
