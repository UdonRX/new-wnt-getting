// v2.19.9: 0f3ea301で修正済みのAI要約ゲートを、旧キャッシュを使わず必ず再取得する。
import './features/reader/summary-fetch-gate.js?v=2199summarycache1';
// v2.19.13: 正式AI要約ロジックは触らず、表示直後の3カード即時UXだけを後段で強化する。
import './features/reader/summary-instant-ux.js?v=21913instantux1';
import './main.js?v=2196media1';
