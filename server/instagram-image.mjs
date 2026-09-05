const INSTAGRAM_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1';
const MAX_SHORTCODES = 6;

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function decodeEscapedLayer(input) {
  return String(input || '')
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\u0022/gi, '"')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/\\u003d/gi, '=')
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/gi, '"')
    .replace(/&amp;/gi, '&');
}

function decodedVariants(html, levels = 5) {
  const variants = [];
  let current = String(html || '');
  for (let level = 0; level < levels; level += 1) {
    if (!variants.includes(current)) variants.push(current);
    current = decodeEscapedLayer(current);
  }
  return variants;
}

function normalizeHttpsUrl(value) {
  let candidate = String(value || '').trim();
  for (let pass = 0; pass < 3; pass += 1) candidate = decodeEscapedLayer(candidate);
  candidate = candidate.replace(/^['"]|['"]$/g, '');
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function extractBalanced(text, startIndex, open = '{', close = '}') {
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) { inString = false; quote = ''; }
      continue;
    }
    if (char === '"' || char === "'") { inString = true; quote = char; continue; }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }
  return null;
}

function candidate(url, width = 0, height = 0, priority = 0) {
  const normalized = normalizeHttpsUrl(url);
  if (!normalized) return null;
  const w = Math.max(0, Number(width) || 0);
  const h = Math.max(0, Number(height) || 0);
  return { url: normalized, width: w || null, height: h || null, score: w * h * 10 + priority };
}

function bestImage(node = {}) {
  const source = node?.node || node || {};
  const candidates = [];
  const add = value => { if (value) candidates.push(value); };

  const resources = source.display_resources || source.displayResources;
  if (Array.isArray(resources)) {
    resources.forEach(entry => add(candidate(entry?.src || entry?.url, entry?.config_width || entry?.width, entry?.config_height || entry?.height, 4_000_000)));
  }
  const imageCandidates = source?.image_versions2?.candidates || source?.imageVersions2?.candidates || source?.image_versions?.candidates;
  if (Array.isArray(imageCandidates)) {
    imageCandidates.forEach(entry => add(candidate(entry?.url || entry?.src, entry?.width, entry?.height, 3_000_000)));
  }
  const thumbnails = source.thumbnail_resources || source.thumbnailResources;
  if (Array.isArray(thumbnails)) {
    thumbnails.forEach(entry => add(candidate(entry?.src || entry?.url, entry?.config_width || entry?.width, entry?.config_height || entry?.height, 500_000)));
  }
  const dims = source.dimensions || {};
  add(candidate(source.display_url || source.displayUrl, dims.width || source.width, dims.height || source.height, 2_000_000));
  add(candidate(source.thumbnail_src || source.thumbnailUrl || source.thumbnail_url, source.width, source.height, 100_000));

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function mediaNodesFromObject(media) {
  const sidecar = media?.edge_sidecar_to_children?.edges;
  if (Array.isArray(sidecar) && sidecar.length) return sidecar.map(entry => entry?.node || entry).filter(Boolean);
  const carousel = media?.carousel_media || media?.carouselMedia;
  if (Array.isArray(carousel) && carousel.length) return carousel.filter(Boolean);
  return media ? [media] : [];
}

function parseStructuredMedia(html) {
  for (const input of decodedVariants(html)) {
    const markers = [
      /["']shortcode_media["']\s*:\s*\{/gi,
      /["']xdt_shortcode_media["']\s*:\s*\{/gi
    ];
    for (const marker of markers) {
      let match;
      while ((match = marker.exec(input))) {
        const start = input.indexOf('{', match.index);
        const raw = start >= 0 ? extractBalanced(input, start, '{', '}') : null;
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw);
          const nodes = mediaNodesFromObject(parsed);
          const images = nodes.map(bestImage).filter(Boolean);
          if (images.length) return images;
        } catch {}
      }
    }
  }
  return [];
}

function parseCandidateArrays(html) {
  const output = [];
  const seen = new Set();
  const push = image => {
    if (!image?.url || seen.has(image.url)) return;
    seen.add(image.url);
    output.push(image);
  };

  for (const input of decodedVariants(html)) {
    const resourceMarker = /["']display_resources["']\s*:\s*\[/gi;
    let match;
    while ((match = resourceMarker.exec(input))) {
      const start = input.indexOf('[', match.index);
      const raw = start >= 0 ? extractBalanced(input, start, '[', ']') : null;
      if (!raw) continue;
      try {
        const entries = JSON.parse(raw);
        if (!Array.isArray(entries)) continue;
        const best = entries
          .map(entry => candidate(entry?.src || entry?.url, entry?.config_width || entry?.width, entry?.config_height || entry?.height, 4_000_000))
          .filter(Boolean)
          .sort((a, b) => b.score - a.score)[0];
        push(best);
      } catch {}
    }

    const imageMarker = /["']image_versions2["']\s*:\s*\{/gi;
    while ((match = imageMarker.exec(input))) {
      const start = input.indexOf('{', match.index);
      const raw = start >= 0 ? extractBalanced(input, start, '{', '}') : null;
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        const best = (Array.isArray(parsed?.candidates) ? parsed.candidates : [])
          .map(entry => candidate(entry?.url || entry?.src, entry?.width, entry?.height, 3_000_000))
          .filter(Boolean)
          .sort((a, b) => b.score - a.score)[0];
        push(best);
      } catch {}
    }
  }
  return output;
}

function parseMetaImage(html) {
  for (const input of decodedVariants(html)) {
    const patterns = [
      /<meta\b[^>]*(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*content=["']([^"']+)["'][^>]*>/i,
      /<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*>/i
    ];
    for (const pattern of patterns) {
      const match = input.match(pattern);
      const image = candidate(match?.[1], 0, 0, 1_000_000);
      if (image) return image;
    }
  }
  return null;
}

async function fetchEmbed(shortcode) {
  const urls = [
    `https://www.instagram.com/p/${shortcode}/embed/`,
    `https://www.instagram.com/reel/${shortcode}/embed/`
  ];
  let lastError = null;
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'ja,en-US;q=0.8,en;q=0.7',
          'User-Agent': INSTAGRAM_UA
        },
        signal: AbortSignal.timeout(9000)
      });
      const html = await response.text();
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      let images = parseStructuredMedia(html);
      if (!images.length) images = parseCandidateArrays(html);
      if (!images.length) {
        const meta = parseMetaImage(html);
        if (meta) images = [meta];
      }
      if (images.length) {
        return {
          shortcode,
          images: images.slice(0, 20).map(({ url: imageUrl, width, height }) => ({ url: imageUrl, width, height })),
          sourceUrl: url
        };
      }
      lastError = new Error('高解像度画像候補が見つかりませんでした。');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Instagram画像を取得できませんでした。');
}

function parseShortcodes(req) {
  const raw = String(first(req.query?.shortcodes) || first(req.query?.shortcode) || '').trim();
  const values = raw.split(',').map(value => value.trim()).filter(Boolean);
  const unique = [...new Set(values)];
  if (!unique.length) throw new Error('shortcodeが必要です。');
  if (unique.length > MAX_SHORTCODES) throw new Error(`shortcodeは最大${MAX_SHORTCODES}件です。`);
  if (unique.some(value => !/^[A-Za-z0-9_-]{5,64}$/.test(value))) throw new Error('shortcodeの形式が不正です。');
  return unique;
}

export default async function instagramImage(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=1800, stale-while-revalidate=86400');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GETのみ対応しています。' });

  let shortcodes;
  try {
    shortcodes = parseShortcodes(req);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }

  const results = await Promise.allSettled(shortcodes.map(fetchEmbed));
  const resolved = {};
  const errors = {};
  results.forEach((result, index) => {
    const shortcode = shortcodes[index];
    if (result.status === 'fulfilled') resolved[shortcode] = result.value;
    else errors[shortcode] = result.reason?.message || String(result.reason || '取得失敗');
  });

  const okCount = Object.keys(resolved).length;
  return res.status(okCount ? 200 : 502).json({
    ok: Boolean(okCount),
    count: okCount,
    resolved,
    errors
  });
}
