export function relativeTime(value) {
  const ts = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(ts)) return '';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 45) return 'たった今';
  if (sec < 3600) return `${Math.floor(sec/60)}分前`;
  if (sec < 86400) return `${Math.floor(sec/3600)}時間前`;
  if (sec < 604800) return `${Math.floor(sec/86400)}日前`;
  return new Date(ts).toLocaleDateString('ja-JP',{month:'numeric',day:'numeric'});
}
export function todayLabel() {
  return new Intl.DateTimeFormat('ja-JP',{month:'long',day:'numeric',weekday:'short'}).format(new Date());
}
export function shortDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
}
