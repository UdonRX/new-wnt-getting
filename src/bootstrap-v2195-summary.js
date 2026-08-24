// v2.19.9: 0f3ea301で修正済みのAI要約ゲートを、旧キャッシュを使わず必ず再取得する。
import './features/reader/summary-fetch-gate.js?v=2199summarycache1';
// v2.19.15: 先読み済み記事でもactive化した瞬間に即時3カードを表示する。正式AI要約ゲートは変更しない。
import './features/reader/summary-instant-ux.js?v=21915instantactive1';
// v2.19.16: 記事一覧タブ追従とAI要約画面の横スワイプ抑止だけを追加する。
import './features/reader/reader-list-ux.js?v=21916tabs1';
// v2.19.16: YouTube/Twitch横画面の3ボタン表示・自動非表示・viewport補正だけを追加する。
import './features/media/media-landscape-ui.js?v=21916landscape1';
import './main.js?v=2196media1';
