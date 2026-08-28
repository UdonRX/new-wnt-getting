const TAVILY_URL = 'https://api.tavily.com/search';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TTL = 24 * 60 * 60 * 1000;
const TOTAL_MS = 2700;
const TAVILY_MS = 1700;
const GEMINI_MS = 850;
const cache = new Map();
const inflight = new Map();
const blocked = ['x.com','twitter.com','facebook.com','instagram.com','tiktok.com','reddit.com','youtube.com','youtu.be'];
const tags = ['法改正','新技術','買収','投資','提携','発表','規制','決算','転換点','その他'];
const impacts = ['high','medium','low','unknown'];
const futureTypes = ['fact','expert','scenario'];
const LOG_PREFIX = '[READER_DEEP_DIVE_DEBUG]';

const schema = {
  type: 'object',
  properties: {
    timeline: { type: 'array', maxItems: 4, items: { type: 'object', properties: {
      date:{type:'string'}, tag:{type:'string',enum:tags}, text:{type:'string'}, metric:{type:'string'}, quote:{type:'string'}, sourceUrl:{type:'string'}
    }, required:['date','tag','text','metric','quote','sourceUrl'] } },
    perspectives: { type: 'array', maxItems: 2, items: { type: 'object', properties: {
      issue:{type:'string'}, views:{type:'array',maxItems:2,items:{type:'object',properties:{
        stance:{type:'string',enum:['推進','慎重','中立','異なる見方']}, actor:{type:'string'}, text:{type:'string'}, sourceUrl:{type:'string'}
      },required:['stance','actor','text','sourceUrl']}}
    }, required:['issue','views'] } },
    regionGap: { type: 'array', maxItems: 1, items: { type:'object', properties:{
      japan:{type:'string'}, overseas:{type:'string'}, japanSourceUrl:{type:'string'}, overseasSourceUrl:{type:'string'}
    },required:['japan','overseas','japanSourceUrl','overseasSourceUrl'] } },
    future: { type:'array', maxItems:3, items:{type:'object',properties:{
      type:{type:'string',enum:futureTypes}, timeframe:{type:'string',enum:['短期','中期','長期']}, actor:{type:'string'}, text:{type:'string'},
      impactMarket:{type:'string',enum:impacts}, impactLife:{type:'string',enum:impacts}, sourceUrl:{type:'string'}
    },required:['type','timeframe','actor','text','impactMarket','impactLife','sourceUrl']} },
    nextWatch: { type:'array', maxItems:2, items:{type:'object',properties:{date:{type:'string'},event:{type:'string'},sourceUrl:{type:'string'}},required:['date','event','sourceUrl']} }
  },
  required:['timeline','perspectives','regionGap','future','nextWatch']
};

function clean(v='', max=1200){return String(v||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,max)}
function clip(v='', max=72){const a=Array.from(clean(v,max+20));return a.length<=max?a.join(''):`${a.slice(0,max-1).join('')}…`}
function norm(v=''){return clean(v,1800).toLowerCase().replace(/[\s。、，,.!！?？:：;；"'“”‘’「」『』（）()【】\[\]<>〈〉《》]/g,'')}
function httpUrl(v=''){try{const u=new URL(String(v||''));return /^https?:$/.test(u.protocol)?u.href:''}catch{return ''}}
function host(v=''){try{return new URL(v).hostname.toLowerCase().replace(/^www\./,'')}catch{return ''}}
function left(start){return Math.max(0,TOTAL_MS-(Date.now()-start))}
function cacheKey(b){return clean(b.articleId||b.url||b.title,700).toLowerCase()}
function cacheGet(k){const h=cache.get(k);if(!h||Date.now()-h.ts>TTL){cache.delete(k);return null}return h.value}
function cacheSet(k,v){cache.set(k,{ts:Date.now(),value:v});while(cache.size>48)cache.delete(cache.keys().next().value)}
function traceId(){return `dd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`}
function countShape(v={}){return{timeline:Array.isArray(v?.timeline)?v.timeline.length:0,perspectives:Array.isArray(v?.perspectives)?v.perspectives.length:0,regionGap:Array.isArray(v?.regionGap)?v.regionGap.length:0,future:Array.isArray(v?.future)?v.future.length:0,nextWatch:Array.isArray(v?.nextWatch)?v.nextWatch.length:0}}
function safeError(error){return{name:clean(error?.name||'Error',80),message:clean(error?.message||String(error),500),status:Number(error?.statusCode||0)||undefined}}
function debugLog(event,id,data={}){
  try{console.log(`${LOG_PREFIX} ${JSON.stringify({event,traceId:id,ts:new Date().toISOString(),...data})}`)}catch{}
}

function queries(b){const seed=[clean(b.title,220),clean(b.source,90)].filter(Boolean).join(' ');return{
  timeline:`${seed} history timeline background key events turning points 経緯 発端 転換点 買収 投資 規制 技術`,
  perspectives:`${seed} reaction criticism support concern analyst expert Japan international media 反応 評価 懸念 専門家 海外 日本`,
  future:`${seed} next steps upcoming date outlook forecast analyst earnings approval launch integration schedule 今後 予定 見通し 専門家 決算 承認 日程`
}}

async function tavily(key, query, topic, timeRange, timeoutMs, lane, id){
  const started=Date.now();
  debugLog('tavily_start',id,{lane,topic,timeRange:timeRange||null,timeoutMs,query:clean(query,520)});
  const c=new AbortController();const t=setTimeout(()=>c.abort(),Math.max(250,timeoutMs));
  try{
    const r=await fetch(TAVILY_URL,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({
      query,search_depth:'basic',max_results:4,topic,time_range:timeRange,include_answer:false,include_raw_content:false,include_images:false,include_favicon:false,auto_parameters:false,safe_search:true,exclude_domains:blocked
    }),signal:c.signal});
    const d=await r.json().catch(()=>({}));
    if(!r.ok){const e=new Error(d?.detail?.error||d?.detail||`Tavily HTTP ${r.status}`);e.statusCode=r.status;throw e}
    const rawCount=Array.isArray(d?.results)?d.results.length:0;
    const rows=(Array.isArray(d?.results)?d.results:[]).map(x=>({title:clean(x?.title,240),url:httpUrl(x?.url),content:clean(x?.content,1000),score:Number(x?.score||0)}))
      .filter(x=>x.url&&x.content&&!blocked.some(z=>host(x.url)===z||host(x.url).endsWith(`.${z}`))).sort((a,b)=>b.score-a.score).slice(0,4);
    debugLog('tavily_success',id,{lane,status:r.status,elapsedMs:Date.now()-started,rawResultCount:rawCount,usableResultCount:rows.length,samples:rows.map(x=>({host:host(x.url),title:clip(x.title,100),score:Number(x.score.toFixed(3)),contentChars:x.content.length}))});
    return rows;
  }catch(error){
    debugLog('tavily_error',id,{lane,elapsedMs:Date.now()-started,error:safeError(error)});
    throw error;
  }finally{clearTimeout(t)}
}

function packet(groups){return Object.entries(groups).map(([k,rows])=>`\n## ${k.toUpperCase()}\n${rows.map((x,i)=>`[${k[0].toUpperCase()}${i+1}] URL: ${x.url}\nTITLE: ${x.title}\nCONTENT: ${x.content}`).join('\n')}`).join('\n')}
function instructions(){return [
  'あなたはニュース深掘りの編集者です。提供されたTavily検索結果だけを根拠に、日本語で簡潔・中立に構造化してください。',
  '外部知識やAI自身の推測で不足を補わない。根拠がない項目は空配列にする。sourceUrlは入力中のURLをそのまま使う。',
  'timelineは現在より前の重大な転換点のみ。年月が本文で確認できない項目は出さない。metricとquoteは本文に文字列として存在する場合だけ。',
  'perspectivesは実際に異なる主体・論拠が確認できる場合だけ。賛否を作らない。regionGapも国内外の差が別々の根拠で確認できる場合だけ。',
  'futureのfactは発表済み予定、expertは主体が確認できる専門家見解、scenarioは入力内の専門家・組織が述べた条件付き見通しだけ。AI自身の未来予測は禁止。',
  'nextWatchは具体的な時期と予定が本文で確認できるものだけ。各textは60文字程度まで。'
].join('\n')}

async function gemini(groups,b,start,id){
  const key=clean(process.env.GEMINI_API_KEY,300);
  const budget=Math.min(GEMINI_MS,left(start)-80);
  if(!key){debugLog('gemini_skipped',id,{reason:'missing_GEMINI_API_KEY',budgetMs:budget});return null}
  if(budget<350){debugLog('gemini_skipped',id,{reason:'insufficient_time_budget',budgetMs:budget,elapsedMs:Date.now()-start});return null}
  const model=clean(process.env.READER_DEEP_DIVE_MODEL||process.env.GEMINI_MODEL||'gemini-3.1-flash-lite',100);
  const c=new AbortController();const t=setTimeout(()=>c.abort(),budget);const started=Date.now();
  debugLog('gemini_start',id,{model,budgetMs:budget,groupCounts:{timeline:groups.timeline?.length||0,perspectives:groups.perspectives?.length||0,future:groups.future?.length||0}});
  try{
    const prompt=`CURRENT TITLE: ${clean(b.title,260)}\nCURRENT SOURCE: ${clean(b.source,120)}\nCURRENT CATEGORY: ${clean(b.category,120)}\nCURRENT SUMMARY: ${clean(b.summary,700)}\n${packet(groups)}`;
    const r=await fetch(`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},body:JSON.stringify({
      systemInstruction:{parts:[{text:instructions()}]},contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',responseJsonSchema:schema,maxOutputTokens:1600,temperature:0}
    }),signal:c.signal});
    const d=await r.json().catch(()=>({}));
    if(!r.ok){debugLog('gemini_http_error',id,{status:r.status,elapsedMs:Date.now()-started,error:clean(d?.error?.message||'Gemini HTTP error',500)});return null}
    const text=(d?.candidates?.[0]?.content?.parts||[]).map(p=>p?.text||'').join('').trim();
    if(!text){debugLog('gemini_empty',id,{status:r.status,elapsedMs:Date.now()-started});return null}
    try{
      const parsed=JSON.parse(text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));
      debugLog('gemini_success',id,{status:r.status,elapsedMs:Date.now()-started,textChars:text.length,rawCounts:countShape(parsed)});
      return parsed;
    }catch(error){debugLog('gemini_parse_error',id,{elapsedMs:Date.now()-started,textChars:text.length,error:safeError(error),textHead:clip(text,220)});return null}
  }catch(error){
    debugLog('gemini_error',id,{elapsedMs:Date.now()-started,error:safeError(error),budgetMs:budget});
    return null;
  }finally{clearTimeout(t)}
}

const months={january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',july:'07',august:'08',september:'09',october:'10',november:'11',december:'12',jan:'01',feb:'02',mar:'03',apr:'04',jun:'06',jul:'07',aug:'08',sep:'09',sept:'09',oct:'10',nov:'11',dec:'12'};
function dateOf(s=''){const x=clean(s,1400);let m=x.match(/\b((?:19|20)\d{2})[年./-]\s*(\d{1,2})?(?:月)?/);if(m)return m[2]?`${m[1]}.${String(m[2]).padStart(2,'0')}`:m[1];m=x.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+((?:19|20)\d{2})\b/i);return m?`${m[2]}.${months[m[1].toLowerCase()]}`:''}
function metricOf(s=''){const m=clean(s,1200).match(/(?:約|around|about)?\s*[+＋-]?\d[\d,.]*(?:\.\d+)?\s*(?:兆円|億円|万円|円|億ドル|百万ドル|万ドル|ドル|%|％|倍|人|件|社|台|GW|MW|kW|GWh|MWh|kWh|TB|GB|MB|billion|million|trillion)/i);return m?clean(m[0],34):''}
function tagOf(s=''){if(/法改正|改正法|legislation/i.test(s))return'法改正';if(/新技術|技術開発|technology|prototype|新製品/i.test(s))return'新技術';if(/買収|acqui(?:re|sition)/i.test(s))return'買収';if(/投資|investment|funding/i.test(s))return'投資';if(/提携|協業|partnership|alliance/i.test(s))return'提携';if(/規制|regulat/i.test(s))return'規制';if(/決算|earnings|results/i.test(s))return'決算';if(/発表|announce|launch/i.test(s))return'発表';return'転換点'}
function sentence(s='',max=72){const x=clean(s,1000);return clip(x.match(/^.*?[。！？!?](?:\s|$)/)?.[0]||x,max)}
function fallback(groups){const seen=new Set();const timeline=(groups.timeline||[]).map(x=>{const date=dateOf(`${x.title} ${x.content}`);const text=sentence(x.content);const k=`${date}:${norm(text).slice(0,60)}`;if(!date||!text||seen.has(k))return null;seen.add(k);return{date,tag:tagOf(`${x.title} ${x.content}`),text,metric:metricOf(x.content),quote:'',sourceUrl:x.url}}).filter(Boolean).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,4);
  const nextWatch=[];for(const x of groups.future||[]){const s=`${x.title} ${x.content}`;if(!/(予定|見込み|開催|発表|決算|承認|施行|発売|開始|完了|scheduled|expected|earnings|approval|launch|begin|complete)/i.test(s))continue;const date=dateOf(s);if(!date)continue;nextWatch.push({date,event:sentence(x.content,58),sourceUrl:x.url});if(nextWatch.length>=2)break}
  return{timeline,perspectives:[],regionGap:[],future:[],nextWatch}}

function evidenceMap(groups){const m=new Map();for(const rows of Object.values(groups))for(const x of rows)m.set(x.url,`${m.get(x.url)||''} ${x.title} ${x.content}`);return m}
function hasText(map,url,v){return norm(map.get(url)||'').includes(norm(v))}
function hasYear(map,url,v){const y=String(v||'').match(/\b(?:19|20)\d{2}\b/)?.[0];return !!(y&&String(map.get(url)||'').includes(y))}
function validate(raw,groups){const em=evidenceMap(groups);const allowed=new Set(em.keys());const ok=u=>allowed.has(httpUrl(u));
  const timeline=(Array.isArray(raw?.timeline)?raw.timeline:[]).map(x=>{const u=httpUrl(x?.sourceUrl);if(!ok(u)||!hasYear(em,u,x?.date))return null;return{date:clip(x.date,16),tag:tags.includes(x.tag)?x.tag:'その他',text:clip(x.text,72),metric:x.metric&&hasText(em,u,x.metric)?clip(x.metric,34):'',quote:x.quote&&hasText(em,u,x.quote)?clip(x.quote,74):'',sourceUrl:u}}).filter(x=>x?.date&&x?.text).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,4);
  const perspectives=(Array.isArray(raw?.perspectives)?raw.perspectives:[]).map(x=>{const views=(Array.isArray(x?.views)?x.views:[]).map(v=>{const u=httpUrl(v?.sourceUrl);if(!ok(u))return null;const actor=clip(v.actor,24),text=clip(v.text,66);return actor&&text?{stance:['推進','慎重','中立','異なる見方'].includes(v.stance)?v.stance:'中立',actor,text,sourceUrl:u}:null}).filter(Boolean).slice(0,2);if(views.length<2||new Set(views.map(v=>norm(v.actor))).size<2)return null;return{issue:clip(x.issue,18),views}}).filter(x=>x?.issue).slice(0,2);
  const regionGap=(Array.isArray(raw?.regionGap)?raw.regionGap:[]).map(x=>{const j=httpUrl(x?.japanSourceUrl),o=httpUrl(x?.overseasSourceUrl),jp=clip(x.japan,54),ov=clip(x.overseas,54);return ok(j)&&ok(o)&&j!==o&&jp&&ov&&norm(jp)!==norm(ov)?{japan:jp,overseas:ov,japanSourceUrl:j,overseasSourceUrl:o}:null}).filter(Boolean).slice(0,1);
  const future=(Array.isArray(raw?.future)?raw.future:[]).map(x=>{const u=httpUrl(x?.sourceUrl),actor=clip(x.actor,24),text=clip(x.text,68);if(!ok(u)||!futureTypes.includes(x?.type)||!text)return null;if((x.type==='expert'||x.type==='scenario')&&!actor)return null;if(x.type==='scenario'&&!/(場合|なら|可能性|見通し|予想|想定|could|may|if)/i.test(text))return null;return{type:x.type,timeframe:['短期','中期','長期'].includes(x.timeframe)?x.timeframe:'短期',actor,text,impactMarket:impacts.includes(x.impactMarket)?x.impactMarket:'unknown',impactLife:impacts.includes(x.impactLife)?x.impactLife:'unknown',sourceUrl:u}}).filter(Boolean).slice(0,3);
  const nextWatch=(Array.isArray(raw?.nextWatch)?raw.nextWatch:[]).map(x=>{const u=httpUrl(x?.sourceUrl);if(!ok(u)||!hasYear(em,u,x?.date))return null;const date=clip(x.date,18),event=clip(x.event,58);return date&&event?{date,event,sourceUrl:u}:null}).filter(Boolean).slice(0,2);
  return{timeline,perspectives,regionGap,future,nextWatch}}

async function run(b,start,id){
  const tavilyKey=clean(process.env.TAVILY_API_KEY,300);
  debugLog('run_start',id,{articleId:clip(b.articleId,160),title:clip(b.title,180),source:clip(b.source,100),category:clip(b.category,100),hasTavilyKey:Boolean(tavilyKey),hasGeminiKey:Boolean(clean(process.env.GEMINI_API_KEY,300)),budgets:{totalMs:TOTAL_MS,tavilyMs:TAVILY_MS,geminiMs:GEMINI_MS}});
  if(!tavilyKey){const e=new Error('TAVILY_API_KEY が設定されていません。');e.statusCode=503;debugLog('config_error',id,{missing:'TAVILY_API_KEY'});throw e}
  const q=queries(b);
  const calls=[
    ['timeline',tavily(tavilyKey,q.timeline,'general',null,Math.min(TAVILY_MS,left(start)),'timeline',id)],
    ['perspectives',tavily(tavilyKey,q.perspectives,'news','month',Math.min(TAVILY_MS,left(start)),'perspectives',id)],
    ['future',tavily(tavilyKey,q.future,'news','year',Math.min(TAVILY_MS,left(start)),'future',id)]
  ];
  const settled=await Promise.allSettled(calls.map(x=>x[1]));
  const groups={timeline:[],perspectives:[],future:[]};
  settled.forEach((r,i)=>{if(r.status==='fulfilled')groups[calls[i][0]]=r.value});
  debugLog('tavily_settled',id,{elapsedMs:Date.now()-start,lanes:calls.map((x,i)=>({lane:x[0],status:settled[i].status,count:settled[i].status==='fulfilled'?settled[i].value.length:0,error:settled[i].status==='rejected'?safeError(settled[i].reason):undefined})),sourceCount:new Set(Object.values(groups).flat().map(x=>x.url)).size});
  const fb=fallback(groups);
  debugLog('fallback_built',id,{counts:countShape(fb)});
  const raw=await gemini(groups,b,start,id);
  const validated=raw?validate(raw,groups):fb;
  debugLog('validation_complete',id,{geminiUsed:Boolean(raw),rawCounts:raw?countShape(raw):null,validatedCounts:countShape(validated),fallbackCounts:countShape(fb)});
  const value={articleId:b.articleId,generatedAt:Date.now(),timeline:validated.timeline?.length?validated.timeline:fb.timeline,perspectives:validated.perspectives||[],regionGap:validated.regionGap||[],future:validated.future||[],nextWatch:validated.nextWatch?.length?validated.nextWatch:fb.nextWatch,sourceCount:new Set(Object.values(groups).flat().map(x=>x.url)).size,partial:settled.some(r=>r.status!=='fulfilled')||!raw,elapsedMs:Date.now()-start,debugId:id};
  debugLog('run_complete',id,{elapsedMs:value.elapsedMs,partial:value.partial,sourceCount:value.sourceCount,finalCounts:countShape(value)});
  return value;
}

export default async function readerDeepDive(req,res){
  const id=traceId();
  if(req.method!=='POST'){debugLog('request_rejected',id,{reason:'method',method:req.method});res.setHeader('Allow','POST');return res.status(405).json({error:'Method Not Allowed',debugId:id})}
  const raw=req.body&&typeof req.body==='object'?req.body:{};
  const title=clean(raw.title,260);
  if(!title){debugLog('request_rejected',id,{reason:'missing_title'});return res.status(400).json({error:'title is required',debugId:id})}
  const b={articleId:clean(raw.articleId||raw.url||title,700),title,source:clean(raw.source,120),category:clean(raw.category,120),url:httpUrl(raw.url),summary:clean(raw.summary,700)};
  const key=cacheKey(b),hit=cacheGet(key);
  debugLog('request_received',id,{articleId:clip(b.articleId,160),title:clip(b.title,180),source:clip(b.source,100),category:clip(b.category,100),urlHost:host(b.url),summaryChars:b.summary.length,cacheHit:Boolean(hit),inflightHit:inflight.has(key)});
  if(hit){debugLog('cache_hit',id,{finalCounts:countShape(hit),sourceCount:Number(hit?.sourceCount||0),originalDebugId:hit?.debugId||''});return res.status(200).json({...hit,cache:'memory',debugId:id})}
  if(inflight.has(key)){
    debugLog('inflight_reuse',id,{});
    try{const value=await inflight.get(key);debugLog('inflight_complete',id,{finalCounts:countShape(value),sourceCount:Number(value?.sourceCount||0)});return res.status(200).json({...value,cache:'inflight',debugId:id})}
    catch(error){debugLog('inflight_error',id,{error:safeError(error)});return res.status(Number(error?.statusCode||500)).json({error:error?.message||'Deep dive failed',debugId:id})}
  }
  const start=Date.now();
  const p=run(b,start,id).then(v=>(cacheSet(key,v),v)).finally(()=>inflight.delete(key));
  inflight.set(key,p);
  try{
    res.setHeader('Cache-Control','private, max-age=0, no-store');
    return res.status(200).json(await p);
  }catch(error){
    const status=Number(error?.statusCode||500);
    debugLog('request_error',id,{status,elapsedMs:Date.now()-start,error:safeError(error)});
    console.error('[reader-deep-dive]',{traceId:id,status,message:error?.message||String(error)});
    return res.status(status).json({error:status===503?'Tavily APIを利用できません':'深掘り情報を取得できませんでした',detail:status===503?'VercelのTAVILY_API_KEYを確認してください。':'',debugId:id})
  }
}
