export function articleIdentity(item = {}) {
  return String(
    item?.id
    || item?.link
    || item?.url
    || `${item?.feedName || item?.source || 'unknown'}|${item?.title || 'untitled'}`
  ).trim();
}

export function clampReaderIndex(index, length) {
  const size = Math.max(0, Number(length) || 0);
  if (!size) return 0;
  const value = Number.isFinite(Number(index)) ? Math.trunc(Number(index)) : 0;
  return Math.max(0, Math.min(value, size - 1));
}

export function nextPrefetchIndices(index, length, count = 1) {
  const size = Math.max(0, Number(length) || 0);
  if (!size) return [];
  const current = clampReaderIndex(index, size);
  // Reader focus intentionally prefetches only the immediate next article.
  // This avoids the old 10-item batch boundary and limits Gemini concurrency.
  const safeCount = Math.min(1, Math.max(0, Number(count) || 0));
  const result = [];
  for (let offset = 1; offset <= safeCount; offset += 1) {
    const next = current + offset;
    if (next < size) result.push(next);
  }
  return result;
}

export function readerFlowSnapshot(items = [], index = 0) {
  const rows = Array.isArray(items) ? items : [];
  const currentIndex = clampReaderIndex(index, rows.length);
  const current = rows[currentIndex] || null;
  return {
    totalArticles: rows.length,
    currentIndex,
    currentArticleId: current ? articleIdentity(current) : '',
    currentTitle: String(current?.title || ''),
    nextPrefetch: nextPrefetchIndices(currentIndex, rows.length, 1)
  };
}

export function canApplyArticleResult(expectedArticleId, item) {
  return Boolean(expectedArticleId) && expectedArticleId === articleIdentity(item);
}
