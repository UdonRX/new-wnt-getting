import core from './reader-deep-dive-core.mjs';

const TAVILY_URL = 'https://api.tavily.com/search';
const TMO = 7000;
const TTL = 24 * 60 * 60 * 1000;
const LOG = '[READER_DEEP_DIVE_DEBUG]';
const lanes = ['timeline', 'perspectives', 'future'];
const blocked = ['x.com','twitter.com','facebook.com','instagram.com','tiktok.com','reddit.com','youtube.com','youtu.be'];
const cache = new Map();
const inflight = new Map();

const latinStop = new Set(['the','and','for','with','from','this','that','into','about','after','before','news','today','report','reports','update','updates','new','one','more','will','using','used','use','its','their','our','your','you','ai','agent']);
const chunkStop = new Set(['登場','発表','判断','可能','お願い','ニュース','ヘッドラインニュース','ニュースまとめ','今日のニュース','ニュース一覧','できる','について','として','まとめ','要約']);
const conceptSpecs = [
  [/国防総省|防衛総省|pentagon|department of defense/i,['国防総省','Pentagon','Department of Defense']],
  [/連邦地方裁判所|連邦裁判所|連邦判事|federal (?:district )?court|federal judge/i,['連邦判事','federal judge','federal court']],
  [/サプライチェーンリスク|supply chain risk/i,['サプライチェーンリスク','supply chain risk']],
  [/憲法修正第1条|first amendment/i,['憲法修正第1条','First Amendment']],
  [/違法|illegal|unlawful/i,['違法','illegal','unlawful']],
  [/判決|判断|ruling|ruled/i,['判決','ruling']],
  [/訴訟|提訴|lawsuit|litigation/i,['訴訟','lawsuit']],
  [/買収|acquisition|acquire|acquired/i,['買収','acquisition']],
  [/提携|協業|partnership|alliance/i,['提携','partnership']],
  [/投資|investment|funding/i,['投資','investment']],
  [/規制|regulation|regulatory/i,['規制','regulation']],
  [/承認|approval|approved/i,['承認','approval']],
  [/発売|提供開始|launch|release|available/i,['発売','launch']],
  [/特許|patent/i,['特許','patent']],
  [/AIエージェント|AI agent/i,['AIエージェント','AI agent']],
  [/文字起こし|transcri/i,['文字起こし','transcription']],
  [/録音|recording/i,['録音','recording']]
];

function clean(value = '', max = 1200) { return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
function clip(value = '', max = 72) { const chars = Array.from(clean(value, max + 20)); return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`; }
function norm(value = '') { return clean(value, 1800).toLowerCase().replace(/[\s。、，,.!！?？:：;；"'“”‘’「」『』（）()【】\[\]<>]/g, ''); }
function httpUrl(value = '') { try { const u = new URL(String(value || '')); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; } }
function host(value = '') { try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } }
function traceId() { return `dd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function log(event, id, data = {}) { try { console.log(`${LOG} ${JSON.stringify({ event, traceId: id, ts: new Date().toISOString(), ...data })}`); } catch {} }
function safeError(error) { return { name: clean(error?.name || 'Error', 60), message: clean(error?.message || String(error), 400), status: Number(error?.statusCode || 0) || undefined }; }
function uniq(values = []) { const seen = new Set(); return values.map(v => clean(v, 80)).filter(v => { const key = norm(v); if (key.length < 2 || seen.has(key)) return false; seen.add(key); return true; }); }
function quoted(value = '') { const out = [], re = /[「『“"]([^」』”"]{2,48})[」』”"]/g; let m; while ((m = re.exec(value))) out.push(m[1]); return uniq(out); }
function latin(value = '') { const out = []; for (const m of clean(value, 1200).matchAll(/\b[A-Za-z][A-Za-z0-9.+#_-]{2,}\b/g)) { const token = m[0]; if (latinStop.has(token.toLowerCase())) continue; if (token.length >= 4 || /^[A-Z0-9]{3,}$/.test(token)) out.push(token); } return uniq(out); }
function chunks(value = '') { return uniq(clean(value, 500).replace(/[「」『』“”"（）()【】]/g, ' ').split(/(?:による|について|として|から|まで|より|など|という|である|では|には|への|へ|を|が|は|の|と|に|で|、|。|・|：|:|／|\/)/).map(v => v.trim()).filter(v => { const n = Array.from(v).length; return n >= 3 && n <= 28 && !chunkStop.has(v) && !/^(?:AI|API|ニュース|記事|今回|これ|それ)$/.test(v); })); }
function katakana(value = '') { return uniq(clean(value, 900).match(/[ァ-ヶー]{4,}/g) || []).filter(v => !/(ニュース|ヘッドライン)/.test(v)); }

function fingerprint(body = {}) {
  const title = clean(body.title, 260), summary = clean(body.summary, 500), source = `${title} ${summary}`;
  const titleQuotes = quoted(title);
  const exact = (titleQuotes.length ? titleQuotes : quoted(summary)).filter(v => Array.from(v).length <= 40).slice(0, 3);
  const strong = uniq([...exact, ...latin(source)]).filter(v => !/^gigazine$/i.test(v)).slice(0, 5);
  const concepts = conceptSpecs.filter(([re]) => re.test(source)).map(([, variants]) => variants);
  const support = uniq([...chunks(title), ...katakana(title), ...katakana(summary)]).filter(v => !strong.some(s => norm(v) === norm(s) || norm(v).includes(norm(s)))).slice(0, 7);
  const parts = uniq([...exact.slice(0, 2), ...strong.slice(0, 3), ...support.slice(0, 3), ...concepts.slice(0, 3).map(group => group[0])]);
  let seed = '';
  for (const part of parts) { const next = clean(`${seed} ${part}`, 160); if (Array.from(next).length > 145) break; seed = next; }
  if (!seed) seed = clean(title || summary, 120);
  return { exact, strong, concepts, support, seed: clean(seed, 150) };
}
function actualQuery(fp, lane) {
  const tail = lane === 'timeline' ? '経緯 過去 background timeline' : lane === 'perspectives' ? '反応 評価 専門家 reaction analyst' : '今後 予定 見通し next steps outlook';
  return clean(`${fp.seed} ${tail}`, 190);
}
function matchTerm(blob, term) { const a = norm(blob), b = norm(term); return b.length >= 2 && a.includes(b); }
function relevance(result, fp, lane) {
  const blob = `${result.title} ${result.content} ${result.url}`;
  const exact = fp.exact.filter(v => matchTerm(blob, v));
  const strong = fp.strong.filter(v => matchTerm(blob, v));
  const concept = fp.concepts.filter(group => group.some(v => matchTerm(blob, v)));
  const support = fp.support.filter(v => matchTerm(blob, v));
  const exactSpecific = exact.some(v => norm(v).length >= 5);
  const score = Number(result.score || 0);
  let keep = exactSpecific || strong.length >= 2 || (strong.length >= 1 && (concept.length >= 1 || support.length >= 1));
  if (!keep && lane === 'timeline' && strong.length >= 1 && score >= 0.55) keep = true;
  if (!keep && !fp.strong.length) keep = concept.length >= 2 || (concept.length >= 1 && support.length >= 1) || (support.length >= 2 && score >= 0.45);
  return { keep, exact: exact.length, strong: strong.length, concept: concept.length, support: support.length };
}

const months = { january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',july:'07',august:'08',september:'09',october:'10',november:'11',december:'12',jan:'01',feb:'02',mar:'03',apr:'04',jun:'06',jul:'07',aug:'08',sep:'09',sept:'09',oct:'10',nov:'11',dec:'12' };
function dateOf(value = '') { const x = clean(value, 1400); let m = x.match(/\b((?:19|20)\d{2})[年./-]\s*(\d{1,2})?(?:月)?/); if (m) return m[2] ? `${m[1]}.${String(m[2]).padStart(2, '0')}` : m[1]; m = x.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+((?:19|20)\d{2})\b/i); return m ? `${m[2]}.${months[m[1].toLowerCase()]}` : ''; }
function sentence(value = '', max = 70) { const x = clean(value, 900); return clip(x.match(/^.*?[。！？!?](?:\s|$)/)?.[0] || x, max); }
function metric(value = '') { const m = clean(value, 1200).match(/(?:約|around|about)?\s*[+＋-]?\d[\d,.]*(?:\.\d+)?\s*(?:兆円|億円|万円|円|億ドル|百万ドル|万ドル|ドル|%|％|倍|人|件|社|台|GW|MW|kW|GWh|MWh|kWh|TB|GB|MB|billion|million|trillion)/i); return m ? clean(m[0], 34) : ''; }
function tag(value = '') { if (/法改正|legislation/i.test(value)) return '法改正'; if (/新技術|technology|prototype|新製品/i.test(value)) return '新技術'; if (/買収|acqui/i.test(value)) return '買収'; if (/投資|investment|funding/i.test(value)) return '投資'; if (/提携|partnership|alliance/i.test(value)) return '提携'; if (/規制|regulat/i.test(value)) return '規制'; if (/決算|earnings|results/i.test(value)) return '決算'; if (/発表|announce|launch/i.test(value)) return '発表'; return '転換点'; }
function actor(row) { const a = clean(row?.title, 100).split(/[|｜:：—–-]/)[0].trim(); return clip(a && a.length <= 32 ? a : host(row?.url).split('.')[0], 26); }
function stance(value = '') { return /(懸念|慎重|リスク|批判|反対|concern|risk|critic|caution)/i.test(value) ? '慎重' : /(歓迎|支持|期待|推進|成長|support|welcome|growth|positive)/i.test(value) ? '推進' : '中立'; }
function buildBase(lane, rows) {
  const out = { timeline: [], perspectives: [], regionGap: [], future: [], nextWatch: [] };
  if (lane === 'timeline') {
    const seen = new Set();
    out.timeline = rows.map(row => { const blob = `${row.publishedDate} ${row.title} ${row.content}`, date = dateOf(blob), text = sentence(row.content), key = `${date}:${norm(text).slice(0, 50)}`; if (!date || !text || seen.has(key)) return null; seen.add(key); return { date, tag: tag(blob), text, metric: metric(row.content), quote: '', sourceUrl: row.url }; }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 4);
  }
  if (lane === 'perspectives') {
    const hosts = new Set(), views = [];
    for (const row of rows) { const h = host(row.url); if (!h || hosts.has(h)) continue; hosts.add(h); views.push({ stance: stance(`${row.title} ${row.content}`), actor: actor(row), text: sentence(row.content, 66), sourceUrl: row.url }); if (views.length === 2) break; }
    if (views.length === 2) out.perspectives = [{ issue: '確認された見解', views }];
  }
  if (lane === 'future') {
    for (const row of rows) {
      const blob = `${row.publishedDate} ${row.title} ${row.content}`;
      const isFact = /(予定|決定|開催|施行|発売|開始|scheduled|will launch|approval)/i.test(blob);
      const isExpert = /(専門家|アナリスト|予測|見通し|forecast|analyst|expects?|outlook)/i.test(blob);
      if (isFact || isExpert) out.future.push({ type: isFact ? 'fact' : 'expert', timeframe: '短期', actor: isExpert ? actor(row) : '', text: sentence(row.content, 68), impactMarket: 'unknown', impactLife: 'unknown', sourceUrl: row.url });
      const date = dateOf(blob); if (date && isFact) out.nextWatch.push({ date, event: sentence(row.content, 58), sourceUrl: row.url });
      if (out.future.length >= 3 && out.nextWatch.length >= 2) break;
    }
    out.future = out.future.slice(0, 3); out.nextWatch = out.nextWatch.slice(0, 2);
  }
  return out;
}

function cacheKey(body, lane) { return `${clean(body.articleId || body.url || body.title, 700).toLowerCase()}::${lane}::fingerprint-v1`; }
function cacheGet(key) { const hit = cache.get(key); if (!hit || Date.now() - hit.ts > TTL) { cache.delete(key); return null; } return hit.value; }
function cacheSet(key, value) { cache.set(key, { ts: Date.now(), value }); while (cache.size > 72) cache.delete(cache.keys().next().value); }

async function search(body, lane, id) {
  const apiKey = clean(process.env.TAVILY_API_KEY, 300);
  if (!apiKey) { const error = new Error('TAVILY_API_KEY が設定されていません。'); error.statusCode = 503; throw error; }
  const fp = fingerprint(body), query = actualQuery(fp, lane), topic = lane === 'timeline' ? 'general' : 'news', timeRange = lane === 'perspectives' ? 'month' : lane === 'future' ? 'year' : null;
  log('fingerprint_built', id, { lane, query, queryChars: Array.from(query).length, exact: fp.exact, strong: fp.strong, support: fp.support.slice(0, 5), concepts: fp.concepts.map(group => group[0]) });
  log('tavily_start', id, { lane, timeoutMs: TMO, query, fingerprintChars: Array.from(fp.seed).length });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TMO), started = Date.now();
  try {
    const response = await fetch(TAVILY_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, search_depth: 'basic', max_results: 4, topic, time_range: timeRange, include_answer: false, include_raw_content: false, include_images: false, safe_search: true, exclude_domains: blocked }), signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data?.detail?.error || data?.detail || `Tavily HTTP ${response.status}`); error.statusCode = response.status; throw error; }
    const raw = Array.isArray(data?.results) ? data.results : [];
    const mapped = raw.map(row => ({ title: clean(row?.title, 220), url: httpUrl(row?.url), content: clean(row?.content, 820), score: Number(row?.score || 0), publishedDate: clean(row?.published_date || row?.publishedDate, 50) })).filter(row => row.url && row.content && !blocked.some(domain => host(row.url) === domain || host(row.url).endsWith(`.${domain}`)));
    const reviewed = mapped.map(row => ({ row, check: relevance(row, fp, lane) }));
    const rows = reviewed.filter(item => item.check.keep).map(item => item.row).sort((a, b) => b.score - a.score).slice(0, 4);
    log('fingerprint_filter', id, { lane, rawResultCount: raw.length, candidateCount: mapped.length, keptCount: rows.length, rejectedCount: reviewed.filter(item => !item.check.keep).length, checks: reviewed.map(item => ({ host: host(item.row.url), title: clip(item.row.title, 72), score: Number(item.row.score.toFixed(3)), ...item.check })) });
    log('tavily_success', id, { lane, elapsedMs: Date.now() - started, rawResultCount: raw.length, usableResultCount: rows.length, samples: rows.map(row => ({ host: host(row.url), title: clip(row.title, 90), score: Number(row.score.toFixed(3)), contentChars: row.content.length })) });
    const value = { articleId: clean(body.articleId || body.url || body.title, 700), lane, phase: 'search', generatedAt: Date.now(), ...buildBase(lane, rows), evidence: rows, sourceCount: new Set(rows.map(row => row.url)).size, queryMode: 'fingerprint-filtered-one-search-v1' };
    log('search_complete', id, { lane, sourceCount: value.sourceCount });
    return value;
  } catch (error) {
    log('tavily_error', id, { lane, elapsedMs: Date.now() - started, error: safeError(error) });
    throw error;
  } finally { clearTimeout(timer); }
}

export default async function readerDeepDive(req, res) {
  const raw = req.body && typeof req.body === 'object' ? req.body : {};
  const phase = raw.phase === 'enrich' ? 'enrich' : 'search';
  if (phase === 'enrich') return core(req, res);
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method Not Allowed' }); }
  const title = clean(raw.title, 260), lane = lanes.includes(String(raw.lane || '')) ? String(raw.lane) : '';
  if (!title || !lane) return res.status(400).json({ error: !title ? 'title is required' : 'lane is required' });
  const body = { articleId: clean(raw.articleId || raw.url || title, 700), title, source: clean(raw.source, 120), category: clean(raw.category, 120), url: httpUrl(raw.url), summary: clean(raw.summary, 700) };
  const id = traceId(), key = cacheKey(body, lane), hit = cacheGet(key);
  log('request_received', id, { phase, lane, articleId: body.articleId, title: body.title, source: body.source, summaryChars: body.summary.length, cacheHit: Boolean(hit), hasTavilyKey: Boolean(process.env.TAVILY_API_KEY), hasGeminiKey: Boolean(process.env.GEMINI_API_KEY) });
  if (hit) return res.status(200).json({ ...hit, cache: 'memory' });
  if (inflight.has(key)) { try { return res.status(200).json({ ...await inflight.get(key), cache: 'inflight' }); } catch (error) { return res.status(Number(error?.statusCode || 500)).json({ error: error?.message || 'Deep dive failed' }); } }
  const promise = search(body, lane, id).then(value => (cacheSet(key, value), value)).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  try { res.setHeader('Cache-Control', 'private, max-age=0, no-store'); return res.status(200).json(await promise); }
  catch (error) { const status = Number(error?.statusCode || (error?.name === 'AbortError' ? 504 : 500)); log('request_error', id, { phase, lane, status, error: safeError(error) }); return res.status(status).json({ error: status === 503 ? 'Tavily APIを利用できません' : status === 504 ? 'Tavily検索が時間内に完了しませんでした' : '深掘り情報を取得できませんでした', detail: status === 503 ? 'VercelのTAVILY_API_KEYを確認してください。' : '' }); }
}
