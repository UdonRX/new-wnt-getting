// v2.19.9: 0f3ea301で修正済みのAI要約ゲートを、旧キャッシュを使わず必ず再取得する。
import './features/reader/summary-fetch-gate.js?v=2199summarycache1';
// v2.19.17: 即時3カードは維持し、正式AI要約の太字選定を結論/数値/固有名詞/変化へ絞る。
import './features/reader/summary-instant-ux.js?v=21917highlight1';
// Reader専用: 先読みを停止し、十分なRSSはAI要約、短いRSSは取得済み事実だけで3カード化する。
import './features/reader/reader-summary-accelerator.js?v=21919rssonly1';
// Reader専用: キャッシュ判定/初回取得/整列/表示準備を処理実態に合わせた多段プログレスで可視化する。
// cache-fastより先に読み込み、実ネットワークへ進んだ時だけ取得バーを動かす（待ち時間は追加しない）。
import './features/reader/reader-recommend-loading-ui.js?v=21921loadingstages1';
// Reader専用: おすすめ表示中は保存済み記事を先に使い、同期RSS更新待ちを外して2秒以内表示を狙う。
import './features/reader/reader-recommend-cache-fast.js?v=21920recommendfast1';
// v2.19.17: 記事一覧タブは完全表示なら現在位置を維持し、見切れた時だけ中央へ追従する。
import './features/reader/reader-list-ux.js?v=21917tabs2';
// v2.19.17: 横画面操作バーを動画と同じ時計回り90°へ回転する。
import './features/media/media-landscape-ui.js?v=21917landscape2';
import './main.js?v=2196media1';
