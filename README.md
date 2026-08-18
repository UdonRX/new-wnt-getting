# Personal Dashboard V2.2.2

> V2.2.2: Vercel Hobby の「1 Deployment 最大12 Functions」へ対応。`gemini-check` を `rank-items`、`public-config` を `twitch-feed` に統合し、Serverless Functions を13個→11個へ削減。UI・既存機能は変更なし。V2.2.1の jsdom 27.4.0 修正も維持。

iPhone / PWA を主対象に、旧Dashboardの機能をモジュール単位へ分割して作り直した新規リポジトリです。
旧リポジトリは変更せず、このフォルダを新しいGitHubリポジトリのルートとして使用します。

**V2.2**: 独創研究に「一般独創」を追加し、既存テーマと無関係でも質の高い異分野研究を拾えるようにしています。

## 1. V2の画面構成

下部ナビは5項目に固定しています。

- ホーム: 前回から変わった情報へすぐ移動
- 天気: 現在・今日のポイント・今日/明日の1時間予報・週間
- 読む: ニュース / 知識 / 論文
- 動画: YouTube / Twitch
- SNS: Twitter/X RSSリスト

設定は各画面右上の歯車から開きます。

## 2. UI方針

### Liquid Glass風 下部ナビ

PWA/通常WebページからSwiftUI/UIKitのネイティブLiquid Glass APIを直接呼び出すことはできないため、
`backdrop-filter` / `-webkit-backdrop-filter`、半透明背景、反射ハイライト、safe-areaを使ったWeb向け近似表現です。
Liquid Glass風表現はナビゲーション層だけに限定し、記事カード本文には使っていません。

設定 > 下部ナビ から以下を変更できます。

- ON/OFF
- 透明度
- ぼかし量

### 画面縁の色

`viewport-fit=cover` と `env(safe-area-inset-*)` を使用し、PWAの表示領域に固定フレームを描画します。
WebアプリからiPhoneの物理パネル形状を直接取得することはできないため、物理ディスプレイの完全な輪郭ではなくWeb表示領域の輪郭です。

標準色:

- ホーム: 水色
- 天気: 青
- ニュース: オレンジ
- 知識: 緑
- 論文: 紫
- YouTube: 赤
- Twitch: Twitch紫
- SNS: 青
- 設定: グレー

設定画面から機能別の色、太さ、透明度、発光量、ON/OFFを変更できます。
標準では細く半透明にして、本文への注意を奪いすぎないようにしています。

## 3. 天気

- Open-Meteo JMA endpoint: 1時間ごとの詳細表示
- 気象庁公式 forecast JSON: 今日/週間の日本語予報
- 1時間予報は現在時刻以降を横スクロール
- 「今日のポイント」はAI待ちをせず、雨・温度変化・風から即時生成
- 地域追加 / 並べ替え / 削除
- Hokkaido / Okinawaの気象庁地域コードも補助対応

## 4. ニュース / 知識 / 論文

`src/features/reader/` に共通化しています。

### ショート型表示

- iPhoneで上下スワイプ: 前/次の記事
- 1記事の重いDOMだけ保持するので長時間利用時のメモリを抑制
- 「5秒で分かる」
- 「なぜ重要？」
- 重要ポイント3〜4件
- AIに質問
- 原文
- 常時「全一覧」ボタン

### いま押さえる

即表示は端末側ヒューリスティックで選択し、設定がONならGeminiの評価を裏で取得して次回候補へ補正します。
AI待ちで初期画面を止めません。

### All / 各RSSタブ

ニュース・知識は `All` + 登録したRSSタブを表示します。
Allは最大4並列で取得し、先に返ったRSSから表示します。
ローカルキャッシュからの先行表示にも対応しています。

### 全一覧

- 前回から何件増えたか
- 未読ドット
- 「前回ここまで」ライン
- 検索
- タップでショート型AI要約へ移動

### 論文

論文は左右スワイプできる2トラック構成です。

- **製品・熱**: これまでの炊飯、真空断熱、蓄熱、対象製品、省エネ、ユーザビリティ、競合メーカー研究
- **独創研究**: 一見離れた分野の掛け合わせ、身近な疑問、実験・測定・モデルなどの検証性を同時に満たす研究

独創研究の中はさらに3つの表示へ切り替えられます。

- **すべて**: 応用発想＋一般独創。ピックアップでは候補がある限り両方を最低1件ずつ混ぜる
- **応用発想**: 炊飯・熱・家電など既存テーマへ異分野の原理を持ち込む、従来の11軸
- **一般独創**: 既存の論文キーワードとの関係を一切必須にせず、一般論として質の高い独創研究を探す13軸

一般独創には、摩擦×触覚、知覚心理×物理特性、幾何学/折り紙×メタマテリアル、統計物理×群集、ネットワーク科学×情報/行動拡散、因果推論×日常行動、光/音/温熱環境×集中/睡眠、計算処理×安価センサ、生物構造×自己洗浄/集水、液滴蒸発×乾燥模様、Human-AI×判断品質、複雑系×連鎖故障などを含みます。

「独創研究」は珍しい題材だけでは採用しません。タイトル・抄録等から、2つの概念群が交差していることと、実験/測定/機構/モデル/シミュレーション/自然実験/因果推論/心理物理/検証などの研究方法が確認できることを重視します。**一般独創は応用発想より厳しく**、概念接続が濃いか、方法論が複数見えない候補を落とします。Semantic Scholarでは公開PDFを優先し、被引用数・影響度付き引用は古い研究だけを優遇しない補助スコアとして使用します。

画面の **検索意図** ボタンから、各キーワードの日本語/英語、なぜ面白い研究につながりやすいか、Web of Science向け `TS=(...)`、Scopus向け `TITLE-ABS-KEY(...)` を確認できます。全一覧検索は研究軸や説明文も対象です。

ホームの論文カードにも `一般 +N / 応用 +N / 製品 +N` のように反映します。

独創研究のキーワード一覧は `PAPER_CREATIVE_KEYWORDS.md` にもまとめています。

既存の製品・熱研究バックエンドはそのまま継承しています。

- J-STAGE
- Semantic Scholar
- PLOS
- PMC
- CORE
- Crossref競合企業関連
- CiNii Research (設定時)
- IEEE (設定時)
- 英語タイトルをGeminiで日本語化
- PDFリンクを優先してPDF本文抽出
- 長文PDFは重要ページを抽出してGemini入力を圧縮
- Google News実URL解決 / HTML本文Readabilityも継承

## 5. YouTube

- チャンネル選択はBottom Sheetへ隠し、動画/Shorts/LIVEの判断を先にできるUI
- 動画: 通常投稿 + プレミア公開
- Shorts: Shortsマーカーを持つ短尺動画
- LIVE: 生配信 / 配信予定 / 生配信アーカイブ
- 通常動画/LIVE: アプリ内埋め込みプレイヤー
- 連続再生ON/OFF
- 前/次
- YouTubeで開く
- 横画面ボタン
- Shorts: 9:16中心の全画面型、上下スワイプ、横画面ボタンなし
- チャンネル追加 / 並べ替え / 削除

注意: YouTube Data APIには第三者動画の縦横比を確実に判定できる公開フラグがないため、Shorts分類はタイトル/説明/タグのShorts表記 + 短尺条件を使用しています。

## 6. Twitch

- チャンネル追加は Twitch URL / login名 のどちらでも可
- Get StreamsでLIVE判定
- Get Videos(type=archive)でアーカイブ取得
- LIVEは一覧上部に固定
- アプリ内Twitch Embed再生
- VOD再生
- Twitchで開くも残す
- 横画面表示
- 配信者選択はBottom Sheet

### 流れるコメント

Twitch Embed本体をページ要素で覆うことは公式要件に反するため、
コメントは動画の「直下にある専用コメントレーン」をニコニコ風に右から左へ流します。
Twitch公式 EventSub `channel.chat.message` を使用します。

初回のみTwitch OAuthで `user:read:chat` を許可します。
アクセストークンは `sessionStorage` に保持し、永続保存しません。

画面幅が400 CSS px未満のiPhone縦画面では、Twitch Embedの最小幅を満たすためプレイヤーを横画面CSS表示で開始します。

## 7. Twitter / X

- RSSHubのList RSS
- リストタブ
- 追加 / 並べ替え / 削除
- 画像表示
- 動画は外部Twitter/Xで開く
- リストごとのスクロール位置保持

## 8. 設定移行

新しいVercelドメインは旧ドメインとlocalStorageを共有できません。
V2には設定のJSONエクスポート / インポート機能を用意しています。

V2用の設定を書き出して別V2環境へ移す用途です。
旧v29とキー構造が異なるため、旧版データを完全自動変換する移行ツールではありません。

## 9. GitHubへ作成する手順

1. GitHubアプリまたはWebで新規リポジトリを作成
2. このZIPの中身をリポジトリ直下へ配置
3. Vercelで `Add New Project`
4. 新しいGitHubリポジトリをImport
5. Framework Presetは `Other`
6. Build Commandは空欄でOK
7. Environment Variablesを設定
8. Deploy
9. Twitch Developer Consoleを使う場合は、Vercel本番URLをOAuth Redirect URLとして登録
10. iPhone SafariでVercel URLを開き、ホーム画面へ追加

## 10. Vercel環境変数

### 必須: Geminiを使う場合

```env
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.1-flash-lite
```

### 必須: YouTubeを使う場合

```env
YOUTUBE_API_KEY=...
```

YouTube APIキーはブラウザへ渡さずVercel Function内だけで使用します。

### 必須: Twitchを使う場合

```env
TWITCH_CLIENT_ID=...
TWITCH_CLIENT_SECRET=...
```

Client Secretはブラウザへ渡しません。
TwitchコメントOAuthではClient IDだけを `/api/public-config` からブラウザへ渡します。

Twitch Developer ConsoleのOAuth Redirect URL例:

```text
https://your-project.vercel.app/
```

### 論文で任意

```env
SEMANTIC_SCHOLAR_API_KEY=...
CINII_APP_ID=...
CORE_API_KEY=...
IEEE_API_KEY=...
CROSSREF_MAILTO=your-email@example.com
NCBI_EMAIL=your-email@example.com
```

未設定の任意ソースはスキップして、他ソースだけで動く設計です。

## 11. ファイル構造

```text
personal-dashboard-v2/
├─ index.html
├─ manifest.webmanifest
├─ sw.js
├─ package.json
├─ vercel.json
├─ .env.example
├─ PAPER_CREATIVE_KEYWORDS.md
├─ shared/
│  └─ paper-creative-keywords.js
├─ icons/
├─ src/
│  ├─ main.js
│  ├─ app/
│  ├─ shared/
│  ├─ features/
│  │  ├─ home/
│  │  ├─ weather/
│  │  ├─ reader/
│  │  ├─ media/
│  │  ├─ youtube/
│  │  ├─ twitch/
│  │  ├─ twitter/
│  │  └─ settings/
│  └─ styles/
├─ api/
│  ├─ papers-feed.mjs
│  └─ creative-papers-feed.mjs
└─ lib/
```

## 12. 主な責務

- `src/main.js`: 起動だけ
- `src/app/router.js`: 画面遷移 / ナビ / 機能色
- `src/app/store.js`: ユーザー設定と登録データ
- `src/features/weather/`: 天気だけ
- `src/features/reader/`: ニュース・知識・論文、論文2トラックUI
- `api/creative-papers-feed.mjs`: 独創研究専用の取得・品質フィルタ
- `shared/paper-creative-keywords.js`: 独創研究の検索軸をサーバー/UIで共用
- `src/features/youtube/`: YouTubeだけ
- `src/features/twitch/`: Twitchだけ
- `src/features/twitter/`: Twitterだけ
- `src/features/settings/`: 見た目 / データ / 連携設定
- `api/`: Vercel Functions
- `lib/`: サーバー共通処理

巨大な1個の `app.js` は使用しません。


## V2.2.2: Vercel Hobby 12 Functions 対応

V2.2.1 では `api/` 直下に 13 個の `.mjs` があり、Vercel Hobby の 1 Deployment あたり最大 12 Functions を 1 個超えていました。

V2.2.2 では機能を削除せず、次の2つを既存Functionへ統合しています。

- 旧 `/api/gemini-check?live=1` → `/api/rank-items?mode=gemini-check&live=1`
- 旧 `/api/public-config` → `/api/twitch-feed?mode=config`

これにより `api/` は **11 Functions** になり、Hobby上限に対して1個分の余裕も残しています。

確認用:

```bash
npm run check:functions
```

`Vercel API Functions: 11/12` と表示されればOKです。
