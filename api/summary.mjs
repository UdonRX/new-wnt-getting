import summaryV2184 from '../lib/summary-v2184.mjs';
import summaryBatch from '../lib/summary-batch.mjs';
import { extractArticleFromUrl } from '../lib/article-reader.mjs';

const GENERIC_RE = /(?:記事の要点をわかりやすく整理|記事の要点を整理|についての記事です|背景や特徴(?:を|は).*(?:整理|確認)|影響や今後(?:を|は).*(?:整理|確認)|記事本文から(?:整理|確認)|主要な内容を確認|元記事(?:本文)?(?:を|で)|詳しくは元記事|本文を十分に取得できず|タイトルだけから内容を推測)/i;

function clean(value = '') {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function first500(value = '') {
  return Array.from(clean(value)).slice(0, 500).join('');
}

function compact(value = '') {
  return clean(value).replace(/[\s、。・:：\-—|｜「」『』（）()]/g, '').toLowerCase();
}

function fingerprint(value = '') {
  let hash = 2166136261;
  for (const ch of String(value || '')) {
    hash ^= ch.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function descriptionLooksReal(title, description) {
  const text = clean(description);
  if (text.length < 70 || GENERIC_RE.test(text)) return false;
  const t = compact(title);
  const d = compact(text);
  if (t.length >= 12 && d.length < 220 && (d === t || d.startsWith(t) || d.includes(t.slice(0, Math.min(36, t.length))))) return false;
  return (text.match(/[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]/g) || []).length >= 55;
}

async function prepareBody(req) {
  const raw = typeof req.body === 'string'
    ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })()
    : (req.body || {});
  const body = { ...raw };
  const title = clean(body.title);
  const description = clean(body.description);

  if (descriptionLooksReal(title, description)) {
    body.description = first500(description);
    body.preparedSource = 'rss';
    return body;
  }

  const url = clean(body.url || body.link);
  if (url) {
    try {
      const article = await Promise.race([
        extractArticleFromUrl(url, { maxTextLength: 2200, preferPdf: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('summary article timeout')), 8500))
      ]);
      const text = first500(article?.text || '');
      if (text.length >= 70 && !GENERIC_RE.test(text)) {
        body.description = text;
        body.title = clean(article?.title || title) || title;
        body.preparedSource = article?.sourceType === 'pdf' ? 'pdf' : 'article';
        return body;
      }
    } catch (error) {
      console.warn('[summary] article prepare failed', error?.message || error);
    }
  }

  body.description = description.length >= 45 && !GENERIC_RE.test(description) ? first500(description) : '';
  body.preparedSource = body.description ? 'rss-short' : 'missing';
  return body;
}

function isolateSummaryWork(body = {}) {
  const originalMode = clean(body.mode) || 'auto';
  const material = [clean(body.title), first500(body.description), clean(body.preparedSource)].join('\n');
  return {
    ...body,
    clientMode: originalMode,
    mode: `${originalMode}#${fingerprint(material)}`.slice(0, 32)
  };
}

export default async function handler(req, res) {
  if (req.method === 'POST' && String(req.query?.batch || '') === '1') {
    return summaryBatch(req, res);
  }

  if (req.method === 'POST') {
    const prepared = await prepareBody(req);
    req.body = isolateSummaryWork(prepared);
    res.setHeader('X-Summary-Prepared-Source', prepared.preparedSource || 'unknown');
  }

  return summaryV2184(req, res);
}
