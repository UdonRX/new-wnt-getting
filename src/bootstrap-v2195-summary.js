// v2.19.9: 0f3ea301で修正済みのAI要約ゲートを、旧キャッシュを使わず必ず再取得する。
import './features/reader/summary-fetch-gate.js?v=2199summarycache1';
// v2.19.17: 即時3カードは維持し、正式AI要約の太字選定を結論/数値/固有名詞/変化へ絞る。
import './features/reader/summary-instant-ux.js?v=21917highlight1';
// v2.19.17: 記事一覧タブは完全表示なら現在位置を維持し、見切れた時だけ中央へ追従する。
import './features/reader/reader-list-ux.js?v=21917tabs2';
// v2.19.17: 横画面操作バーを動画と同じ時計回り90°へ回転する。
import './features/media/media-landscape-ui.js?v=21917landscape2';
import './main.js?v=2196media1';
