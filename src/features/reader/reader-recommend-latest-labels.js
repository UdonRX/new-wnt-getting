function replaceText(text = '') {
  return String(text)
    .replace('おすすめを準備しています…', '最新記事を準備しています…')
    .replace('保存済みReader記事を優先してすばやく表示します', '登録した配信元の記事を新しい順に表示します')
    .replace('保存済みReader記事を確認中', '登録した配信元の最新記事を確認中')
    .replace(/保存済み記事を読み込み中/g, '最新記事データを確認中')
    .replace('保存済み記事を読み込みました', '最新記事データを確認しました')
    .replace('保存済み記事がないため、最新記事を取得しています', '登録した配信元から最新記事を取得しています')
    .replace('おすすめ順を整理中', '記事を新しい順に整理中')
    .replace('カード表示を準備しました', '最新記事を表示します')
    .replace(/^(ニュース|知識|改善事例|一般独創)を取得中/, '$1の最新記事を取得中')
    .replace(/^(ニュース|知識|改善事例|一般独創)を取得しました/, '$1の最新記事を取得しました');
}

function syncLatestLabels() {
  const box = document.querySelector('.reader-recommendations-open .reader-recommend-loading');
  if (!box) return;
  for (const node of box.querySelectorAll('strong, span')) {
    const before = String(node.textContent || '');
    const after = replaceText(before);
    if (after !== before) node.textContent = after;
  }
}

if (typeof window !== 'undefined' && !window.__PDV2_READER_LATEST_LABELS_INSTALLED) {
  window.__PDV2_READER_LATEST_LABELS_INSTALLED = true;
  const observer = new MutationObserver(syncLatestLabels);
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  syncLatestLabels();
}
