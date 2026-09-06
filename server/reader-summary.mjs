import dns from 'node:dns/promises';
import net from 'node:net';
import readabilityPackage from '@mozilla/readability';
import jsdomPackage from 'jsdom';
import legacySummary from './summary.mjs';
import { resolveSourcePublishedTime } from '../lib/source-published-time.mjs';
import { waitForGeminiStartSlot } from '../lib/gemini.mjs';
import { setAsciiHeader } from '../lib/http-response-safe.mjs';

const { Readability } = readabilityPackage;
const { JSDOM } = jsdomPackage;

const PRIMARY_MODEL = String(process.env.GEMINI_SUMMARY_MODEL || 'gemini-3.5-flash-lite').trim();
const FAST_MODEL_TIMEOUT_MS = 2800;
const FAST_INPUT_LIMIT = 380;
const FAST_OUTPUT_TOKEN_LIMIT = 220;
const RSS_MIN_CHARS = 160;
const RSS_MIN_SENTENCES = 2;
const ARTICLE_MIN_CHARS = 180;
const HTML_MAX_BYTES = 2 * 1024 * 1024;
const GOOGLE_RESOLVE_STAGE_TIMEOUT_MS = 550;
const DIRECT_PUBLISHER_FETCH_TIMEOUT_MS = 2200;
const RESOLVED_PUBLISHER_FETCH_TIMEOUT_MS = 1200;
const MAX_REDIRECTS = 3;
const SUMMARY_MIN_CHARS = 12;
const SUMMARY_TARGET_MAX_CHARS = 55;
const SUMMARY_HARD_MAX_CHARS = 90;

const GENERIC_RE = /(?:記事の要点をわかりやすく整理|記事の要点を整理|についての記事です|背景や特徴(?:を|は).*(?:整理|確認)|影響や今後(?:を|は).*(?:確認|整理)|記事本文から(?:整理|確認)|主要な内容を確認|元記事(?:本文)?(?:を|で)|詳しくは元記事|本文を十分に取得できず|タイトルだけから内容を推測)/i;
const RSS_BOILERPLATE_RE = /(?:続きを読む(?:…|\.{3})?|続き(?:はこちら|を読む)|詳細(?:はこちら|を見る)|全文(?:はこちら|を読む)|記事(?:はこちら|を読む)|元記事(?:はこちら|を読む|で確認)|Read\s*more|More\s*details?)/gi;
const DOM_NOISE_RE = /(?:Cookie|クッキー|JavaScript|ログイン|会員登録|お問い合わせ|プライバシーポリシー|利用規約|関連記事|おすすめ記事|広告|Copyright|無断転載|シェア(?:する|はこちら)?|トップページ|ホームへ)/i;
const NON_ARTICLE_TITLE_RE = /(?:新着記事一覧|記事一覧|ニュース一覧|検索結果|タグ一覧|関連タグ|カテゴリ(?:ー)?一覧|アーカイブ一覧|新着一覧)/i;
const NON_ARTICLE_PATH_RE = /\/(?:relatedtags?|tags?|search|archive|archives|authors?)(?:\/|$)|\/(?:category|categories)\/[^/?#]+\/?$/i;
const ARTICLE_JSONLD_TYPE_RE = /(?:NewsArticle|Article|ReportageNewsArticle|AnalysisNewsArticle)/i;

const fastSchema = {
  type: 'object', additionalProperties: false,
  properties: { h: { type: 'string' }, c: { type: 'string' }, b: { type: 'string' }, i: { type: 'string' } },
  required: ['h', 'c', 'b', 'i']
};

function clean(value = '', max = 8000) {
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
function chars(value = '') { return Array.from(String(value || '')).length; }
function firstChars(value = '', limit = FAST_INPUT_LIMIT) { return Array.from(clean(value, 6000)).slice(0, limit).join(''); }
function compact(value = '') { return clean(value).replace(/[\s、。・:：\-—|｜「」『』（）()]/g, '').toLowerCase(); }
function rawBody(req) {
  if (typeof req?.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req?.body || {};
}
function isFastReaderRequest(body = {}) {
  const mode = String(body.mode || body.clientMode || '').split('#')[0].toLowerCase();
  const explicit = body.fast === true || String(body.fast || '').toLowerCase() === 'true';
  return explicit || mode === 'news' || mode === 'knowledge';
}
function isGoogleNewsUrl(rawUrl = '') {
  try { return new URL(String(rawUrl)).hostname.toLowerCase() === 'news.google.com'; } catch { return false; }
}
function stripRssBoilerplate(value = '') { return clean(String(value || '').replace(RSS_BOILERPLATE_RE, ' ')); }
function informativeChars(value = '') { return (String(value || '').match(/[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]/g) || []).length; }
function isTitleEcho(title, value) {
  const titleKey = compact(title), valueKey = compact(value);
  if (titleKey.length < 2 || !valueKey || !valueKey.includes(titleKey)) return false;
  return valueKey.split(titleKey).join('').length < 40;
}
function specificRssSentences(title, description) {
  return (description.match(/[^。！？!?.]{12,}[。！？!?.]?/g) || [])
    .map(sentence => clean(sentence))
    .filter(sentence => informativeChars(sentence) >= 18)
    .filter(sentence => !GENERIC_RE.test(sentence) && !isTitleEcho(title, sentence));
}
function fastRssSufficient(title, description) {
  const text = stripRssBoilerplate(description);
  if (chars(text) < RSS_MIN_CHARS || isTitleEcho(title, text)) return false;
  return specificRssSentences(title, text).length >= RSS_MIN_SENTENCES;
}

export function classifyArticleHint({ title = '', url = '' } = {}) {
  const cleanTitle = clean(title, 500);
  let path = '';
  try { path = new URL(String(url || '')).pathname || ''; } catch {}
  if (NON_ARTICLE_TITLE_RE.test(cleanTitle)) {
    return { pageType: 'list', rejectionReason: 'non-article-title', nonArticle: true };
  }
  if (NON_ARTICLE_PATH_RE.test(path)) {
    return { pageType: 'list', rejectionReason: 'non-article-path', nonArticle: true };
  }
  return { pageType: 'article-candidate', rejectionReason: '', nonArticle: false };
}

function isPrivateIPv4(address) {
  const p = String(address).split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p;
  if ([0, 10, 127].includes(a) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return a >= 224;
}
function isPrivateIPv6(address) {
  const value = String(address).toLowerCase().split('%')[0];
  if (value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(value) || value.startsWith('2001:db8:') || value.startsWith('ff')) return true;
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIPv4(mapped[1]) : false;
}
function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true;
}
async function assertPublicUrl(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl || '').trim()); } catch { throw new Error('記事URLが不正です'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('記事URLが許可されていません');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('記事URLのポートが許可されていません');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('ローカルURLは取得できません');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('プライベートIPは取得できません');
    return url;
  }
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(row => isPrivateAddress(row.address))) throw new Error('取得先が公開アドレスではありません');
  return url;
}
async function readBufferLimited(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('記事HTMLが大きすぎます');
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error('記事HTMLが大きすぎます');
    return buffer;
  }
  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new Error('記事HTMLが大きすぎます');
      }
      parts.push(Buffer.from(value));
    }
  } finally { try { reader.releaseLock(); } catch {} }
  return Buffer.concat(parts);
}
async function fetchPublisherHtml(rawUrl, timeoutMs = DIRECT_PUBLISHER_FETCH_TIMEOUT_MS) {
  let current = await assertPublicUrl(rawUrl);
  const deadline = Date.now() + timeoutMs;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const remaining = Math.max(120, deadline - Date.now());
    if (remaining <= 120 && redirects > 0) throw new Error('記事取得がタイムアウトしました');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let response;
    try {
      response = await fetch(current, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.8,*/*;q=0.2',
          'Accept-Language': 'ja,en-US;q=0.8,en;q=0.6',
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'
        }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirects >= MAX_REDIRECTS) throw new Error('記事リダイレクトに失敗しました');
        try { await response.body?.cancel?.(); } catch {}
        current = await assertPublicUrl(new URL(location, current).href);
        continue;
      }
      if (!response.ok) throw new Error(`記事ページの取得に失敗しました (${response.status})`);
      const type = String(response.headers.get('content-type') || '').toLowerCase();
      if (type && !type.includes('html') && !type.includes('xhtml')) throw new Error('記事リンクの実体がHTMLではありません');
      const buffer = await readBufferLimited(response, HTML_MAX_BYTES);
      return { buffer, finalUrl: current.href, htmlBytes: buffer.length };
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('記事取得がタイムアウトしました');
      throw error;
    } finally { clearTimeout(timer); }
  }
  throw new Error('記事ページを取得できませんでした');
}

function jsonLdArticleInfo(document) {
  const candidates = [];
  function walk(value) {
    if (!value) return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (typeof value !== 'object') return;
    const type = Array.isArray(value['@type']) ? value['@type'].join(' ') : String(value['@type'] || '');
    const body = clean(value.articleBody, 100000);
    if (body || ARTICLE_JSONLD_TYPE_RE.test(type)) {
      candidates.push({
        text: body, type, title: clean(value.headline || value.name, 1000),
        datePublished: clean(value.datePublished, 200), siteName: clean(value.publisher?.name, 300)
      });
    }
    Object.values(value).forEach(child => { if (child && typeof child === 'object') walk(child); });
  }
  document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
    const raw = script.textContent || '';
    if (!raw || raw.length > 1024 * 1024) return;
    try { walk(JSON.parse(raw)); } catch {}
  });
  candidates.sort((a, b) => b.text.length - a.text.length);
  return candidates[0] || { text: '', type: '', title: '', datePublished: '', siteName: '' };
}
function paragraphText(node) {
  if (!node) return { text: '', paragraphCount: 0 };
  const seen = new Set();
  const rows = [];
  node.querySelectorAll('p').forEach(p => {
    const text = clean(p.textContent, 3000);
    if (chars(text) < 20 || DOM_NOISE_RE.test(text)) return;
    const full = clean(p.textContent, 3000);
    const anchor = clean(Array.from(p.querySelectorAll('a')).map(a => a.textContent || '').join(' '), 3000);
    if (full && anchor && chars(anchor) / Math.max(1, chars(full)) > 0.65) return;
    const key = compact(text);
    if (!key || seen.has(key)) return;
    seen.add(key); rows.push(text);
  });
  return { text: clean(rows.join('\n\n'), 100000), paragraphCount: rows.length };
}
function domFallbackText(document) {
  const selectors = [
    '[itemprop="articleBody"]', '[data-article-body]', '#articleBody', '#article-body', '#cmsBody', '#cms-body',
    '.article-body', '.articleBody', '.article_body', '.article__body', '.article-content', '.articleContent',
    '.entry-content', '.post-content', '.story-body', '.news-body', '.content-body', 'article', 'main'
  ];
  let best = { text: '', paragraphCount: 0, selector: '' };
  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach(node => {
      const row = paragraphText(node);
      const score = chars(row.text) + row.paragraphCount * 35 + (selector === 'article' || selector === 'main' ? 0 : 120);
      const bestScore = chars(best.text) + best.paragraphCount * 35 + (best.selector === 'article' || best.selector === 'main' ? 0 : best.selector ? 120 : 0);
      if (score > bestScore) best = { ...row, selector };
    });
  }
  return best;
}
function parseArticleHtml(resource, expectedTitle = '') {
  const dom = new JSDOM(resource.buffer, { url: resource.finalUrl, contentType: 'text/html' });
  let readDom = null;
  try {
    const document = dom.window.document;
    const json = jsonLdArticleInfo(document);
    const htmlTitle = clean(document.querySelector('meta[property="og:title"]')?.getAttribute('content') || document.querySelector('h1')?.textContent || document.title || expectedTitle, 1000);
    const hint = classifyArticleHint({ title: htmlTitle || expectedTitle, url: resource.finalUrl });
    const publishedMeta = Boolean(
      document.querySelector('meta[property="article:published_time"], meta[itemprop="datePublished"], time[itemprop="datePublished"]')
    );
    const articleParagraphs = paragraphText(document.querySelector('article'));
    const strongArticleSignal = ARTICLE_JSONLD_TYPE_RE.test(json.type) || publishedMeta || (articleParagraphs.paragraphCount >= 2 && chars(articleParagraphs.text) >= ARTICLE_MIN_CHARS);

    readDom = new JSDOM(resource.buffer, { url: resource.finalUrl, contentType: 'text/html' });
    readDom.window.document.querySelectorAll('script,style,noscript,iframe,canvas,svg,form,button,input,textarea,select,template').forEach(node => node.remove());
    const reader = new Readability(readDom.window.document, { charThreshold: 120, maxElemsToParse: 0 });
    const readable = reader.parse();
    const readabilityText = clean(readable?.textContent, 100000);
    const domText = domFallbackText(document);
    const jsonText = clean(json.text, 100000);

    const diagnostics = {
      resolvedPublisherUrl: resource.finalUrl,
      htmlBytes: resource.htmlBytes,
      readabilityChars: chars(readabilityText),
      jsonLdChars: chars(jsonText),
      domFallbackChars: chars(domText.text),
      domFallbackSelector: domText.selector,
      pageType: hint.nonArticle && !strongArticleSignal ? 'list' : 'article',
      rejectionReason: hint.nonArticle && !strongArticleSignal ? hint.rejectionReason : ''
    };

    if (hint.nonArticle && !strongArticleSignal) {
      return { ok: false, nonArticle: true, title: htmlTitle, ...diagnostics, extractionMethod: 'rejected-non-article' };
    }

    const choices = [
      { method: 'json-ld', text: jsonText, title: json.title || htmlTitle },
      { method: 'readability', text: readabilityText, title: clean(readable?.title || htmlTitle, 1000) },
      { method: `dom:${domText.selector || 'paragraphs'}`, text: domText.text, title: htmlTitle }
    ].filter(row => chars(row.text) >= ARTICLE_MIN_CHARS).sort((a, b) => chars(b.text) - chars(a.text));
    const best = choices[0];
    if (!best) return { ok: false, nonArticle: false, title: htmlTitle, ...diagnostics, extractionMethod: 'none', rejectionReason: 'article-text-insufficient' };
    return { ok: true, nonArticle: false, title: best.title || htmlTitle, text: best.text, ...diagnostics, extractionMethod: best.method };
  } finally {
    try { readDom?.window?.close(); } catch {}
    dom.window.close();
  }
}

async function prepareFastBody(incoming = {}) {
  const body = { ...incoming, fast: true };
  const title = clean(body.title, 1000);
  const description = clean(body.description, 16000);
  const url = clean(body.url || body.link, 1800);
  const usefulRss = stripRssBoilerplate(description);
  body.rssOriginalChars = chars(description);
  body.rssUsefulChars = chars(usefulRss);

  const hint = classifyArticleHint({ title, url });
  if (hint.nonArticle) {
    return { ...body, description: '', preparedSource: 'non-article', prepareReason: 'non-article-page', pageType: hint.pageType, rejectionReason: hint.rejectionReason, replaceCandidate: isGoogleNewsUrl(url) };
  }

  if (body.rssOnly === true || String(body.rssOnly || '').toLowerCase() === 'true') {
    return { ...body, description: firstChars(usefulRss, 500), preparedSource: usefulRss ? 'rss' : 'missing', prepareReason: usefulRss ? 'reader-rss-only' : 'reader-rss-only-empty' };
  }

  if (fastRssSufficient(title, description)) {
    return { ...body, description: firstChars(usefulRss, 500), preparedSource: 'rss', prepareReason: 'fast-rss-description-sufficient', pageType: 'article-candidate' };
  }

  let publisherUrl = url;
  if (url && isGoogleNewsUrl(url)) {
    const resolved = await resolveSourcePublishedTime(url, { stageTimeoutMs: GOOGLE_RESOLVE_STAGE_TIMEOUT_MS });
    body.publisherResolveMs = Number(resolved?.elapsedMs || 0);
    publisherUrl = clean(resolved?.publisherUrl || '', 1800);
    body.resolvedPublisherUrl = publisherUrl;
    if (publisherUrl) {
      const publisherHint = classifyArticleHint({ title, url: publisherUrl });
      if (publisherHint.nonArticle) {
        return { ...body, description: '', preparedSource: 'non-article', prepareReason: 'non-article-publisher-url', pageType: publisherHint.pageType, rejectionReason: publisherHint.rejectionReason, replaceCandidate: true };
      }
    }
  }

  if (publisherUrl) {
    try {
      const fetched = await fetchPublisherHtml(
        publisherUrl,
        isGoogleNewsUrl(url) ? RESOLVED_PUBLISHER_FETCH_TIMEOUT_MS : DIRECT_PUBLISHER_FETCH_TIMEOUT_MS
      );
      const parsed = parseArticleHtml(fetched, title);
      Object.assign(body, {
        resolvedPublisherUrl: parsed.resolvedPublisherUrl || publisherUrl,
        htmlBytes: parsed.htmlBytes || fetched.htmlBytes,
        readabilityChars: parsed.readabilityChars || 0,
        jsonLdChars: parsed.jsonLdChars || 0,
        domFallbackChars: parsed.domFallbackChars || 0,
        extractionMethod: parsed.extractionMethod || '',
        pageType: parsed.pageType || '',
        rejectionReason: parsed.rejectionReason || ''
      });
      if (parsed.nonArticle) {
        return { ...body, description: '', preparedSource: 'non-article', prepareReason: 'non-article-html', replaceCandidate: isGoogleNewsUrl(url) };
      }
      if (parsed.ok) {
        return { ...body, title: clean(parsed.title || title, 1000) || title, description: firstChars(parsed.text, 500), preparedSource: parsed.extractionMethod?.startsWith('dom:') ? 'article-dom-fallback' : 'article', prepareReason: parsed.extractionMethod?.startsWith('dom:') ? 'article-dom-fallback' : 'article-extracted' };
      }
      body.prepareError = parsed.rejectionReason || '記事本文を抽出できませんでした';
    } catch (error) {
      body.prepareError = clean(error?.message || error, 200);
    }
  } else if (url) {
    body.prepareError = '配信元URLを解決できませんでした';
  }

  const rssFallback = description.length >= 45 && !GENERIC_RE.test(description) ? firstChars(description, 500) : '';
  return {
    ...body,
    description: rssFallback,
    preparedSource: rssFallback ? 'rss-short' : 'missing',
    prepareReason: rssFallback ? 'article-unavailable-rss-fallback' : 'article-and-rss-insufficient',
    pageType: body.pageType || 'article-candidate'
  };
}

function normalizeSentence(value = '') {
  let text = clean(value, 220).replace(/^[・●\-–—\s]+/, '').trim();
  if (!text) return '';
  if (!/[。！？.!?]$/.test(text)) text += '。';
  return text;
}
function sentenceLength(value = '') { return chars(String(value || '').replace(/[。！？.!?]+$/, '')); }
function languageStats(value = '') {
  const text = String(value || '');
  return {
    latin: (text.match(/[A-Za-z]/g) || []).length,
    japanese: (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length,
    kana: (text.match(/[\u3040-\u30ff]/g) || []).length,
    hasJapaneseGrammar: /(?:は|が|を|に|へ|と|で|の|も|や|から|より|です|ます|した|する|され|として|による)/.test(text)
  };
}
export function mostlyEnglish(value = '') {
  const stat = languageStats(value);
  if (stat.japanese >= 8) return false;
  if (stat.japanese >= 4 && stat.hasJapaneseGrammar) return false;
  return stat.latin >= 20 && stat.japanese <= 3;
}
function naturalBoundaryIndex(prefix = '', minIndex = 0) {
  const strong = Math.max(...['。', '！', '？', '!', '?'].map(mark => prefix.lastIndexOf(mark)));
  if (strong >= minIndex) return strong;
  const soft = Math.max(...['、', '，', ',', '；', ';', '：', ':'].map(mark => prefix.lastIndexOf(mark)));
  if (soft >= minIndex) return soft;
  const space = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('　'));
  return space >= minIndex ? space : -1;
}
function compactSentence(value = '') {
  const normalized = normalizeSentence(value);
  if (!normalized) return '';
  const content = normalized.replace(/[。！？.!?]+$/, '').trim();
  const arr = Array.from(content);
  if (arr.length <= SUMMARY_TARGET_MAX_CHARS) return normalized;
  if (arr.length <= SUMMARY_HARD_MAX_CHARS) return normalized;
  const prefix = arr.slice(0, SUMMARY_HARD_MAX_CHARS).join('');
  const boundary = naturalBoundaryIndex(prefix, Math.floor(SUMMARY_HARD_MAX_CHARS * 0.55));
  const clipped = (boundary >= 0 ? prefix.slice(0, boundary + 1) : arr.slice(0, SUMMARY_HARD_MAX_CHARS - 1).join('')).replace(/[。、，,；;：:\s]+$/g, '').trim();
  return `${clipped}。`;
}
function validationError(message, details = {}) {
  const error = new Error(message);
  error.name = 'SummaryValidationError';
  error.repairable = true;
  error.failureStage = 'validation';
  Object.assign(error, details);
  return error;
}
function parseFastJson(raw = '') {
  try { return JSON.parse(String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')); }
  catch (error) {
    const out = new Error(`Gemini JSONを解析できません: ${error?.message || error}`);
    out.name = 'SummaryParseError'; out.repairable = true; out.failureStage = 'parse'; throw out;
  }
}
function buildSummary(row = {}, body = {}, model = '') {
  const lines = [row.c, row.b, row.i].map(normalizeSentence);
  const lengths = lines.map(sentenceLength);
  if (lines.some((line, index) => !line || lengths[index] < SUMMARY_MIN_CHARS)) throw validationError('AI要約の必須項目が不足または短すぎます', { lineLengths: lengths });
  if (lines.some(mostlyEnglish)) throw validationError('AI要約が日本語になっていません', { lineLengths: lengths, languageStats: lines.map(languageStats) });
  const keys = lines.map(line => line.replace(/[\s。、，,.!！?？]/g, '').toLowerCase());
  if (new Set(keys).size !== 3) throw validationError('AI要約が重複しています', { lineLengths: lengths });
  const compacted = lines.map(compactSentence);
  return {
    headline: clean(row.h, 100) || clean(body.title, 100) || '記事のポイント',
    lines: [
      { label: '結論/事実', text: compacted[0] },
      { label: '背景/特徴', text: compacted[1] },
      { label: '影響/展望', text: compacted[2] }
    ],
    short: compacted[0], points: compacted.slice(1),
    provider: 'gemini-structured-v2195', model, contentSource: body.preparedSource || 'prepared',
    cacheable: true, validated: true, fastPath: 'reader-summary-fast-robust',
    lineLengths: compacted.map(sentenceLength)
  };
}
function fastPrompt(body = {}, repairReason = '') {
  const base = [
    `タイトル: ${clean(body.title, 500) || '不明'}`,
    body.source ? `媒体: ${clean(body.source, 160)}` : '',
    body.category ? `カテゴリ: ${clean(body.category, 160)}` : '',
    `記事冒頭（最大${FAST_INPUT_LIMIT}文字）:`, firstChars(body.description, FAST_INPUT_LIMIT), '',
    '上の文章だけを根拠に、日本語で要約してください。',
    'hは16〜32文字。c/b/iは各20〜55文字を目標に1文で、必ず句点で完結させてください。',
    'cは最重要の具体的事実、bは背景・方法・特徴、iは意味・影響・今後を記述してください。',
    '商品名・企業名・型番・規格名（例: Amazon、REDMI Watch、AMOLED、USB Type-C）は原表記の英字のままで構いません。',
    '本文にない推測、一般論、補完は禁止です。'
  ].filter(Boolean);
  if (repairReason) base.push('', '前回のJSONが形式または品質チェックで不採用でした。これが唯一の再生成です。', `不採用理由: ${clean(repairReason, 180)}`, 'h/c/b/iをすべて埋め、3項目を互いに重複しない自然な日本語1文にして、指定JSONだけを返してください。');
  return base.join('\n');
}
function visibleText(data = {}) {
  return (data?.candidates?.[0]?.content?.parts || []).filter(part => part?.thought !== true).map(part => part?.text || '').join('').trim();
}
function requestMeta(body = {}) {
  const articleId = clean(body.articleId, 700);
  const requestType = String(body.requestType || '') === 'prefetch' ? 'prefetch' : 'display';
  const requestId = clean(body.requestId, 240) || `${clean(articleId || body.title || 'article', 80)}-${requestType}-${Date.now()}`;
  return { articleId, requestType, requestId };
}
function actualSentences(value = '') {
  return clean(value, 1800).match(/[^。！？.!?]{10,}[。！？.!?]/g)?.map(normalizeSentence).filter(Boolean) || [];
}
function extractiveFallback(body = {}, reason = 'fallback') {
  const rows = [];
  const seen = new Set();
  for (const sentence of actualSentences(body.description)) {
    if (mostlyEnglish(sentence)) continue;
    const key = compact(sentence);
    if (!key || seen.has(key)) continue;
    seen.add(key); rows.push(compactSentence(sentence));
    if (rows.length >= 3) break;
  }
  if (rows.length < 3) return { headline: clean(body.title, 100) || '記事のポイント', lines: [], short: '', points: [], provider: 'unavailable', model: '', contentSource: body.preparedSource || 'missing', cacheable: false, validated: false, fallbackReason: reason };
  return { headline: clean(body.title, 100) || '記事のポイント', lines: [{ label: '結論/事実', text: rows[0] }, { label: '背景/特徴', text: rows[1] }, { label: '影響/展望', text: rows[2] }], short: rows[0], points: rows.slice(1), provider: 'extractive-v2195', model: '', contentSource: body.preparedSource || 'prepared', cacheable: false, validated: true, fallbackReason: reason, lineLengths: rows.map(sentenceLength) };
}

async function callGeminiOnce(body, meta, { repairReason = '' } = {}) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw Object.assign(new Error('GEMINI_API_KEY が設定されていません'), { failureStage: 'config' });
  const slot = await waitForGeminiStartSlot({ requestType: meta.requestType, requestId: meta.requestId });
  const queueWaitMs = Number(slot?.queueWaitMs || 0);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FAST_MODEL_TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(PRIMARY_MODEL)}:generateContent`, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: fastPrompt(body, repairReason) }] }],
        generationConfig: { maxOutputTokens: FAST_OUTPUT_TOKEN_LIMIT, thinkingConfig: { thinkingLevel: 'minimal' }, responseMimeType: 'application/json', responseJsonSchema: fastSchema }
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data?.error?.message || `Gemini single ${response.status}`), { statusCode: response.status, failureStage: 'gemini-api' });
    const raw = visibleText(data);
    if (!raw) throw Object.assign(new Error('Gemini single response empty'), { repairable: true, failureStage: 'response' });
    const summary = buildSummary(parseFastJson(raw), body, PRIMARY_MODEL);
    return { summary, attempt: { model: PRIMARY_MODEL, status: response.status, ok: true, elapsedMs: Date.now() - started, queueWaitMs, repair: Boolean(repairReason), failureStage: 'none' } };
  } catch (error) {
    if (error?.name === 'AbortError') error.failureStage = 'gemini-timeout';
    error.attempt = { model: PRIMARY_MODEL, status: Number(error?.statusCode || 0), ok: false, elapsedMs: Date.now() - started, queueWaitMs, repair: Boolean(repairReason), failureStage: error?.failureStage || 'gemini', errorName: error?.name || 'Error', errorMessage: String(error?.message || error) };
    throw error;
  } finally { clearTimeout(timer); }
}

async function generateFastSummary(body = {}) {
  const meta = requestMeta(body);
  const attempts = [];
  if (chars(clean(body.description)) < 40) {
    const summary = extractiveFallback(body, body.preparedSource === 'non-article' ? 'non-article-page' : 'prepared-text-too-short');
    return attachDiagnostics(summary, body, meta, attempts, body.preparedSource === 'non-article' ? 'non-article' : 'prepare');
  }
  let firstError = null;
  try {
    const first = await callGeminiOnce(body, meta);
    attempts.push(first.attempt);
    return attachDiagnostics(first.summary, body, meta, attempts, 'none');
  } catch (error) {
    firstError = error; attempts.push(error.attempt || {});
  }
  if (firstError?.repairable === true) {
    try {
      const repaired = await callGeminiOnce(body, meta, { repairReason: String(firstError?.message || firstError) });
      attempts.push(repaired.attempt);
      const result = attachDiagnostics(repaired.summary, body, meta, attempts, 'none');
      result.repaired = true;
      return result;
    } catch (error) {
      attempts.push(error.attempt || {});
      const fallback = extractiveFallback(body, String(error?.message || error));
      return attachDiagnostics(fallback, body, meta, attempts, error?.failureStage || 'validation');
    }
  }
  const fallback = extractiveFallback(body, String(firstError?.message || firstError || 'gemini-failed'));
  return attachDiagnostics(fallback, body, meta, attempts, firstError?.failureStage || 'gemini');
}
function attachDiagnostics(summary, body, meta, attempts, failureStage) {
  const queueWaitMs = attempts.reduce((sum, row) => sum + (Number(row?.queueWaitMs) || 0), 0);
  const geminiMs = attempts.reduce((sum, row) => sum + (Number(row?.elapsedMs) || 0), 0);
  return {
    ...summary,
    articleId: meta.articleId, requestId: meta.requestId, requestType: meta.requestType,
    upstreamStatus: Number(attempts.at(-1)?.status || 0), queueWaitMs,
    articlePrepareMs: Number(body.articlePrepareMs || 0), geminiMs,
    preparedSource: body.preparedSource || summary?.contentSource || 'missing', preparedChars: chars(clean(body.description)),
    lineLengths: Array.isArray(summary?.lineLengths) ? summary.lineLengths : [], failureStage: failureStage || 'none',
    repaired: attempts.some(row => row?.repair && row?.ok),
    resolvedPublisherUrl: body.resolvedPublisherUrl || '', htmlBytes: Number(body.htmlBytes || 0),
    readabilityChars: Number(body.readabilityChars || 0), jsonLdChars: Number(body.jsonLdChars || 0), domFallbackChars: Number(body.domFallbackChars || 0),
    extractionMethod: body.extractionMethod || '', pageType: body.pageType || '', rejectionReason: body.rejectionReason || '',
    rssOriginalChars: Number(body.rssOriginalChars || 0), rssUsefulChars: Number(body.rssUsefulChars || 0), replaceCandidate: Boolean(body.replaceCandidate),
    prepareReason: body.prepareReason || '', prepareError: body.prepareError || '',
    geminiAttempts: attempts.map(row => ({ model: row?.model || '', status: Number(row?.status || 0), ok: Boolean(row?.ok), elapsedMs: Number(row?.elapsedMs || 0), queueWaitMs: Number(row?.queueWaitMs || 0), repair: Boolean(row?.repair), failureStage: row?.failureStage || '', errorName: row?.errorName || '', errorMessage: clean(row?.errorMessage || '', 260) }))
  };
}
function setDiagHeaders(res, summary = {}) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Summary-Route', 'reader-summary-fast-robust');
  res.setHeader('X-Summary-Queue-Wait-Ms', String(summary.queueWaitMs || 0));
  res.setHeader('X-Summary-Article-Prepare-Ms', String(summary.articlePrepareMs || 0));
  res.setHeader('X-Summary-Gemini-Ms', String(summary.geminiMs || 0));
  res.setHeader('X-Summary-Prepared-Chars', String(summary.preparedChars || 0));
  setAsciiHeader(res, 'X-Summary-Model', summary.model || '');
  setAsciiHeader(res, 'X-Summary-Prepared-Source', summary.preparedSource || '');
  setAsciiHeader(res, 'X-Summary-Failure-Stage', summary.failureStage || 'none');
  setAsciiHeader(res, 'X-Summary-Extraction-Method', summary.extractionMethod || '');
  setAsciiHeader(res, 'X-Summary-Page-Type', summary.pageType || '');
  setAsciiHeader(res, 'X-Summary-Rejection-Reason', summary.rejectionReason || '');
}

export default async function handler(req, res) {
  const incoming = rawBody(req);
  const specialQuery = String(req.query?.technologyResearch || '') === '1' || String(req.query?.paperTitles || '') === '1' || String(req.query?.diagnostic || '') || String(req.query?.batch || '') === '1' || String(req.query?.stream || '') === '1';
  const technologyResearch = /技術リサーチ:\s*Web調査済み/.test(String(incoming.description || ''));
  if (req.method !== 'POST' || specialQuery || technologyResearch || !isFastReaderRequest(incoming)) return legacySummary(req, res);

  const started = Date.now();
  const prepared = await prepareFastBody(incoming);
  prepared.articlePrepareMs = Date.now() - started;
  const summary = await generateFastSummary(prepared);
  setDiagHeaders(res, summary);
  console.info('[SUMMARY DIAG]', {
    requestId: summary.requestId, articleId: summary.articleId, requestType: summary.requestType,
    provider: summary.provider, model: summary.model, queueWaitMs: summary.queueWaitMs,
    articlePrepareMs: summary.articlePrepareMs, geminiMs: summary.geminiMs,
    preparedSource: summary.preparedSource, preparedChars: summary.preparedChars,
    lineLengths: summary.lineLengths, failureStage: summary.failureStage, repaired: summary.repaired,
    resolvedPublisherUrl: summary.resolvedPublisherUrl, htmlBytes: summary.htmlBytes,
    readabilityChars: summary.readabilityChars, jsonLdChars: summary.jsonLdChars, domFallbackChars: summary.domFallbackChars,
    extractionMethod: summary.extractionMethod, pageType: summary.pageType, rejectionReason: summary.rejectionReason,
    rssOriginalChars: summary.rssOriginalChars, rssUsefulChars: summary.rssUsefulChars,
    replaceCandidate: summary.replaceCandidate, fallbackReason: summary.fallbackReason || '', prepareError: summary.prepareError || ''
  });
  return res.status(200).json(summary);
}
