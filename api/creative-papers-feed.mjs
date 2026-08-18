import jsdomPackage from 'jsdom';
import { rssXml } from '../lib/rss-merge.mjs';
import { CREATIVE_PAPER_GROUPS, CREATIVE_PAPER_METHOD_TERMS } from '../shared/paper-creative-keywords.js';

const { JSDOM } = jsdomPackage;

const JSTAGE_ENDPOINT = 'https://api.jstage.jst.go.jp/searchapi/do';
const S2_ENDPOINT = 'https://api.semanticscholar.org/graph/v1/paper/search/bulk';
const CINII_ENDPOINT = 'https://cir.nii.ac.jp/opensearch/v2/articles';
const CORE_ENDPOINT = 'https://api.core.ac.uk/v3/search/works';
const IEEE_ENDPOINT = 'https://ieeexploreapi.ieee.org/api/v1/search/articles';

const FAST_TTL = 10 * 60 * 1000;
const DEEP_TTL = 30 * 60 * 1000;
const MAX_ITEMS = 300;
const S2_LIMIT = 90;
const JSTAGE_PER_TERM = 32;
const RETRY_DELAYS = [700, 1500];
const caches = { fast:{ at:0, xml:'' }, deep:{ at:0, xml:'' } };
const providerCache = new Map();

// fastでは既存テーマと一般独創を半々程度に混ぜ、初回表示でも一般独創が見えるようにする。
const FAST_JSTAGE_GROUP_IDS = new Set([
  'acoustic-cooking', 'capillary-food', 'behavior-energy', 'noncontact-digital-twin',
  'tribology-haptics', 'geometry-metamaterials', 'collective-behavior-physics',
  'lowcost-computational-sensing', 'human-ai-decision'
]);
const FAST_JSTAGE_TERMS = CREATIVE_PAPER_GROUPS
  .filter(group => FAST_JSTAGE_GROUP_IDS.has(group.id))
  .map(group => group.jaKeywords[0]);

// deepでもJ-STAGEは1軸1検索に抑える。2語ずつ全検索するとVercelの実行時間を圧迫するため。
const DEEP_JSTAGE_TERMS = CREATIVE_PAPER_GROUPS.map(group => group.jaKeywords[0]);

// Semantic Scholarは全24軸を1件ずつ叩かず、発見用の広めのクエリにまとめる。
// 取得後にevaluateCreativeで各軸へ再分類するので、検索の広さとノイズ除去を分離できる。
const S2_DISCOVERY_QUERIES = [
  { label:'応用発想・状態/界面', family:'applied', intent:'状態センシング、流体・表面、食品吸水の異分野接続を探索', semanticQuery:'(acoustic OR vibration OR wettability OR capillary OR microstructure) + (sensing OR boiling OR food OR rice OR pouring)' },
  { label:'応用発想・感覚/熱', family:'applied', intent:'香り・触覚・熱物性・人間工学の接続を探索', semanticQuery:'(aroma OR volatile OR haptic OR "thermal effusivity" OR "human factors") + (temperature OR material OR appliance OR sensory)' },
  { label:'応用発想・設計/制御', family:'applied', intent:'生物模倣、デジタルツイン、行動科学の製品応用を探索', semanticQuery:'(biomimetic OR "digital twin" OR "sensor fusion" OR "user behavior") + (thermal OR appliance OR cooking OR energy OR usability)' },
  { label:'一般独創・知覚/接触', family:'general', intent:'摩擦・触覚・心理物理・クロスモーダル知覚を探索', semanticQuery:'(tribology OR friction OR haptic OR psychophysics OR crossmodal OR multisensory) + (material OR grip OR touch OR perception OR experiment)' },
  { label:'一般独創・形/機能', family:'general', intent:'幾何学、折り紙、メタマテリアル、生物表面の機能発現を探索', semanticQuery:'(origami OR kirigami OR metamaterial OR "architected material" OR "bio-inspired surface") + (mechanical OR acoustic OR thermal OR friction OR wettability)' },
  { label:'一般独創・集団/因果', family:'general', intent:'群集、ネットワーク、因果推論で日常行動を説明する研究を探索', semanticQuery:'("collective behavior" OR "crowd dynamics" OR "network science" OR "causal inference" OR "natural experiment") + (behavior OR traffic OR diffusion OR intervention OR empirical)' },
  { label:'一般独創・環境/認知', family:'general', intent:'光・音・温度など環境条件と認知・睡眠・判断の関係を探索', semanticQuery:'(light OR noise OR temperature OR "indoor environment") + (cognition OR attention OR sleep OR decision OR productivity) + (experiment OR measurement)' },
  { label:'一般独創・計測/AI', family:'general', intent:'安価センサ、スマートフォン、計算計測、人間-AI協働を探索', semanticQuery:'(smartphone OR "low-cost sensor" OR "computational imaging" OR "human AI" OR "AI advice") + (measurement OR calibration OR decision OR trust OR validation)' },
  { label:'一般独創・液滴/複雑系', family:'general', intent:'液滴蒸発の身近な物理と連鎖故障・回復力の複雑系研究を探索', semanticQuery:'("droplet evaporation" OR "coffee-ring effect" OR "cascading failure" OR "complex network") + (transport OR deposition OR resilience OR model OR experiment)' }
];
const FAST_S2_DISCOVERY_QUERIES = [
  S2_DISCOVERY_QUERIES[0], S2_DISCOVERY_QUERIES[3],
  S2_DISCOVERY_QUERIES[4], S2_DISCOVERY_QUERIES[7]
];

const HARD_NEGATIVE = [
  /cancer|tumou?r|chemotherapy|drug delivery|clinical trial|patient|surgery|disease diagnosis/i,
  /rocket|spacecraft|satellite propulsion|missile|weapon/i,
  /oil pipeline|gas pipeline|petroleum reservoir|drilling/i,
  /battery cell|lithium[- ]ion battery|fuel cell stack/i
];

function text(value){ return String(value || '').replace(/\s+/g,' ').trim(); }
function stripHtml(value){ return text(String(value || '').replace(/<[^>]+>/g,' ')); }
function nodeText(node, selector){ return node?.querySelector(selector)?.textContent?.trim() || ''; }
function firstText(node, selectors){ for(const selector of selectors){ const value=nodeText(node,selector); if(value) return value; } return ''; }
function https(value){ return String(value || '').replace(/^http:\/\//i,'https://').trim(); }
function date(value, fallbackYear=''){
  const parsed=new Date(value || '');
  if(Number.isFinite(parsed.getTime())) return parsed;
  const year=String(fallbackYear || '').match(/\d{4}/)?.[0];
  return year ? new Date(`${year}-01-01T00:00:00Z`) : new Date(0);
}
function sleep(ms){ return new Promise(resolve=>setTimeout(resolve,ms)); }

async function fetchRetry(url,{headers={},timeoutMs=12000}={}){
  let lastError;
  for(let attempt=0; attempt<=RETRY_DELAYS.length; attempt+=1){
    try{
      const response=await fetch(url,{headers,redirect:'follow',signal:AbortSignal.timeout(timeoutMs)});
      if(![429,500,502,503,504].includes(response.status) || attempt===RETRY_DELAYS.length) return response;
    }catch(err){ lastError=err; if(attempt===RETRY_DELAYS.length) throw err; }
    await sleep(RETRY_DELAYS[attempt]);
  }
  throw lastError || new Error('外部API通信に失敗しました');
}

function searchText(value){
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‐‑‒–—]/g,'-')
    .replace(/\s+/g,' ');
}

function groupForText(rawText){
  const hay=searchText(rawText);
  const matches=[];
  for(const group of CREATIVE_PAPER_GROUPS){
    const a=group.conceptA.filter(term=>hay.includes(searchText(term))).length;
    const b=group.conceptB.filter(term=>hay.includes(searchText(term))).length;
    if(a>0 && b>0) matches.push({ group, a, b });
  }
  return matches;
}

function methodHits(rawText){
  const hay=searchText(rawText);
  return CREATIVE_PAPER_METHOD_TERMS.filter(term=>hay.includes(searchText(term))).length;
}

function qualityFromCitations(item){
  const citations=Math.max(0,Number(item?.citationCount || 0));
  const influential=Math.max(0,Number(item?.influentialCitationCount || 0));
  const year=Number(item?.year || item?.pubDate?.getUTCFullYear?.() || 0);
  const age=year ? Math.max(0.6,new Date().getUTCFullYear()-year+0.6) : 4;
  const velocity=citations/age;
  return Math.min(8,Math.log2(1+velocity)*2.2) + Math.min(6,Math.log2(1+influential)*2);
}

function evaluateCreative(item){
  const raw=[item?.title,item?.originalTitle,item?.abstract,item?.description].filter(Boolean).join('\n');
  const clean=raw.replace(/(?:検索語|独創検索|狙い|独創研究軸|独創区分|独創性スコア|検証性スコア):[^\n]*/g,' ');
  const groups=groupForText(clean);
  if(!groups.length) return { score:0, rigor:0, groups:[], families:[], maxConcept:0 };

  const rigor=methodHits(clean);
  const maxConcept=Math.max(...groups.map(row=>row.a+row.b));
  const families=[...new Set(groups.map(row=>row.group.family || 'applied'))];
  const hasGeneral=families.includes('general');
  const hasApplied=families.includes('applied');

  let score=groups.reduce((sum,row)=>sum + (row.group.family==='general'?12:10) + Math.min(6,row.a+row.b),0);
  score += Math.min(15,rigor*3);
  if(clean.length>900) score += 4;
  else if(clean.length<280) score -= hasGeneral ? 8 : 3;
  if(item?.venue || item?.journal) score += 2;
  if(item?.hasOpenAccessPdf || /\.pdf(?:$|[?#])/i.test(item?.link || '')) score += 3;
  score += qualityFromCitations(item);
  score -= HARD_NEGATIVE.filter(pattern=>pattern.test(clean)).length * 18;

  // 一般独創はタイトルの珍しさだけでは通さない。概念接続が濃いか、方法論が複数確認できることを要求する。
  if(hasGeneral && maxConcept<3 && rigor<2) score -= 16;
  if(hasGeneral && rigor<1) score -= 16;
  if(!hasGeneral && rigor<1) score -= item?.sourceName === 'J-STAGE' ? 4 : 12;

  // 2つ以上の研究軸に自然にまたがる論文は「異分野接続」の補助点。ただし加点は小さくする。
  if(groups.length>=2) score += Math.min(5,groups.length*1.5);

  return { score, rigor, maxConcept, families, hasGeneral, hasApplied, groups:groups.map(row=>row.group) };
}

function decorate(item){
  if(!item) return null;
  const result=evaluateCreative(item);
  const trustedStrongTitle = item?.sourceName === 'J-STAGE' && result.hasApplied && !result.hasGeneral && result.maxConcept >= 3;
  if(!result.groups.length || (result.rigor<1 && !trustedStrongTitle) || result.score<15) return null;
  if(result.hasGeneral && result.maxConcept<3 && result.rigor<2) return null;

  item.creativeScore=Math.round(result.score*10)/10;
  item.creativeGroups=result.groups.map(group=>group.label);
  item.creativeFamilies=result.families;
  const familyLabels=result.families.map(family=>family==='general'?'一般独創':'応用発想');
  const intents=[...new Set(result.groups.map(group=>group.intent))].slice(0,2);
  const current=text(item.description);
  item.description=[
    `独創区分: ${familyLabels.join(' / ')}`,
    `独創研究軸: ${item.creativeGroups.join(' / ')}`,
    `狙い: ${intents.join(' ')}`,
    `独創性スコア: ${item.creativeScore}`,
    `検証性スコア: ${result.rigor}`,
    current
  ].filter(Boolean).join('\n\n');
  return item;
}

function parseJStageEntry(entry){
  const title=firstText(entry,['article_title > ja','article_title > en','title']) || '無題';
  const link=https(firstText(entry,['article_link > ja','article_link > en']) || entry.querySelector('link')?.getAttribute('href') || nodeText(entry,'id'));
  const authorsJa=Array.from(entry.querySelectorAll('author > ja > name')).map(el=>el.textContent?.trim()).filter(Boolean);
  const authorsEn=Array.from(entry.querySelectorAll('author > en > name')).map(el=>el.textContent?.trim()).filter(Boolean);
  const authors=(authorsJa.length?authorsJa:authorsEn).slice(0,8).join(', ');
  const journal=firstText(entry,['material_title > ja','material_title > en']);
  const abstract=firstText(entry,['abstract > ja','abstract > en','summary','description']);
  const doi=firstText(entry,['prism\\:doi','doi']);
  return {
    title:text(title), originalTitle:text(title), link,
    pubDate:date(nodeText(entry,'updated'),nodeText(entry,'pubyear')),
    year:Number(nodeText(entry,'pubyear'))||0,
    author:authors||journal||'J-STAGE', sourceName:'J-STAGE', journal, abstract:text(abstract),
    description:[abstract&&`抄録: ${text(abstract)}`,journal&&`掲載誌: ${journal}`,authors&&`著者: ${authors}`,doi&&`DOI: ${doi}`,'情報提供元: J-STAGE'].filter(Boolean).join('\n'),
    doi:text(doi), sourceId:`creative-jstage:${text(doi||link||title)}`
  };
}

async function searchJStage(term, timeoutMs=12000){
  const url=new URL(JSTAGE_ENDPOINT);
  url.searchParams.set('service','3'); url.searchParams.set('text',term); url.searchParams.set('count',String(JSTAGE_PER_TERM));
  const response=await fetchRetry(url,{timeoutMs,headers:{Accept:'application/atom+xml, application/xml, text/xml, */*;q=0.5','User-Agent':'PersonalDashboardCreativePapers/2.2'}});
  if(!response.ok) throw new Error(`J-STAGE HTTP ${response.status} (${term})`);
  const dom=new JSDOM(await response.text(),{contentType:'text/xml'});
  try{
    const doc=dom.window.document;
    if(doc.querySelector('parsererror')) throw new Error(`J-STAGE XML解析エラー (${term})`);
    const status=nodeText(doc,'result > status');
    if(status==='ERR_001') return [];
    if(status && status!=='0' && !status.startsWith('WARN_')) throw new Error(`J-STAGE ${status}`);
    return Array.from(doc.querySelectorAll('entry')).map(parseJStageEntry).filter(x=>x.link&&x.title).map(item=>({...item,description:`${item.description}\n\n検索語: ${term}`}));
  }finally{ dom.window.close(); }
}

function s2Authors(paper){ return (Array.isArray(paper?.authors)?paper.authors:[]).map(a=>text(a?.name)).filter(Boolean).slice(0,8).join(', '); }

function parseS2(paper, queryGroup){
  const title=text(paper?.title); const pdf=https(paper?.openAccessPdf?.url);
  if(!title || !pdf) return null;
  const abstract=text(paper?.abstract).slice(0,6000);
  const authors=s2Authors(paper); const venue=text(paper?.venue); const doi=text(paper?.externalIds?.DOI||paper?.externalIds?.doi);
  return {
    title, originalTitle:title, link:pdf, pubDate:date(paper?.publicationDate,paper?.year), year:Number(paper?.year)||0,
    author:authors||'Semantic Scholar', sourceName:'Semantic Scholar', venue, abstract, doi,
    citationCount:Number(paper?.citationCount||0), influentialCitationCount:Number(paper?.influentialCitationCount||0), hasOpenAccessPdf:true,
    description:[abstract,venue&&`掲載先: ${venue}`,authors&&`著者: ${authors}`,doi&&`DOI: ${doi}`,`被引用数: ${Number(paper?.citationCount||0)}`,`影響度付き引用: ${Number(paper?.influentialCitationCount||0)}`,queryGroup&&`独創検索: ${queryGroup.label}`,queryGroup&&`狙い: ${queryGroup.intent}`,'情報提供元: Semantic Scholar（公開PDF）'].filter(Boolean).join('\n\n'),
    sourceId:`creative-s2:${text(paper?.paperId||doi||pdf)}`
  };
}

async function searchS2(group, timeoutMs=16000){
  const url=new URL(S2_ENDPOINT);
  url.searchParams.set('query',group.semanticQuery);
  url.searchParams.set('fields','title,url,abstract,authors,venue,publicationDate,year,externalIds,openAccessPdf,publicationTypes,citationCount,influentialCitationCount,isOpenAccess,s2FieldsOfStudy');
  url.searchParams.set('sort','publicationDate:desc');
  url.searchParams.set('publicationDateOrYear','2010-01-01:');
  url.searchParams.set('limit',String(S2_LIMIT));
  const requestUrl=`${url.toString()}&openAccessPdf`;
  const headers={Accept:'application/json','User-Agent':'PersonalDashboardCreativePapers/2.2'};
  if(process.env.SEMANTIC_SCHOLAR_API_KEY) headers['x-api-key']=process.env.SEMANTIC_SCHOLAR_API_KEY;
  const response=await fetchRetry(requestUrl,{headers,timeoutMs});
  if(!response.ok){ const detail=await response.text().catch(()=> ''); throw new Error(`Semantic Scholar HTTP ${response.status} [${group.label}]${detail?`: ${detail.slice(0,120)}`:''}`); }
  const data=await response.json();
  return (Array.isArray(data?.data)?data.data:[]).map(p=>parseS2(p,group)).filter(Boolean);
}

function parseRss(xml, sourceName){
  const dom=new JSDOM(xml,{contentType:'text/xml'});
  try{
    const doc=dom.window.document;
    if(doc.querySelector('parsererror')) throw new Error(`${sourceName}: XML parse error`);
    return Array.from(doc.querySelectorAll('item, entry')).map(node=>{
      const title=firstText(node,['title'])||'無題'; let link=firstText(node,['link','guid','id']);
      if(!link){ const alt=Array.from(node.querySelectorAll('link')).find(el=>!el.getAttribute('rel')||el.getAttribute('rel')==='alternate'); link=alt?.getAttribute('href')||''; }
      const pdf=Array.from(node.querySelectorAll('link, rdfs\\:seeAlso, dc\\:identifier')).map(el=>el.getAttribute?.('href')||el.getAttribute?.('rdf:resource')||el.textContent||'').map(https).find(v=>/\.pdf(?:$|[?#])/i.test(v));
      const finalLink=pdf||https(link); if(!finalLink) return null;
      return { title:text(title), originalTitle:text(title), link:finalLink, pubDate:date(firstText(node,['pubDate','published','updated','dc\\:date','date'])), author:text(firstText(node,['dc\\:creator','creator','author > name','author'])||sourceName), sourceName, description:text(firstText(node,['description','summary','content','dc\\:description'])||title) };
    }).filter(Boolean);
  }finally{ dom.window.close(); }
}

async function searchCinii(){
  const appid=text(process.env.CINII_APP_ID); if(!appid) return {items:[],errors:[],disabled:'CINII_APP_ID未設定'};
  const terms=CREATIVE_PAPER_GROUPS.map(g=>g.jaKeywords[0]);
  const settled=await runConcurrency(terms,4,async term=>{
    const url=new URL(CINII_ENDPOINT); url.searchParams.set('appid',appid); url.searchParams.set('q',term); url.searchParams.set('count','60'); url.searchParams.set('sortorder','0'); url.searchParams.set('format','rss'); url.searchParams.set('lang','ja');
    const response=await fetch(url,{headers:{Accept:'application/rss+xml, application/xml','User-Agent':'PersonalDashboardCreativePapers/2.2'},signal:AbortSignal.timeout(8000)});
    if(!response.ok) throw new Error(`CiNII HTTP ${response.status}`);
    return parseRss(await response.text(),'CiNII Research').map(item=>({...item,description:`${item.description}\n\n検索語: ${term}`}));
  });
  const items=[]; const errors=[];
  settled.forEach(r=>r.status==='fulfilled'?items.push(...r.value):errors.push(r.reason?.message||'CiNII取得失敗'));
  return {items,errors};
}

function coreQuery(){
  return [
    'acoustic sensing state estimation', 'pouring wettability capillary', 'food microstructure sensory',
    'thermal haptic human factors', 'biomimetic digital twin sensing',
    'tribology haptic grip', 'psychophysics material perception', 'origami kirigami metamaterial',
    'collective behavior crowd dynamics', 'network science diffusion empirical', 'causal inference behavior natural experiment',
    'indoor environment cognition sleep', 'low-cost sensor computational imaging validation',
    'bio-inspired surface self-cleaning', 'droplet evaporation coffee-ring particle transport',
    'human AI decision trust experiment', 'complex network cascading failure resilience'
  ].join(' OR ');
}

async function searchCore(){
  const key=text(process.env.CORE_API_KEY); const url=new URL(CORE_ENDPOINT); url.searchParams.set('q',coreQuery()); url.searchParams.set('limit','100');
  const headers={Accept:'application/json','User-Agent':'PersonalDashboardCreativePapers/2.2'}; if(key) headers.Authorization=`Bearer ${key}`;
  const response=await fetch(url,{headers,signal:AbortSignal.timeout(12000)}); if(!response.ok) throw new Error(`CORE HTTP ${response.status}`);
  const data=await response.json(); const works=Array.isArray(data?.results)?data.results:Array.isArray(data?.data)?data.data:[];
  return works.map(work=>{
    const title=text(work?.title); if(!title) return null;
    const candidates=[work?.downloadUrl,work?.fullTextUrl,...(Array.isArray(work?.sourceFulltextUrls)?work.sourceFulltextUrls:[]),...(Array.isArray(work?.links)?work.links.map(l=>l?.url||l):[])].map(https).filter(Boolean);
    const link=candidates.find(v=>/\.pdf(?:$|[?#])/i.test(v))||candidates[0]||https(work?.doi?`https://doi.org/${work.doi}`:work?.url); if(!link) return null;
    const authors=(Array.isArray(work?.authors)?work.authors:[]).map(a=>text(a?.name||a)).filter(Boolean).join(', ');
    return { title,originalTitle:title,link,pubDate:date(work?.publishedDate||work?.datePublished||work?.yearPublished),year:Number(work?.yearPublished)||0,author:authors||'CORE',sourceName:'CORE',abstract:text(work?.abstract||work?.description),description:text(work?.abstract||work?.description||title),doi:text(work?.doi) };
  }).filter(Boolean);
}

async function searchIeee(){
  const key=text(process.env.IEEE_API_KEY); if(!key) return {items:[],disabled:'IEEE_API_KEY未設定'};
  const query='(acoustic sensing state estimation) OR (haptic friction perception) OR (origami kirigami metamaterial) OR (computational imaging low-cost sensor) OR (human AI decision trust) OR (digital twin thermal appliance) OR (human factors appliance usability)';
  const url=new URL(IEEE_ENDPOINT); url.searchParams.set('apikey',key); url.searchParams.set('querytext',query); url.searchParams.set('open_access','true'); url.searchParams.set('max_records','100'); url.searchParams.set('start_year','2010'); url.searchParams.set('sort_field','publication_year'); url.searchParams.set('sort_order','desc'); url.searchParams.set('format','json');
  const response=await fetch(url,{headers:{Accept:'application/json','User-Agent':'PersonalDashboardCreativePapers/2.2'},signal:AbortSignal.timeout(12000)}); if(!response.ok) throw new Error(`IEEE Xplore HTTP ${response.status}`);
  const data=await response.json();
  const items=(Array.isArray(data?.articles)?data.articles:[]).map(article=>{
    const title=text(article?.title); const doi=text(article?.doi); const link=https(article?.html_url||article?.abstract_url||(doi?`https://doi.org/${doi}`:'')); if(!title||!link) return null;
    return {title,originalTitle:title,link,pubDate:date(article?.publication_date||article?.publication_year),year:Number(article?.publication_year)||0,author:text(article?.authors?.authors?.map?.(a=>a?.full_name).filter(Boolean).join(', '))||'IEEE Xplore',sourceName:'IEEE Xplore OA',abstract:text(article?.abstract),description:text(article?.abstract||title),doi};
  }).filter(Boolean);
  return {items};
}

async function cachedProvider(key, ttl, worker, force=false){
  const cached=providerCache.get(key); if(!force&&cached&&Date.now()-cached.at<ttl) return cached.value;
  const value=await worker(); providerCache.set(key,{at:Date.now(),value}); while(providerCache.size>24) providerCache.delete(providerCache.keys().next().value); return value;
}

async function runConcurrency(items,limit,worker){
  const results=new Array(items.length); let cursor=0;
  async function runner(){ while(true){ const i=cursor++; if(i>=items.length) return; try{ results[i]={status:'fulfilled',value:await worker(items[i])}; }catch(reason){ results[i]={status:'rejected',reason}; } } }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},runner)); return results;
}

function dedupe(items){
  const seen=new Set();
  return items.filter(item=>{ const doi=text(item?.doi).toLowerCase(); const link=text(item?.link).replace(/[?#].*$/,'').toLowerCase(); const title=text(item?.originalTitle||item?.title).toLowerCase(); const key=doi?`doi:${doi}`:link?`url:${link}`:`title:${title}`; if(!key||seen.has(key)) return false; seen.add(key); return true; });
}

async function collectFast(){
  const [jstageSettled,s2Settled]=await Promise.all([
    runConcurrency(FAST_JSTAGE_TERMS,3,term=>searchJStage(term,8000)),
    Promise.allSettled(FAST_S2_DISCOVERY_QUERIES.map(group=>searchS2(group,9000)))
  ]);
  const errors=[];
  const jstage=jstageSettled.flatMap(r=>r.status==='fulfilled'?r.value:(errors.push(r.reason?.message||'J-STAGE取得失敗'),[]));
  const s2=s2Settled.flatMap(r=>r.status==='fulfilled'?r.value:(errors.push(r.reason?.message||'Semantic Scholar取得失敗'),[]));
  return {items:dedupe([...jstage,...s2]),errors,counts:{jstage:jstage.length,semantic:s2.length}};
}

async function collectDeep(force=false){
  const hasKey=Boolean(process.env.SEMANTIC_SCHOLAR_API_KEY);

  // S2を他プロバイダと並列に動かし、検索軸追加によるVercel実行時間の増加を抑える。
  const s2Task=(async()=>{
    const items=[]; const errors=[];
    for(let i=0;i<S2_DISCOVERY_QUERIES.length;i+=1){
      if(i>0) await sleep(hasKey?650:950);
      try{ items.push(...await searchS2(S2_DISCOVERY_QUERIES[i],12000)); }
      catch(err){ errors.push(err?.message||'Semantic Scholar取得失敗'); }
    }
    return {items,errors};
  })();

  const [s2Result,jstageSettled,ciniiResult,coreResult,ieeeResult]=await Promise.all([
    s2Task,
    runConcurrency(DEEP_JSTAGE_TERMS,4,term=>searchJStage(term,8000)),
    cachedProvider('creative-cinii-v22',DEEP_TTL,searchCinii,force).catch(error=>({items:[],errors:[error.message]})),
    cachedProvider('creative-core-v22',DEEP_TTL,searchCore,force).catch(error=>({items:[],errors:[error.message]})),
    cachedProvider('creative-ieee-v22',DEEP_TTL,searchIeee,force).catch(error=>({items:[],errors:[error.message]}))
  ]);

  const errors=[...(s2Result?.errors||[])];
  const jstage=jstageSettled.flatMap(r=>r.status==='fulfilled'?r.value:(errors.push(r.reason?.message||'J-STAGE取得失敗'),[]));
  for(const result of [ciniiResult,coreResult,ieeeResult]) if(Array.isArray(result?.errors)) errors.push(...result.errors);
  const s2Items=Array.isArray(s2Result?.items)?s2Result.items:[];
  const cinii=Array.isArray(ciniiResult?.items)?ciniiResult.items:[];
  const core=Array.isArray(coreResult?.items)?coreResult.items:[];
  const ieee=Array.isArray(ieeeResult?.items)?ieeeResult.items:[];
  return {items:dedupe([...jstage,...s2Items,...cinii,...core,...ieee]),errors,counts:{jstage:jstage.length,semantic:s2Items.length,cinii:cinii.length,core:core.length,ieee:ieee.length}};
}

export default async function handler(req,res){
  try{
    const mode=String(req.query?.mode||'deep').toLowerCase()==='fast'?'fast':'deep';
    const force=Boolean(req.query?._fresh||req.query?.refresh); const ttl=mode==='deep'?DEEP_TTL:FAST_TTL; const cache=caches[mode];
    if(!force&&cache.xml&&Date.now()-cache.at<ttl){
      res.setHeader('Content-Type','application/rss+xml; charset=utf-8'); res.setHeader('Cache-Control',mode==='deep'?'s-maxage=1800, stale-while-revalidate=3600':'s-maxage=600, stale-while-revalidate=1800'); res.setHeader('X-Papers-Track','creative'); return res.status(200).send(cache.xml);
    }
    const result=mode==='deep'?await collectDeep(force):await collectFast();
    const finalItems=dedupe(result.items).map(decorate).filter(Boolean).sort((a,b)=>b.pubDate.getTime()-a.pubDate.getTime()).slice(0,MAX_ITEMS);
    if(!finalItems.length){
      const stale=cache.xml||caches.deep.xml||caches.fast.xml;
      if(stale){ res.setHeader('Content-Type','application/rss+xml; charset=utf-8'); res.setHeader('Cache-Control','no-store'); res.setHeader('X-Papers-Stale','1'); return res.status(200).send(stale); }
      res.setHeader('Content-Type','application/rss+xml; charset=utf-8');
      return res.status(200).send(rssXml('独創研究','異分野の掛け合わせと検証性を重視した研究を取得中です。再読み込みで再試行します。',[]));
    }
    const counts=Object.entries(result.counts||{}).map(([k,v])=>`${k}:${v}`).join(' / ');
    const xml=rssXml('独創研究',[`「珍しいだけ」を除き、異分野の掛け合わせ・身近な疑問・実験/モデル/測定などの検証性を同時に満たす研究を選定。`,`検索軸は従来の応用発想に加え、摩擦×触覚、知覚心理×物理特性、幾何学×メタマテリアル、統計物理×群集、ネットワーク科学×拡散、因果推論×日常行動、環境×認知/睡眠、計算処理×安価センサ、生物表面×自己洗浄、液滴蒸発×乾燥模様、Human-AI×判断、複雑系×レジリエンス等の一般独創を含む。`,`取得内訳 ${counts}`].join(' '),finalItems);
    caches[mode]={at:Date.now(),xml};
    res.setHeader('Content-Type','application/rss+xml; charset=utf-8'); res.setHeader('Cache-Control',mode==='deep'?'s-maxage=1800, stale-while-revalidate=3600':'s-maxage=600, stale-while-revalidate=1800'); res.setHeader('X-Papers-Track','creative'); res.setHeader('X-Papers-Mode',mode); res.setHeader('X-Papers-Count',String(finalItems.length)); if(result.errors.length) res.setHeader('X-Papers-Partial-Errors',String(result.errors.length)); return res.status(200).send(xml);
  }catch(err){
    console.error('[creative-papers-feed]',err);
    const stale=caches.fast.xml||caches.deep.xml;
    if(stale){ res.setHeader('Content-Type','application/rss+xml; charset=utf-8'); res.setHeader('Cache-Control','no-store'); res.setHeader('X-Papers-Stale','1'); return res.status(200).send(stale); }
    res.setHeader('Content-Type','application/rss+xml; charset=utf-8'); res.setHeader('Cache-Control','no-store'); return res.status(200).send(rssXml('独創研究',`取得処理で一時エラーが発生しました: ${String(err?.message||'unknown').slice(0,180)}`,[]));
  }
}
