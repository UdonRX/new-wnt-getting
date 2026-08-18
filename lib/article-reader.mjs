import dns from 'node:dns/promises';
import net from 'node:net';
import readabilityPackage from '@mozilla/readability';
import jsdomPackage from 'jsdom';

const { Readability } = readabilityPackage;
const { JSDOM } = jsdomPackage;

const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_PDF_BYTES = 24 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 14000;
const FETCH_PROFILE_RETRY_STATUSES = new Set([403, 406, 408, 418, 429, 500, 502, 503, 504]);
const PDF_MAGIC_SCAN_BYTES = 4096;
const DEFAULT_MAX_TEXT_LENGTH = 60000;
const MAX_PDF_TEXT_LENGTH = 180000;
const MAX_PDF_PAGES = 80;
const PDF_PAGE_CONCURRENCY = 4;
const MIN_ARTICLE_LENGTH = 180;

const articleCache = new Map();
const ARTICLE_CACHE_TTL_MS = 20 * 60 * 1000;
const ARTICLE_CACHE_MAX = 40;

// Google News RSS の /rss/articles/... は出版社URLそのものではなく、
// Googleの中間ページ。解決結果をキャッシュして同じ記事で毎回
// batchexecuteを呼ばないようにする。
const googleNewsUrlCache = new Map();
const GOOGLE_NEWS_URL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const GOOGLE_NEWS_URL_CACHE_MAX = 200;
const GOOGLE_NEWS_RESOLVE_TIMEOUT_MS = 10000;
const GOOGLE_NEWS_BATCH_MAX_BYTES = 1024 * 1024;

function normalizeText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isPrivateIPv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIPv6(address) {
  const value = address.toLowerCase().split('%')[0];
  if (value === '::' || value === '::1') return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(value)) return true;
  if (value.startsWith('2001:db8:')) return true;
  if (value.startsWith('ff')) return true;
  if (value.startsWith('::ffff:')) return true;
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true;
}

async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('記事URLが不正です');
  }

  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('記事URLのプロトコルが許可されていません');
  if (url.username || url.password) throw new Error('認証情報を含むURLは取得できません');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('通常以外のポートは取得できません');

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('ローカルネットワークのURLは取得できません');
  }

  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('プライベートIPは取得できません');
  } else {
    let addresses;
    try {
      addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error('記事サイトの名前解決に失敗しました');
    }
    if (!addresses.length || addresses.some(entry => isPrivateAddress(entry.address))) {
      throw new Error('取得先が安全な公開アドレスではありません');
    }
  }

  return url;
}

async function readResponseBufferLimited(response, maxBytes, label) {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maxBytes) throw new Error(`${label}が大きすぎます`);

  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`${label}が大きすぎます`);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new Error(`${label}が大きすぎます`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  return Buffer.concat(chunks);
}

function getContentDispositionFilename(contentDisposition) {
  const raw = String(contentDisposition || '');
  if (!raw) return '';

  const utf8 = raw.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8?.[1]) {
    try { return decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, '')); } catch {}
  }

  const normal = raw.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  return String(normal?.[1] || normal?.[2] || '').trim();
}

function contentDispositionLooksPdf(contentDisposition) {
  return /\.pdf(?:$|[?#])/i.test(getContentDispositionFilename(contentDisposition));
}

function contentTypeLooksPdf(contentType) {
  const type = String(contentType || '').toLowerCase().split(';')[0].trim();
  return [
    'application/pdf',
    'application/x-pdf',
    'application/acrobat',
    'applications/vnd.pdf',
    'text/pdf'
  ].includes(type);
}

function contentTypeLooksBinaryDownload(contentType) {
  const type = String(contentType || '').toLowerCase().split(';')[0].trim();
  return [
    'application/octet-stream',
    'binary/octet-stream',
    'application/download',
    'application/x-download',
    'application/force-download'
  ].includes(type);
}

function urlLooksPdf(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /\.pdf(?:$|[?#])/i.test(url.pathname + url.search);
  } catch {
    return false;
  }
}

function bufferLooksLikePdf(buffer) {
  if (!buffer?.length) return false;
  const head = buffer.subarray(0, Math.min(buffer.length, PDF_MAGIC_SCAN_BYTES));
  return head.indexOf(Buffer.from('%PDF-')) >= 0;
}

function bufferLooksLikeHtml(buffer) {
  if (!buffer?.length) return false;
  const head = buffer.subarray(0, Math.min(buffer.length, 2048)).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml') || head.includes('<head');
}

function buildAcademicFetchProfiles(currentUrl, acceptPdf) {
  let referer = '';
  try {
    const u = new URL(currentUrl);
    referer = `${u.protocol}//${u.host}/`;
  } catch {}

  const accept = acceptPdf
    ? 'application/pdf,application/xhtml+xml,text/html;q=0.9,application/xml;q=0.8,*/*;q=0.7'
    : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.7';

  return [
    {
      'Accept': accept,
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      'Upgrade-Insecure-Requests': '1',
      ...(referer ? { 'Referer': referer } : {})
    },
    {
      'Accept': accept,
      'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
      ...(referer ? { 'Referer': referer } : {})
    }
  ];
}

async function fetchWithAcademicBrowserFallback(currentUrl, acceptPdf) {
  const profiles = buildAcademicFetchProfiles(currentUrl.href, acceptPdf);
  let lastError = null;
  let lastResponse = null;

  for (let i = 0; i < profiles.length; i += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: profiles[i]
      });

      lastResponse = response;

      // 学術サイトではBot判定で403/406になることがある。
      // その場合だけ別の実ブラウザ相当UAで1回再試行する。
      if (FETCH_PROFILE_RETRY_STATUSES.has(response.status) && i < profiles.length - 1) {
        try { await response.body?.cancel?.(); } catch {}
        continue;
      }

      return response;
    } catch (err) {
      lastError = err;
      if (i >= profiles.length - 1) break;
    } finally {
      clearTimeout(timeout);
    }
  }

  if (lastResponse) return lastResponse;
  if (lastError?.name === 'AbortError') throw new Error('記事取得がタイムアウトしました');
  throw new Error('記事ページを取得できませんでした');
}

async function fetchResourceSafely(rawUrl, { acceptPdf = true } = {}) {
  let currentUrl = await assertPublicUrl(rawUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    let response;

    try {
      response = await fetchWithAcademicBrowserFallback(currentUrl, acceptPdf);
    } catch (err) {
      if (err?.message) throw err;
      throw new Error('記事ページを取得できませんでした');
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('リダイレクト先がありません');
      if (redirectCount >= MAX_REDIRECTS) throw new Error('リダイレクトが多すぎます');
      try { await response.body?.cancel?.(); } catch {}
      currentUrl = await assertPublicUrl(new URL(location, currentUrl).href);
      continue;
    }

    if (!response.ok) {
      throw new Error(`記事ページの取得に失敗しました (${response.status})`);
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const contentDisposition = response.headers.get('content-disposition') || '';
    const pdfByUrl = urlLooksPdf(currentUrl.href);
    const pdfByType = contentTypeLooksPdf(contentType);
    const pdfByDisposition = contentDispositionLooksPdf(contentDisposition);
    const binaryDownload = contentTypeLooksBinaryDownload(contentType);

    // 拡張子なしdownload URLやapplication/octet-streamは、HTML上限4MBで
    // 先に切らずPDF上限まで読んで実体シグネチャを確認する。
    const readLimit = acceptPdf && (pdfByUrl || pdfByType || pdfByDisposition || binaryDownload)
      ? MAX_PDF_BYTES
      : MAX_HTML_BYTES;

    const buffer = await readResponseBufferLimited(
      response,
      readLimit,
      acceptPdf && (pdfByUrl || pdfByType || pdfByDisposition || binaryDownload) ? 'PDF/ダウンロードファイル' : '記事HTML'
    );

    // 最優先はファイル実体。Content-Typeや拡張子が誤っていても
    // PDFヘッダ %PDF- があればPDFとして扱う。
    const pdfByMagic = bufferLooksLikePdf(buffer);
    const htmlByMagic = bufferLooksLikeHtml(buffer);

    if (acceptPdf && pdfByMagic) {
      return {
        kind: 'pdf',
        buffer,
        finalUrl: currentUrl.href,
        contentType,
        contentDisposition,
        pdfDetection: 'magic'
      };
    }

    // 明示PDFヘッダ/filename/.pdf URLもサポート。ただし実体がHTMLなら
    // アクセス拒否ページをPDF.jsへ渡さない。
    if (acceptPdf && !htmlByMagic && (pdfByType || pdfByDisposition || pdfByUrl)) {
      return {
        kind: 'pdf',
        buffer,
        finalUrl: currentUrl.href,
        contentType,
        contentDisposition,
        pdfDetection: pdfByType ? 'content-type' : pdfByDisposition ? 'content-disposition' : 'url'
      };
    }

    if (
      contentType &&
      !contentType.includes('text/html') &&
      !contentType.includes('application/xhtml+xml') &&
      !htmlByMagic
    ) {
      const typeLabel = contentType.split(';')[0] || '不明';
      throw new Error(`記事リンクの実体がHTML/PDFではありません (${typeLabel})`);
    }

    if (buffer.length > MAX_HTML_BYTES) {
      throw new Error('記事HTMLが大きすぎます');
    }

    return {
      kind: 'html',
      buffer,
      finalUrl: currentUrl.href,
      contentType,
      contentDisposition
    };
  }

  throw new Error('記事ページを取得できませんでした');
}

function isGoogleNewsArticleUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    const host = url.hostname.toLowerCase();
    if (host !== 'news.google.com') return false;
    return (
      url.pathname.startsWith('/rss/articles/') ||
      url.pathname.startsWith('/articles/') ||
      url.pathname.startsWith('/read/')
    );
  } catch {
    return false;
  }
}

function isGoogleOwnedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return (
    host === 'google.com' ||
    host.endsWith('.google.com') ||
    host === 'gstatic.com' ||
    host.endsWith('.gstatic.com') ||
    host === 'googleusercontent.com' ||
    host.endsWith('.googleusercontent.com')
  );
}

function getGoogleNewsUrlCache(rawUrl) {
  const entry = googleNewsUrlCache.get(rawUrl);
  if (!entry) return '';
  if (Date.now() - entry.createdAt > GOOGLE_NEWS_URL_CACHE_TTL_MS) {
    googleNewsUrlCache.delete(rawUrl);
    return '';
  }
  googleNewsUrlCache.delete(rawUrl);
  googleNewsUrlCache.set(rawUrl, entry);
  return entry.url;
}

function setGoogleNewsUrlCache(rawUrl, resolvedUrl) {
  if (!rawUrl || !resolvedUrl) return;
  if (googleNewsUrlCache.has(rawUrl)) googleNewsUrlCache.delete(rawUrl);
  googleNewsUrlCache.set(rawUrl, { createdAt: Date.now(), url: resolvedUrl });
  while (googleNewsUrlCache.size > GOOGLE_NEWS_URL_CACHE_MAX) {
    const oldestKey = googleNewsUrlCache.keys().next().value;
    if (!oldestKey) break;
    googleNewsUrlCache.delete(oldestKey);
  }
}

function normalizeGoogleResolvedCandidate(rawUrl) {
  const text = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(text)) return '';

  try {
    let url = new URL(text);

    // GoogleのラッパーURLが返るケースでは実URLパラメータを先に展開する。
    if (isGoogleOwnedHost(url.hostname)) {
      const wrapped = url.searchParams.get('url') || url.searchParams.get('q');
      if (wrapped && /^https?:\/\//i.test(wrapped)) url = new URL(wrapped);
    }

    if (isGoogleOwnedHost(url.hostname)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function parseGoogleBatchexecuteResponse(rawText) {
  const text = String(rawText || '').replace(/^\)\]\}'\s*/, '').trim();
  if (!text) return '';

  const parsedRoots = [];
  try {
    parsedRoots.push(JSON.parse(text));
  } catch {
    // batchexecuteはレスポンス先頭にサイズ行を含むことがあるため、
    // JSON配列らしい行を個別に解析する。
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('[')) continue;
      try { parsedRoots.push(JSON.parse(trimmed)); } catch {}
    }
  }

  let resolved = '';

  function walk(value) {
    if (resolved || value == null) return;

    if (Array.isArray(value)) {
      // 現行Google NewsのURL解決RPC。3要素目がJSON文字列で、
      // その配列のindex=1に出版社URLが入る。
      if (value[1] === 'Fbv4je' && typeof value[2] === 'string') {
        try {
          const payload = JSON.parse(value[2]);
          const candidate = normalizeGoogleResolvedCandidate(payload?.[1]);
          if (candidate) {
            resolved = candidate;
            return;
          }
        } catch {}
      }
      value.forEach(walk);
      return;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if ((trimmed.startsWith('[') || trimmed.startsWith('{')) && trimmed.length < GOOGLE_NEWS_BATCH_MAX_BYTES) {
        try { walk(JSON.parse(trimmed)); } catch {}
      }
    }
  }

  parsedRoots.forEach(walk);
  return resolved;
}

async function postGoogleNewsBatchexecute(dataP, refererUrl) {
  const source = String(dataP || '').trim();
  if (!source) throw new Error('GoogleニュースURL解決情報がありません');

  let requestObject;
  try {
    // Google News中間ページのdata-pは %.@. から始まる独自表現。
    // garturlreq配列へ戻してURL解決RPCへ渡す。
    const jsonText = source.includes('%.@.')
      ? source.replace('%.@.', '["garturlreq",')
      : source;
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed) || parsed.length < 8) throw new Error('invalid data-p');
    requestObject = [...parsed.slice(0, -6), ...parsed.slice(-2)];
  } catch {
    throw new Error('GoogleニュースURL解決情報を解析できません');
  }

  const fReq = JSON.stringify([[['Fbv4je', JSON.stringify(requestObject), 'null', 'generic']]]);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOOGLE_NEWS_RESOLVE_TIMEOUT_MS);

  let response;
  try {
    response = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Accept': '*/*',
        'Accept-Language': 'ja,en-US;q=0.8,en;q=0.6',
        'Origin': 'https://news.google.com',
        'Referer': refererUrl || 'https://news.google.com/',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
      },
      body: new URLSearchParams({ 'f.req': fReq }).toString()
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('GoogleニュースURL解決がタイムアウトしました');
    throw new Error('GoogleニュースURL解決APIへ接続できませんでした');
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) throw new Error(`GoogleニュースURL解決に失敗しました (${response.status})`);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > GOOGLE_NEWS_BATCH_MAX_BYTES) throw new Error('GoogleニュースURL解決応答が大きすぎます');

  const text = await response.text();
  if (text.length > GOOGLE_NEWS_BATCH_MAX_BYTES) throw new Error('GoogleニュースURL解決応答が大きすぎます');

  const resolved = parseGoogleBatchexecuteResponse(text);
  if (!resolved) throw new Error('Googleニュースから配信元URLを取得できませんでした');
  return resolved;
}

async function resolveGoogleNewsPublisherUrl(rawUrl) {
  const originalUrl = String(rawUrl || '').trim();
  if (!isGoogleNewsArticleUrl(originalUrl)) return originalUrl;

  const cached = getGoogleNewsUrlCache(originalUrl);
  if (cached) return cached;

  // まず通常のHTTPリダイレクトを試す。Googleが将来通常の3xxへ戻しても
  // ここだけで出版社URLへ到達できる。
  const googlePage = await fetchResourceSafely(originalUrl, { acceptPdf: false });
  const redirectedCandidate = normalizeGoogleResolvedCandidate(googlePage.finalUrl);
  if (redirectedCandidate) {
    await assertPublicUrl(redirectedCandidate);
    setGoogleNewsUrlCache(originalUrl, redirectedCandidate);
    return redirectedCandidate;
  }

  if (googlePage.kind !== 'html') throw new Error('Googleニュース中間ページを取得できませんでした');

  const dom = new JSDOM(googlePage.buffer, { url: googlePage.finalUrl, contentType: 'text/html' });
  try {
    // JSを実行せず、Googleの中間ページが持つURL解決用data-pだけを読む。
    const dataP = dom.window.document.querySelector('c-wiz[data-p]')?.getAttribute('data-p') || '';
    const resolved = await postGoogleNewsBatchexecute(dataP, googlePage.finalUrl);
    const safe = await assertPublicUrl(resolved);
    setGoogleNewsUrlCache(originalUrl, safe.href);
    return safe.href;
  } finally {
    dom.window.close();
  }
}

function collectJsonLdCandidates(value, output) {
  if (!value) return;
  if (Array.isArray(value)) {
    value.forEach(item => collectJsonLdCandidates(item, output));
    return;
  }
  if (typeof value !== 'object') return;

  const articleBody = normalizeText(value.articleBody);
  if (articleBody.length >= MIN_ARTICLE_LENGTH) {
    output.push({
      text: articleBody,
      title: normalizeText(value.headline || value.name),
      byline: normalizeText(
        typeof value.author === 'string'
          ? value.author
          : Array.isArray(value.author)
            ? value.author.map(author => author?.name || '').filter(Boolean).join(', ')
            : value.author?.name || ''
      ),
      publishedTime: normalizeText(value.datePublished),
      siteName: normalizeText(value.publisher?.name)
    });
  }

  Object.values(value).forEach(child => {
    if (child && typeof child === 'object') collectJsonLdCandidates(child, output);
  });
}

function extractBestJsonLdArticle(document) {
  const candidates = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
    const raw = script.textContent || '';
    if (!raw || raw.length > 1024 * 1024) return;
    try { collectJsonLdCandidates(JSON.parse(raw), candidates); } catch {}
  });
  candidates.sort((a, b) => b.text.length - a.text.length);
  return candidates[0] || null;
}

function parseArticle(htmlBuffer, pageUrl, maxTextLength) {
  const dom = new JSDOM(htmlBuffer, { url: pageUrl, contentType: 'text/html' });

  try {
    const document = dom.window.document;
    const jsonLdArticle = extractBestJsonLdArticle(document);

    document.querySelectorAll([
      'script', 'style', 'noscript', 'iframe', 'canvas', 'svg',
      'form', 'button', 'input', 'textarea', 'select', 'template'
    ].join(',')).forEach(node => node.remove());

    const reader = new Readability(document, { charThreshold: 120, maxElemsToParse: 0 });
    const article = reader.parse();
    const readabilityText = normalizeText(article?.textContent);
    const jsonLdText = normalizeText(jsonLdArticle?.text);
    const useJsonLd = jsonLdText.length > readabilityText.length;
    const text = useJsonLd ? jsonLdText : readabilityText;

    if (text.length < MIN_ARTICLE_LENGTH) throw new Error('記事本文を抽出できませんでした');

    return {
      title: normalizeText(useJsonLd ? (jsonLdArticle?.title || article?.title) : (article?.title || jsonLdArticle?.title)).slice(0, 1000),
      text: text.slice(0, maxTextLength),
      byline: normalizeText(useJsonLd ? (jsonLdArticle?.byline || article?.byline) : (article?.byline || jsonLdArticle?.byline)).slice(0, 500),
      siteName: normalizeText(useJsonLd ? (jsonLdArticle?.siteName || article?.siteName) : (article?.siteName || jsonLdArticle?.siteName)).slice(0, 500),
      excerpt: normalizeText(article?.excerpt).slice(0, 1500),
      publishedTime: normalizeText(useJsonLd ? (jsonLdArticle?.publishedTime || article?.publishedTime) : (article?.publishedTime || jsonLdArticle?.publishedTime)).slice(0, 200),
      url: pageUrl,
      sourceType: 'html',
      extractionMethod: useJsonLd ? 'json-ld' : 'readability',
      originalLength: text.length,
      truncated: text.length > maxTextLength,
      pageCount: 0,
      pages: []
    };
  } finally {
    dom.window.close();
  }
}

function findArticlePdfUrl(htmlBuffer, pageUrl) {
  let page;
  try { page = new URL(pageUrl); } catch { return ''; }

  const dom = new JSDOM(htmlBuffer, { url: pageUrl, contentType: 'text/html' });
  try {
    const document = dom.window.document;
    const candidates = [];

    // 学術サイトで広く使われるHighwire/Google Scholar系メタタグ。
    document.querySelectorAll(
      'meta[name="citation_pdf_url"], meta[property="citation_pdf_url"], meta[name="wkhealth_pdf_url"], meta[name="eprints.document_url"]'
    ).forEach(meta => {
      const value = meta.getAttribute('content') || '';
      if (value) candidates.push(value);
    });

    document.querySelectorAll('link[type="application/pdf"][href], link[rel="alternate"][type="application/pdf"][href], a[href]').forEach(node => {
      const href = node.getAttribute('href') || '';
      const label = normalizeText(`${node.textContent || ''} ${node.getAttribute('title') || ''} ${node.getAttribute('aria-label') || ''}`).toLowerCase();
      if (
        /\.pdf(?:$|[?#])/i.test(href) ||
        /\bpdf\b|download pdf|pdf download|pdfをダウンロード|全文pdf|full\s*text\s*pdf/i.test(label) ||
        /\/_pdf\//i.test(href)
      ) {
        candidates.push(href);
      }
    });

    // J-STAGEだけは既知のURL変換も補助的に使う。
    if (/(^|\.)jstage\.jst\.go\.jp$/i.test(page.hostname) && page.pathname.includes('/_article/')) {
      candidates.push(pageUrl.replace('/_article/', '/_pdf/'));
    }

    for (const candidate of candidates) {
      try {
        const resolved = new URL(candidate, pageUrl);
        if (!/^https?:$/i.test(resolved.protocol)) continue;
        return resolved.href;
      } catch {}
    }
    return '';
  } finally {
    dom.window.close();
  }
}

let pdfJsNodePolyfillsPromise = null;
let pdfJsModulePromise = null;

async function ensurePdfJsNodePolyfills() {
  // PDF.js 5/6系のNode legacy buildはimport時にもDOMMatrix等を参照する。
  // Node.js 22にはこれらのWeb APIが標準では存在しないため、
  // @napi-rs/canvasの実装をglobalThisへ明示的に登録してからPDF.jsを読む。
  if (
    typeof globalThis.DOMMatrix !== 'undefined' &&
    typeof globalThis.ImageData !== 'undefined' &&
    typeof globalThis.Path2D !== 'undefined'
  ) {
    return;
  }

  if (!pdfJsNodePolyfillsPromise) {
    pdfJsNodePolyfillsPromise = (async () => {
      let canvas;
      try {
        canvas = await import('@napi-rs/canvas');
      } catch (err) {
        console.error('[article-reader] @napi-rs/canvas import failed:', err);
        throw new Error(
          'PDF解析用のDOM互換機能を読み込めませんでした。package.jsonの @napi-rs/canvas を確認してください'
        );
      }

      if (typeof globalThis.DOMMatrix === 'undefined' && canvas.DOMMatrix) {
        globalThis.DOMMatrix = canvas.DOMMatrix;
      }
      if (typeof globalThis.ImageData === 'undefined' && canvas.ImageData) {
        globalThis.ImageData = canvas.ImageData;
      }
      if (typeof globalThis.Path2D === 'undefined' && canvas.Path2D) {
        globalThis.Path2D = canvas.Path2D;
      }

      const missing = [];
      if (typeof globalThis.DOMMatrix === 'undefined') missing.push('DOMMatrix');
      if (typeof globalThis.ImageData === 'undefined') missing.push('ImageData');
      if (typeof globalThis.Path2D === 'undefined') missing.push('Path2D');

      if (missing.length) {
        throw new Error(`PDF解析用DOM互換機能が不足しています: ${missing.join(', ')}`);
      }
    })().catch(err => {
      // 一時的なロード失敗後に再試行できるようPromiseを戻す。
      pdfJsNodePolyfillsPromise = null;
      throw err;
    });
  }

  return pdfJsNodePolyfillsPromise;
}

async function loadPdfJsForNode() {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = (async () => {
      await ensurePdfJsNodePolyfills();

      /*
       * Vercel(Serverless)対策:
       * PDF.jsはNode.jsでは実Workerを使わずfake workerを使う。
       * その際、通常はpdf.worker.mjsを実行時に動的importするが、
       * Serverless bundlerがそのworkerファイルを配置しないケースがあり、
       * "Setting up fake worker failed: Cannot find module ...pdf.worker.mjs"
       * になる。
       *
       * workerをここで「固定文字列のimport」として先に読み込み、
       * PDF.jsが公式に参照するglobalThis.pdfjsWorkerへ登録することで、
       * PDF.js自身の実行時worker探索を発生させない。
       * 固定importなのでVercelの依存トレーサーにもworkerが認識される。
       */
      const workerModule = await import(
        'pdfjs-dist/legacy/build/pdf.worker.mjs'
      );

      if (
        !workerModule?.WorkerMessageHandler ||
        typeof workerModule.WorkerMessageHandler.setup !== 'function'
      ) {
        throw new Error(
          'PDF.js workerモジュールを読み込めませんでした（WorkerMessageHandlerなし）'
        );
      }

      globalThis.pdfjsWorker = {
        WorkerMessageHandler: workerModule.WorkerMessageHandler
      };

      const pdfjs = await import(
        'pdfjs-dist/legacy/build/pdf.mjs'
      );

      return pdfjs;
    })().catch(err => {
      pdfJsModulePromise = null;

      // 壊れた途中状態を次回へ持ち越さない。
      try { delete globalThis.pdfjsWorker; } catch {}

      throw err;
    });
  }
  return pdfJsModulePromise;
}

async function extractPdfText(pdfBuffer, pdfUrl) {
  const pdfjs = await loadPdfJsForNode();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    useWorkerFetch: false,
    useWasm: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    stopAtErrors: false
  });

  let pdf;
  try {
    pdf = await loadingTask.promise;
    const pageCount = Math.min(pdf.numPages || 0, MAX_PDF_PAGES);
    const pages = new Array(pageCount);

    for (let start = 1; start <= pageCount; start += PDF_PAGE_CONCURRENCY) {
      const pageNumbers = [];
      for (let n = start; n < start + PDF_PAGE_CONCURRENCY && n <= pageCount; n += 1) pageNumbers.push(n);

      const batch = await Promise.all(pageNumbers.map(async pageNumber => {
        const page = await pdf.getPage(pageNumber);
        try {
          const textContent = await page.getTextContent({ includeMarkedContent: false });
          let raw = '';
          for (const item of textContent.items || []) {
            if (!item || typeof item.str !== 'string') continue;
            raw += item.str;
            raw += item.hasEOL ? '\n' : ' ';
          }
          return { pageNumber, text: normalizeText(raw) };
        } finally {
          try { page.cleanup(); } catch {}
        }
      }));

      batch.forEach(({ pageNumber, text }) => { pages[pageNumber - 1] = text; });
    }

    const usablePages = pages
      .map((text, i) => ({ pageNumber: i + 1, text: normalizeText(text) }))
      .filter(page => page.text.length >= 10);

    const fullText = normalizeText(
      usablePages.map(page => `[PDF ${page.pageNumber}ページ]\n${page.text}`).join('\n\n')
    );

    if (fullText.length < MIN_ARTICLE_LENGTH) throw new Error('PDFから文字を抽出できませんでした（画像PDFの可能性があります）');

    let metadata = null;
    try { metadata = await pdf.getMetadata(); } catch {}
    const pdfTitle = normalizeText(metadata?.info?.Title || metadata?.metadata?.get?.('dc:title') || '');

    return {
      title: pdfTitle.slice(0, 1000),
      text: fullText.slice(0, MAX_PDF_TEXT_LENGTH),
      byline: normalizeText(metadata?.info?.Author || '').slice(0, 500),
      siteName: (() => { try { return `${new URL(pdfUrl).hostname} PDF`; } catch { return 'PDF'; } })(),
      excerpt: '',
      publishedTime: '',
      url: pdfUrl,
      pdfUrl,
      sourceType: 'pdf',
      extractionMethod: 'pdfjs',
      originalLength: fullText.length,
      truncated: fullText.length > MAX_PDF_TEXT_LENGTH || (pdf.numPages || 0) > MAX_PDF_PAGES,
      pageCount: pdf.numPages || pageCount,
      extractedPageCount: pageCount,
      pages: usablePages
    };
  } finally {
    try { await pdf?.cleanup?.(); } catch {}
    try { await loadingTask.destroy(); } catch {}
  }
}

function getCached(url) {
  const entry = articleCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > ARTICLE_CACHE_TTL_MS) {
    articleCache.delete(url);
    return null;
  }
  articleCache.delete(url);
  articleCache.set(url, entry);
  return entry.value;
}

function setCached(url, value) {
  if (articleCache.has(url)) articleCache.delete(url);
  articleCache.set(url, { createdAt: Date.now(), value });
  while (articleCache.size > ARTICLE_CACHE_MAX) {
    const oldestKey = articleCache.keys().next().value;
    if (oldestKey) articleCache.delete(oldestKey);
    else break;
  }
}

function sliceArticleResult(article, maxTextLength) {
  return {
    ...article,
    text: article.text.slice(0, maxTextLength),
    truncated: Boolean(article.truncated || article.originalLength > maxTextLength)
  };
}

export async function extractArticleFromUrl(rawUrl, options = {}) {
  const url = String(rawUrl || '').trim();
  if (!url) throw new Error('記事URLがありません');

  const maxTextLength = Math.max(
    2000,
    Math.min(Number(options.maxTextLength) || DEFAULT_MAX_TEXT_LENGTH, MAX_PDF_TEXT_LENGTH)
  );
  const preferPdf = options.preferPdf !== false;

  const cached = getCached(url);
  if (cached) return sliceArticleResult(cached, maxTextLength);

  let effectiveUrl = url;
  let googleNewsResolved = false;
  let googleNewsResolveError = '';

  if (isGoogleNewsArticleUrl(url)) {
    try {
      effectiveUrl = await resolveGoogleNewsPublisherUrl(url);
      googleNewsResolved = effectiveUrl !== url;
    } catch (err) {
      googleNewsResolveError = err?.message || 'Googleニュースの配信元URLを解決できませんでした';
      console.warn('[article-reader] Google News URL resolution fallback:', googleNewsResolveError, url);
      // Googleの中間HTMLを記事本文として誤要約しないよう、解決失敗時は
      // summary.mjs側のRSS本文フォールバックへ明示的に戻す。
      throw new Error(googleNewsResolveError);
    }
  }

  const effectiveCached = effectiveUrl !== url ? getCached(effectiveUrl) : null;
  if (effectiveCached) {
    setCached(url, effectiveCached);
    return sliceArticleResult(effectiveCached, maxTextLength);
  }

  const resource = await fetchResourceSafely(effectiveUrl, { acceptPdf: true });

  if (resource.kind === 'pdf') {
    const article = await extractPdfText(resource.buffer, resource.finalUrl);
    if (googleNewsResolved) {
      article.originalGoogleNewsUrl = url;
      article.resolvedFromGoogleNews = true;
    }
    setCached(url, article);
    if (effectiveUrl !== url) setCached(effectiveUrl, article);
    return sliceArticleResult(article, maxTextLength);
  }

  let pdfError = '';
  if (preferPdf) {
    const pdfUrl = findArticlePdfUrl(resource.buffer, resource.finalUrl);
    if (pdfUrl) {
      try {
        const pdfResource = await fetchResourceSafely(pdfUrl, { acceptPdf: true });
        if (pdfResource.kind === 'pdf') {
          const pdfArticle = await extractPdfText(pdfResource.buffer, pdfResource.finalUrl);
          const htmlTitle = (() => {
            try {
              const dom = new JSDOM(resource.buffer, { url: resource.finalUrl, contentType: 'text/html' });
              const value = normalizeText(dom.window.document.querySelector('meta[name="citation_title"]')?.content || dom.window.document.title);
              dom.window.close();
              return value;
            } catch { return ''; }
          })();
          if (!pdfArticle.title && htmlTitle) pdfArticle.title = htmlTitle.slice(0, 1000);
          pdfArticle.articleUrl = resource.finalUrl;
          if (googleNewsResolved) {
            pdfArticle.originalGoogleNewsUrl = url;
            pdfArticle.resolvedFromGoogleNews = true;
          }
          setCached(url, pdfArticle);
          if (effectiveUrl !== url) setCached(effectiveUrl, pdfArticle);
          return sliceArticleResult(pdfArticle, maxTextLength);
        }
      } catch (err) {
        pdfError = err?.message || 'PDF本文を取得できませんでした';
        console.warn('[article-reader] PDF fallback to HTML:', pdfError, pdfUrl);
      }
    }
  }

  const article = parseArticle(resource.buffer, resource.finalUrl, MAX_PDF_TEXT_LENGTH);
  if (pdfError) article.pdfFallbackReason = pdfError;
  if (googleNewsResolved) {
    article.originalGoogleNewsUrl = url;
    article.resolvedFromGoogleNews = true;
  }
  setCached(url, article);
  if (effectiveUrl !== url) setCached(effectiveUrl, article);
  return sliceArticleResult(article, maxTextLength);
}
