const TRACE_LIMIT = 1200;

function globalScope() {
  return typeof window !== 'undefined' ? window : globalThis;
}

export function readerDebugEnabled() {
  if (typeof window === 'undefined') return false;
  try {
    const query = new URLSearchParams(window.location.search);
    return query.get('readerDebug') === '1' || localStorage.getItem('pdv2:readerDebug') === '1';
  } catch { return false; }
}

function traceBuffer() {
  const scope = globalScope();
  if (!Array.isArray(scope.__PDV2_READER_TRACE)) scope.__PDV2_READER_TRACE = [];
  return scope.__PDV2_READER_TRACE;
}

export function readerTrace(event, payload = {}) {
  const entry = {
    at: new Date().toISOString(),
    event: String(event || 'reader'),
    ...(payload && typeof payload === 'object' ? payload : { value: payload })
  };
  const buffer = traceBuffer();
  buffer.push(entry);
  if (buffer.length > TRACE_LIMIT) buffer.splice(0, buffer.length - TRACE_LIMIT);
  if (readerDebugEnabled() && typeof console !== 'undefined') console.log(`[reader:${entry.event}]`, entry);
  return entry;
}

export function readerTable(event, rows = []) {
  const values = Array.isArray(rows) ? rows : [];
  readerTrace(event, { count: values.length });
  if (readerDebugEnabled() && typeof console !== 'undefined' && typeof console.table === 'function') console.table(values);
}

export function articleDateDebug(item = {}, index = 0) {
  const original = item?.originalDate ?? item?.pubDate ?? '';
  const explicit = Number(item?.publishedTimestamp);
  const parsed = new Date(item?.pubDate || 0).getTime();
  const timestamp = Number.isFinite(explicit) && explicit > 0
    ? explicit
    : (Number.isFinite(parsed) && parsed > 0 ? parsed : 0);
  return {
    index,
    id: String(item?.id || ''),
    source: String(item?.feedName || item?.source || ''),
    title: String(item?.title || ''),
    originalDate: String(original || ''),
    normalizedDate: timestamp ? new Date(timestamp).toISOString() : '',
    timestamp
  };
}
