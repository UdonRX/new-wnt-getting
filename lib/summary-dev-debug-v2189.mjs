/* TEMP v2.18.9 Reader summary diagnostics.
 * Remove this module and its import/calls from api/summary.mjs once the
 * 10th-card-and-later summary issue is identified and fixed.
 */

const PAYWALL_RE = /(?:有料(?:会員|記事)|会員限定|有料会員限定|続きを読むには|続き(?:を読む|は).*?(?:ログイン|会員|登録)|ログイン(?:して|が必要|してください)|会員登録|購読(?:して|が必要)|サブスクリプション|subscribe\b|subscription\b|sign\s*in\b|login\s*required|members?\s*only|premium\s*content)/i;
const SYSTEM_RE = /(?:\b404\b|\b403\b|\b500\b|\b503\b|not\s*found|page\s*not\s*found|ページが見つかりません|お探しのページ|access\s*denied|forbidden|service\s*unavailable|internal\s*server\s*error|javascript\s*(?:error|required|disabled)|エラーが発生|読み込みに失敗|アクセスできません|temporarily\s*unavailable)/i;
const NAV_RE = /(?:ホーム|トップページ|メニュー|カテゴリ|カテゴリー|サイトマップ|お問い合わせ|プライバシー|利用規約|ログイン|会員登録|検索|ニュース一覧|記事一覧|前の記事|次の記事|breadcrumb|navigation|menu|home|contact|privacy|terms|search)/gi;
const GENERIC_RE = /(?:記事の要点をわかりやすく整理|記事の要点を整理|についての記事です|背景や特徴(?:を|は).*(?:整理|確認)|影響や今後(?:を|は).*(?:整理|確認)|記事本文から(?:整理|確認)|主要な内容を確認|元記事(?:本文)?(?:を|で)|詳しくは元記事|本文を十分に取得できず|タイトルだけから内容を推測)/i;
const MIN_SUMMARY_CHARS = 70;

export function cleanDebugText(value = '', max = 5000) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function hostOf(url = '') {
  try { return new URL(String(url || '')).hostname || ''; }
  catch { return ''; }
}

function evidenceOf(text = '', fallback = '') {
  const cleaned = cleanDebugText(text, 1000);
  if (cleaned) return Array.from(cleaned).slice(0, 180).join('');
  return Array.from(cleanDebugText(fallback, 1000)).slice(0, 180).join('');
}

function sentenceCount(text = '') {
  return (String(text || '').match(/[。！？!?\.](?:\s|$)/g) || []).length;
}

function contentCharCount(text = '') {
  return (String(text || '').match(/[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
}

function diagnostic({ code, classification, reason, text = '', fallbackEvidence = '', stage = 'unknown', route = 'single', url = '', fetchError = '' }) {
  const cleaned = cleanDebugText(text, 4000);
  return {
    code,
    classification,
    reason,
    stage,
    route,
    charCount: Array.from(cleaned).length,
    host: hostOf(url),
    fetchError: cleanDebugText(fetchError, 180),
    evidence: evidenceOf(cleaned, fallbackEvidence)
  };
}

export function inspectSummaryText(text = '', context = {}) {
  const cleaned = cleanDebugText(text, 4000);
  const chars = Array.from(cleaned).length;
  const contentChars = contentCharCount(cleaned);
  const navHits = cleaned.match(NAV_RE) || [];
  const base = { ...context, text: cleaned };

  if (PAYWALL_RE.test(cleaned)) {
    return diagnostic({
      ...base,
      code: 'PAYWALL_AUTH',
      classification: '有料ウォール／ログイン要求',
      reason: '本文候補よりも会員限定・ログイン・購読要求の文言が検出され、記事本文として扱えませんでした。'
    });
  }

  if (SYSTEM_RE.test(cleaned) && (chars < 900 || sentenceCount(cleaned) < 2)) {
    return diagnostic({
      ...base,
      code: 'SYSTEM_MESSAGE',
      classification: 'システムメッセージ',
      reason: '404・アクセス拒否・JavaScriptエラー等に相当する文言が中心で、記事本文の抽出結果ではありませんでした。'
    });
  }

  if (GENERIC_RE.test(cleaned) && chars < 900) {
    return diagnostic({
      ...base,
      code: 'GENERIC_PLACEHOLDER',
      classification: '取得ミス／代替文',
      reason: '記事そのものではなく、過去の要約失敗時に使われる汎用文・代替文に一致しました。'
    });
  }

  if (navHits.length >= 3 && sentenceCount(cleaned) < 2 && chars < 900) {
    return diagnostic({
      ...base,
      code: 'NAVIGATION_ONLY',
      classification: 'メニュー／ナビゲーションのみ',
      reason: `本文らしい文よりサイト操作語が多く、ナビゲーション要素を取得した可能性が高い状態です（操作語${navHits.length}件）。`
    });
  }

  if (chars < MIN_SUMMARY_CHARS) {
    if (chars >= 20 && contentChars < Math.max(8, Math.floor(chars * 0.28))) {
      return diagnostic({
        ...base,
        code: 'SYMBOL_NOISE',
        classification: '記号・ノイズ中心',
        reason: `取得文字${chars}文字のうち本文候補となる文字が${contentChars}文字しかなく、記号や断片が中心でした。`
      });
    }
    return diagnostic({
      ...base,
      code: chars === 0 ? 'ARTICLE_EMPTY' : 'TEXT_TOO_SHORT',
      classification: chars === 0 ? '取得ミス／本文空' : '文字数不足',
      reason: `要約判定に必要な最低${MIN_SUMMARY_CHARS}文字に対し、本文候補は${chars}文字でした。`
    });
  }

  return null;
}

export function diagnosticFromFetchError(error, context = {}) {
  const message = cleanDebugText(error?.message || error || '', 220);
  const timeout = /timeout|abort|timed?\s*out/i.test(message);
  return diagnostic({
    ...context,
    code: timeout ? 'ARTICLE_FETCH_TIMEOUT' : 'ARTICLE_FETCH_FAILED',
    classification: timeout ? '取得タイムアウト' : '取得ミス',
    reason: timeout
      ? 'URL先の記事抽出が制限時間内に完了せず、本文候補を確定できませんでした。'
      : 'URL先の記事抽出処理が失敗し、本文候補を確定できませんでした。',
    fetchError: message,
    fallbackEvidence: message || context.fallbackEvidence || ''
  });
}

function safeSentence(text = '') {
  const value = cleanDebugText(text, 260).replace(/[。！？!?]+$/, '').trim();
  return `${value || '情報なし'}。`;
}

export function buildDevErrorSummary(diagnosticData = {}) {
  const route = diagnosticData.route || 'single';
  const stage = diagnosticData.stage || 'unknown';
  const code = diagnosticData.code || 'UNKNOWN_EXTRACTION';
  const chars = Number(diagnosticData.charCount || 0);
  const host = diagnosticData.host ? ` / host=${diagnosticData.host}` : '';
  const fetchError = diagnosticData.fetchError ? ` / fetch=${diagnosticData.fetchError}` : '';
  const evidenceRaw = diagnosticData.evidence
    ? String(diagnosticData.evidence)
        .replace(/本文を十分に取得できず/g, '本文を［DEV断片］十分に取得できず')
        .replace(/タイトルだけから内容を推測/g, 'タイトルだけから［DEV断片］内容を推測')
        .replace(/詳しくは元記事/g, '詳しくは［DEV断片］元記事')
    : '';
  const evidence = evidenceRaw
    ? `取得断片「${evidenceRaw}」（stage=${stage}）`
    : `本文候補が空で、抜粋できる文字列がありません（stage=${stage}）`;

  return {
    headline: '[DEV_ERROR]',
    lines: [
      {
        label: '・エラー分類：',
        text: safeSentence(`${diagnosticData.classification || '取得ミス'}（${code} / route=${route} / stage=${stage}）`)
      },
      {
        label: '・つまずいた理由：',
        text: safeSentence(`${diagnosticData.reason || '本文候補を要約可能な状態まで取得できませんでした'}（chars=${chars}${host}${fetchError}）`)
      },
      {
        label: '・証拠テキスト：',
        text: safeSentence(evidence)
      }
    ],
    short: safeSentence(`${diagnosticData.classification || '取得ミス'}（${code}）`),
    points: [safeSentence(diagnosticData.reason || '本文候補を取得できませんでした'), safeSentence(evidence)],
    provider: 'dev-error-v2189',
    model: '',
    contentSource: diagnosticData.stage || 'unknown',
    cacheable: false,
    devError: {
      code,
      route,
      stage,
      charCount: chars,
      host: diagnosticData.host || '',
      fetchError: diagnosticData.fetchError || '',
      evidence: diagnosticData.evidence || ''
    }
  };
}

export function diagnosticForMissing({ route = 'single', stage = 'prepare', url = '', fallbackEvidence = '' } = {}) {
  return diagnostic({
    code: 'ARTICLE_EMPTY',
    classification: '取得ミス／本文空',
    reason: 'RSS本文とURL先の本文抽出の両方で、要約に使える本文候補を確定できませんでした。',
    route,
    stage,
    url,
    fallbackEvidence
  });
}
