// v2.19.9: 0f3ea301で修正済みのAI要約ゲートを、旧キャッシュを使わず必ず再取得する。
import './features/reader/summary-fetch-gate.js?v=2199summarycache1';
// v2.19.14: 即時3カードUXだけを確実に再配布。正式AI要約ゲートは変更しない。
import './features/reader/summary-instant-ux.js?v=21914instantux1';
import './main.js?v=2196media1';
