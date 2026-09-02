const RECOMMENDATION_TIMEOUT_MS = 7000;

export async function loadCrossSourceRecommendations(onProgress) {
  onProgress?.(18, 'Google Newsから候補を確認中');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECOMMENDATION_TIMEOUT_MS);
  try {
    const response = await fetch('/api/recommendations', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      cache: 'default'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.fallbackRequired) {
      const error = new Error(data?.error || `おすすめ取得エラー (${response.status})`);
      error.stage = data?.stage || 'cross-source';
      error.requestId = data?.requestId || '';
      throw error;
    }
    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) throw new Error('新方式のおすすめ候補が空です');
    onProgress?.(88, '重要度・話題性・複数媒体を評価済み');
    return items.map(item => ({
      ...item,
      _readerMode: 'news',
      _recommendationLabel: item?._recommendationLabel || '重要・話題ニュース'
    }));
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('新方式のおすすめ取得がタイムアウトしました');
      timeoutError.stage = 'client-timeout';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
