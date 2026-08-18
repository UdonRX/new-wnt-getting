# Personal Dashboard V2.3.0 改善内容

## 置き換え方

GitHubのリポジトリを丸ごと更新できる場合は、V2.3.0完全版の中身で置き換えるのが確実です。
変更ファイルだけ反映する場合は、changed-only ZIPを上書きしたうえで次を削除してください。

- `src/styles/liquid-glass.css`

新規追加ファイル:

- `src/styles/navigation.css`
- `src/features/weather/weather-icons.js`
- `src/features/twitter/image-viewer.js`

## 重要な修正

### Reader 500 / FUNCTION_INVOCATION_FAILED

`jsdom 27.4.0` から `26.1.0` へ戻しました。jsdom 27にはNode 22のLambda環境で実行時ファイルを見つけられず落ちる回帰報告があり、V2.2系のnews/papers/summaryはいずれもjsdomを読み込む経路を持っていました。

Geminiの構造化出力指定も `responseMimeType: application/json` + `responseSchema` へ変更しています。

### YouTube

- Channel ID取得エラーをクライアントで握りつぶさず表示。
- 正規Channel ID (`UC` + 22文字) はYouTube Data APIが使えない場合でも公開Atom feedへフォールバック。
- APIが使える場合はuploads playlist -> playlistItems -> videosの公式API経路を優先。
- APIで動画時間が取得できる場合、180秒以下をShortsとして分類。

### Twitch

- iPhone幅400px未満で自動的に90度回転させる処理を削除。
- LIVE/VODをタップするとTwitch画面上部へインラインプレイヤーを表示。
- 前へ / 次へ / 横画面 / Twitchで開くを配置。
- 画面移動時にプレイヤーとチャット接続をクリーンアップ。
- コメントはTwitch Embedを覆わず、動画直下の専用レーンに表示。

### Twitter / X

- ツイート本文はリンクにしない。
- 外部URLだけを明示的な外部リンクとして表示。
- 画像タップでアプリ内ビューアを開く。
- ピンチズーム(1〜5倍)、拡大時パン、1倍時の左右スワイプで複数画像切替。
- RSSHubが空/エラーの間は5秒ごとに自動再試行。
- Twitter向け `/api/rss` は4.5秒で1回の取得を打ち切り、次の5秒周期へ進める。

### Design

- Liquid Glassを完全廃止。
- pure black / pure whiteを避け、暗い青みグレーを段階的に使用。
- レイヤーの高さを影ではなく背景明度で表現。
- 下部ナビはフローティングカプセルではなく、画面下部へ一体化したソリッドバー。
- 天気絵文字を単色線SVGへ変更。

## Vercel

API Function数は11/12のままです。新しいServerless Functionは追加していません。

`jsdom 26.1.0` に戻すため `whatwg-encoding@3.1.1 deprecated` のnpm警告が再表示される可能性がありますが、これはwarningです。V2.2.2で解消した12 Functions上限とは別です。
