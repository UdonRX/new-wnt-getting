// v2.19.9: 0f3ea301で修正済みのAI要約ゲートを、旧キャッシュを使わず必ず再取得する。
import './features/reader/summary-fetch-gate.js?v=2199summarycache1';
// v2.19.17: 即時3カードは維持し、正式AI要約の太字選定を結論/数値/固有名詞/変化へ絞る。
import './features/reader/summary-instant-ux.js?v=21917highlight1';
// Reader専用: RSSが実質的に短い場合だけ「記載なし」を使い、具体情報があれば1〜2文でもAIで3カード要約する。
import './features/reader/reader-summary-accelerator.js?v=21924rssquality1';
// Reader専用: 通常カードは触らず、横ジェスチャー確定時の1記事だけ深掘りカルーセル化する。横操作はこのモジュールだけが所有する。
import './features/reader/reader-deep-dive-page-unit.js?v=21930lazycarousel1';
// Reader専用: Tavilyは配信元言語で検索し、外国語結果は日本語化してから表示。初期ドット表示と深掘りUI補正もここで行う。
import './features/reader/reader-deep-dive-long-wait.js?v=21934activedotsdiag1';
// Reader専用: 実処理名を切り替えながら1本のプログレスバーを0→100%へ進める。
import './features/reader/reader-recommend-loading-ui.js?v=21922loadingsingle1';
// Reader専用: 読み込み表示を「登録配信元の最新記事を新しい順」に統一する。
import './features/reader/reader-recommend-latest-labels.js?v=21923latestlabels1';
// Reader専用: 2分以内の新鮮なキャッシュだけ即利用し、古いキャッシュは裏で更新して最新性と速度を両立する。
import './features/reader/reader-recommend-cache-fast.js?v=21923latestcache1';
// v2.19.17: 記事一覧タブは完全表示なら現在位置を維持し、見切れた時だけ中央へ追従する。
import './features/reader/reader-list-ux.js?v=21917tabs2';
// v2.19.17: 横画面操作バーを動画と同じ時計回り90°へ回転する。
import './features/media/media-landscape-ui.js?v=21917landscape2';
import './main.js?v=2196media1';
