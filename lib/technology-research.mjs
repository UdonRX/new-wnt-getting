import jsdomPackage from 'jsdom';
import { fetchRssSource, rssXml } from './rss-merge.mjs';
import { setAsciiHeader } from './http-response-safe.mjs';

const { JSDOM, VirtualConsole } = jsdomPackage;
const CACHE_TTL = 24*60*60*1000;
const VERSION = '生産技術8タブ-v10';
const CATEGORIES = ['生技基礎','改善事例','技術革新','論文・研究','製品・製造技術','異業種横展開'];
const WEB_CATEGORIES = CATEGORIES.filter(x=>x!=='論文・研究');
const WEB_REQUESTS = 10;
const DAILY_LIMIT = 10;
const memoryCache = {at:0,xml:'',items:[],meta:null};
const daily = {day:'',used:0};

const TOPIC_RE=/(生産技術|製造技術|工程|工場|製造|生産性|IE\b|QCD|品質|不良|歩留まり|OEE|稼働率|設備|保全|トレーサビリティ|MES|4M|タクト|セル生産|ラインバランス|標準時間|ECRS|Cp\b|Cpk|SPC|TPM|MTBF|MTTR|省人|自動化|真空断熱|炊飯|魔法瓶|加熱|温度制御|熱伝達|接合|溶接|コーティング|洗浄|成形|組立|センサ)/i;
const FOUNDATION_RE=/(基礎|基本|入門|とは|原理|手法|計算|算出|標準時間|工程分析|動作分析|時間研究|稼働分析|ECRS|セル生産|ラインバランス|QCD|OEE|IE\b|Cp\b|Cpk|SPC|TPM|MTBF|MTTR|5S)/i;
const CASE_RE=/(改善|事例|導入|実践|削減|短縮|向上|低減|省人|効率化|課題|対策|効果|before|after|\d+(?:\.\d+)?\s*(?:%|％|秒|分|時間|人|名|円))/i;
const INNOVATION_RE=/(新技術|技術革新|新工法|新製法|新素材|新構造|世界初|業界初|AI|画像認識|センシング|デジタルツイン|協働ロボット|AMR|3Dプリンタ|積層造形|予知保全|研究開発|実用化|量産化)/i;
const PRODUCT_RE=/(炊飯|米飯|真空断熱|魔法瓶|電気ケトル|保温|保冷|加熱|温度制御|熱伝達|断熱|蒸気|接合|溶接|ろう付け|コーティング|洗浄|表面処理|成形|組立|ヒーター|IH|センサ)/i;
const CROSS_RE=/(自動車|半導体|電子部品|食品|医薬|製薬|化学|物流|倉庫|航空|機械加工|金属加工|樹脂成形|鉄鋼|電池)/i;
const PRACTICAL_RE=/(方法|手順|仕組み|原理|計算|比較|KPI|効果|課題|原因|対策|注意点|失敗|改善|導入|検証|評価|測定|解析|可視化|設計|標準化)/i;
const PROMO_RE=/(キャンペーン|セール|割引|プレゼント|ランキング|購入はこちら|予約販売|クーポン|採用情報|求人)/i;
const LOW_VALUE_WEB_RE=/(市場レポート|市場規模|市場シェア|CAGR|QYResearch|市場調査|調査レポート|グローバル.*市場|研修(?:一覧|プログラム|コース)|セミナー(?:一覧|開催案内)|開催日\s*20\d{2}|受講(?:料|申込)|新入社員.*研修)/i;
const EVENT_TITLE_RE=/(?:提携)?セミナー|ウェビナー|講習会|開催案内|受講者募集|セミナー開催/i;
const EVENT_MARKERS=[/開催日時|開催日\s*20\d{2}/i,/受講(?:費|料|申込)|受講申し込み/i,/申込受付|お申し込み|お申込み/i,/LIVE配信|WEB限定セミナー|アーカイブ配信/i,/担当講師|定員\s*\d+/i,/提携セミナー|セミナー開催スケジュール/i];
const LOW_VALUE_URL_RE=/(?:^|\/)(?:seminars?|webinars?|events?|training|courses?)(?:\/|$)|\/page\/\d+\/?$/i;
const BLOCKED_DOMAIN_RE=/(?:^|\.)(?:prtimes\.jp|businesswire\.com|prnewswire\.com|makuake\.com|camp-fire\.jp|kickstarter\.com|kakaku\.com|amazon\.co\.jp|amazon\.com|rakuten\.co\.jp|shopping\.yahoo\.co\.jp)$/i;

const PAPER_QUERIES=['生産技術 IE 生産性','工程改善 ライン 生産システム','品質管理 工程能力 歩留まり','設備保全 OEE 稼働率','トレーサビリティ MES 製造','熱伝達 断熱 加熱 温度制御'];
const SEARCH_PLANS={
 '生技基礎':[
  {query:'製造業 生産技術 基礎 IE OEE 標準時間 工程分析 ECRS セル生産 ラインバランス タクト Cp Cpk SPC TPM MTBF MTTR トレーサビリティ MES'},
  {query:'生産技術 IE OEE セル生産 タクト 工程分析 品質管理 トレーサビリティ 標準時間 ECRS',domains:['note.com'],note:true}],
 '改善事例':[
  {query:'工場 改善事例 生産性 タクト 段取り OEE 省人化 ライン改善 品質改善 不良 歩留まり トレーサビリティ MES 予防保全'},
  {query:'生産技術 改善 タクト 設備 OEE 品質 省人化 治具 トレーサビリティ 段取り ラインバランス',domains:['note.com'],note:true}],
 '技術革新':[
  {query:'製造 新技術 AI 外観検査 センシング デジタルツイン 協働ロボット AMR 新工法 新素材 接合 コーティング 3Dプリンタ 予知保全'},
  {query:'製造 生産技術 新技術 AI ロボット センサ 新工法 予知保全 新素材 接合',domains:['note.com'],note:true}],
 '製品・製造技術':[
  {query:'炊飯器 魔法瓶 真空断熱 電気ケトル 家電 製造技術 熱伝達 断熱 加熱 温度制御 保温 蒸気 接合 溶接 コーティング 洗浄 センサ 成形 組立'},
  {query:'家電 製品開発 製造技術 断熱 加熱 温度制御 接合 コーティング 洗浄 炊飯 魔法瓶',domains:['note.com'],note:true}],
 '異業種横展開':[
  {query:'自動車 半導体 電子部品 食品 医薬 物流 鉄鋼 機械加工 樹脂成形 工場 改善 OEE 品質 トレーサビリティ 自動化 生産性 省人化'},
  {query:'自動車 半導体 食品 物流 工場 改善 生産技術 品質 OEE トレーサビリティ 自動化',domains:['note.com'],note:true}]
};

const SEEDS=[
 ['日本IE協会','IEとは','https://www.j-ie.com/about_ie/','IEの基本概念と、生産システムを定量的に設計・改善する考え方を学べる。'],
 ['日本IE協会','工程分析','https://www.j-ie.com/about_ie/methods/04/','材料・製品・作業者の流れを可視化し、工程のムダを見つける基本手法。'],
 ['日本IE協会','標準時間','https://www.j-ie.com/about_ie/term/04/','標準時間を生産計画・作業管理・原価の基準として使う考え方と基本計算。'],
 ['OMRON FA','OEEとは？7大ロスを見直して設備総合効率を改善','https://www.fa.omron.co.jp/product/special/maintenance-solution/column/column10/','OEEを時間稼働率×性能稼働率×良品率で分解し、設備ロス改善へつなげる方法。'],
 ['JMAC','IE・標準時間設定コンサルティング','https://www.jmac.co.jp/consulting/category/production/most.html','IE、稼働分析、工程分析、ライン分析、標準時間設定を体系的に整理した基礎解説。']
];

function clean(v='',max=2400){return String(v||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim().slice(0,max)}
function safeUrl(v=''){try{const m=String(v||'').match(/https?:\/\/[^\s<>"')\]】]+/i);const u=new URL((m?.[0]||String(v||'')).replace(/[.,、。!！?？;；:：]+$/g,''));return /^https?:$/.test(u.protocol)?u.href:''}catch{return''}}
function host(v=''){try{return new URL(v).hostname.replace(/^www\./,'').toLowerCase()}catch{return''}}
function blocked(v=''){return BLOCKED_DOMAIN_RE.test(host(v))}
function lowValueWebUrl(v=''){try{return LOW_VALUE_URL_RE.test(new URL(v).pathname)}catch{return false}}
function eventGuideLike(title='',summary='',url=''){if(lowValueWebUrl(url)||EVENT_TITLE_RE.test(title))return true;const text=`${title} ${summary}`;let hits=0;for(const re of EVENT_MARKERS)if(re.test(text))hits++;return hits>=2}
function dateInfo(v=''){if(v instanceof Date&&Number.isFinite(v.getTime())&&v.getTime()>0)return{date:v,precision:'日',year:String(v.getUTCFullYear())};const s=clean(v,80);if(/^(19|20)\d{2}$/.test(s)){const y=Number(s);return{date:new Date(Date.UTC(y,6,1)),precision:'年',year:s}}const d=new Date(s);return Number.isFinite(d.getTime())&&d.getTime()>0?{date:d,precision:'日',year:String(d.getUTCFullYear())}:{date:new Date(0),precision:'不明',year:''}}
function key(i){return String(i.url||i.title||'').replace(/[?#].*$/,'').trim().toLowerCase()}
function dedupe(a=[]){const s=new Set();return a.filter(i=>{const k=key(i);if(!i||!k||s.has(k))return false;s.add(k);return true})}
function application(text='',category=''){if(/OEE|稼働率|MTBF|MTTR|停止/.test(text))return'停止・速度・品質ロスを分解し、設備別KPIと停止理由の標準化に転用できる。';if(/トレーサビリティ|4M|ロット|検査履歴/.test(text))return'Lot No.に設備・部品・作業・検査結果をひも付け、異常時の影響範囲特定へ応用できる。';if(/タクト|セル生産|ラインバランス/.test(text))return'待ち・滞留・作業負荷を見える化し、ラインバランスと人員配置の改善に使える。';if(category==='生技基礎')return'考え方や計算方法を自工程の標準指標へ置き換え、改善前後の評価に使える。';if(category==='製品・製造技術')return'量産性、工程安定性、検査性、材料・設備条件へ分解し、新規開発や工程設計へ応用できる。';if(category==='異業種横展開')return'業種固有部分を外し、工程・設備・品質・データ活用の共通原理を自工程へ横展開できる。';return'手法・原理・定量効果を自工程の課題へ置き換え、改善や新規技術探索の着眼点に使える。'}
function item({category,title,url,summary,source,organization,date,image='',acquisition='',score=80,reason='条件に合致'}){const di=dateInfo(date),u=safeUrl(url),t=clean(title,320),s=clean(summary||title,1400);if(!category||!t||!u||!s||blocked(u))return null;return{category,title:t,url:u,summary:s,sourceLabel:source||host(u),organization:organization||source||host(u),application:application(`${t} ${s}`,category),pubDate:di.date,datePrecision:di.precision,pubYear:di.year,image:safeUrl(image),acquisition,relevance:score,usefulness:Math.min(100,score+5),selectionReason:reason}}
function seedItems(){return SEEDS.map(([source,title,url,summary])=>item({category:'生技基礎',source,organization:source,title,url,summary,date:'2024',acquisition:'公式基礎資料を直接収録',score:100,reason:'公式の基礎資料として事前選定'})).filter(Boolean)}
function xmlDom(xml){const vc=new VirtualConsole();return new JSDOM(xml,{contentType:'text/xml',virtualConsole:vc})}
function txt(n,selectors){for(const q of selectors){const v=n?.querySelector(q)?.textContent?.trim();if(v)return v}return''}

async function jstage(term){const u=new URL('https://api.jstage.jst.go.jp/searchapi/do');u.searchParams.set('service','3');u.searchParams.set('text',term);u.searchParams.set('count','40');const r=await fetch(u,{headers:{Accept:'application/atom+xml,application/xml,text/xml','User-Agent':'PersonalDashboardTechnologyResearch/10.0'},signal:AbortSignal.timeout(12000)});if(!r.ok)throw new Error(`J-STAGE HTTP ${r.status}`);const dom=xmlDom(await r.text());try{return [...dom.window.document.querySelectorAll('entry')].map(e=>{const title=txt(e,['article_title > ja','article_title > en','title']);const link=txt(e,['article_link > ja','article_link > en'])||e.querySelector('link')?.getAttribute('href')||txt(e,['id']);const summary=txt(e,['abstract > ja','abstract > en','summary','description'])||`掲載誌: ${txt(e,['material_title > ja','material_title > en'])}`;const full=txt(e,['pubdate','publication_date','online_pubdate','published']);const year=txt(e,['pubyear']);return item({category:'論文・研究',title,url:link,summary,source:'J-STAGE',organization:'J-STAGE',date:full||year,acquisition:`J-STAGE WebAPI（${term}）`,score:82,reason:'論文検索テーマに合致'})}).filter(Boolean)}finally{dom.window.close()}}
async function cinii(term){const u=new URL('https://cir.nii.ac.jp/opensearch/articles');u.searchParams.set('q',term);u.searchParams.set('count','40');u.searchParams.set('format','rss');u.searchParams.set('lang','ja');const rows=await fetchRssSource({name:`CiNii:${term}`,url:u.href,maxItems:40});return rows.map(x=>item({category:'論文・研究',title:x.title,url:x.link,summary:x.description,source:'CiNii Research',organization:x.author||'CiNii Research',date:x.pubDate,image:x.image,acquisition:`CiNii Research OpenSearch（${term}）`,score:80,reason:'論文検索テーマに合致'})).filter(Boolean)}
async function papers(){const settled=await Promise.allSettled(PAPER_QUERIES.flatMap(q=>[jstage(q),cinii(q)])),items=[],errors=[];for(const r of settled)r.status==='fulfilled'?items.push(...r.value):errors.push(String(r.reason?.message||r.reason));return{items:dedupe(items),errors}}
async function monoist(){try{const rows=await fetchRssSource({name:'MONOist',url:'https://rss.itmedia.co.jp/rss/2.0/monoist.xml',maxItems:100});return{items:rows.map(x=>{const text=`${x.title} ${x.description}`;let category='';if(PRODUCT_RE.test(text))category='製品・製造技術';else if(INNOVATION_RE.test(text)&&TOPIC_RE.test(text))category='技術革新';else if(CASE_RE.test(text)&&TOPIC_RE.test(text))category='改善事例';else if(FOUNDATION_RE.test(text)&&TOPIC_RE.test(text))category='生技基礎';else if(CROSS_RE.test(text)&&TOPIC_RE.test(text))category='異業種横展開';return category?item({category,title:x.title,url:x.link,summary:x.description,source:'MONOist',organization:x.author||'MONOist',date:x.pubDate,image:x.image,acquisition:'MONOist公式RSS',score:78,reason:'製造系専門媒体の記事として採用'}):null}).filter(Boolean),errors:[]}}catch(e){return{items:[],errors:[String(e?.message||e)]}}}

function reserve(){const d=new Date().toISOString().slice(0,10);if(daily.day!==d){daily.day=d;daily.used=0}if(daily.used>=DAILY_LIMIT)return false;daily.used++;return true}
async function tavily(plan,category){const apiKey=String(process.env.TAVILY_API_KEY||'').trim();if(!apiKey)throw new Error('TAVILY_API_KEY が設定されていません');if(!reserve())throw new Error('Tavily 1日検索上限に達しました');const body={query:plan.query,topic:'general',search_depth:'basic',max_results:20,include_answer:false,include_raw_content:false,include_images:false,exclude_domains:['prtimes.jp','businesswire.com','prnewswire.com','makuake.com','camp-fire.jp','kickstarter.com','kakaku.com','amazon.co.jp','amazon.com','rakuten.co.jp','shopping.yahoo.co.jp']};if(plan.domains)body.include_domains=plan.domains;const r=await fetch('https://api.tavily.com/search',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiKey}`},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(`Tavily ${category}: ${clean(data.detail||data.error||data.message||r.status,180)}`);return data.results||[]}
function webAccept(raw,category){const title=clean(raw.title,320),url=safeUrl(raw.url),summary=clean(raw.content||raw.description,1400),text=`${title} ${summary}`,isNote=host(url)==='note.com';if(!title||!url||!summary||blocked(url)||PROMO_RE.test(text)||LOW_VALUE_WEB_RE.test(text)||eventGuideLike(title,summary,url))return null;let score=Math.round((Number(raw.score)||0)*28);if(TOPIC_RE.test(text))score+=24;if(PRACTICAL_RE.test(text))score+=8;if(category==='生技基礎'&&FOUNDATION_RE.test(text))score+=24;if(category==='改善事例'&&CASE_RE.test(text))score+=24;if(category==='技術革新'&&INNOVATION_RE.test(text))score+=24;if(category==='製品・製造技術'&&PRODUCT_RE.test(text))score+=24;if(category==='異業種横展開'&&CROSS_RE.test(text)&&CASE_RE.test(text))score+=28;if(isNote)score+=4;if(score<36)return null;return item({category,title,url,summary,source:isNote?'note':host(url),organization:isNote?'note':host(url),date:raw.published_date||'',image:raw.image,acquisition:isNote?'Tavily note.com専用検索＋機械採点':'Tavily一般Web検索＋機械採点',score:Math.min(100,score),reason:`カテゴリ語・実務語・検索関連度から採用（score ${Math.min(100,score)}）`})}
async function webResearch(){const jobs=[];for(const c of WEB_CATEGORIES)for(const p of SEARCH_PLANS[c])jobs.push({c,p,promise:tavily(p,c)});const settled=await Promise.allSettled(jobs.map(x=>x.promise)),items=[],errors=[],stats=Object.fromEntries(WEB_CATEGORIES.map(c=>[c,{requests:0,requestErrors:0,candidates:0,accepted:0,noteCandidates:0,noteAccepted:0}]));settled.forEach((r,i)=>{const {c}=jobs[i],s=stats[c];s.requests++;if(r.status==='rejected'){s.requestErrors++;errors.push(`${c}: ${clean(r.reason?.message||r.reason,180)}`);return}for(const raw of r.value){s.candidates++;const n=host(raw.url)==='note.com';if(n)s.noteCandidates++;const x=webAccept(raw,c);if(x){items.push(x);s.accepted++;if(n)s.noteAccepted++}}});for(const c of WEB_CATEGORIES)console.info(`[technology-research][${c}]`,stats[c]);return{items:dedupe(items),errors,stats,configured:Boolean(process.env.TAVILY_API_KEY),requestsPlanned:WEB_REQUESTS,requestsSucceeded:settled.filter(x=>x.status==='fulfilled').length}}

function sorted(items){return dedupe(items).sort((a,b)=>{const ad=a.pubDate?.getTime?.()||0,bd=b.pubDate?.getTime?.()||0;return bd-ad||(b.relevance||0)-(a.relevance||0)})}
function toRss(items){return items.map(x=>({title:x.title,link:x.url,pubDate:x.pubDate,author:x.organization,sourceName:`技術リサーチ｜${x.category}｜${x.sourceLabel}`,image:x.image,description:['技術リサーチ: Web調査済み',`研究方式: ${VERSION}`,`対象企業/組織名: ${x.organization}`,`カテゴリ: ${x.category}`,`日付精度: ${x.datePrecision}`,x.pubYear?`公開年: ${x.pubYear}`:'',`概要: ${x.summary}`,`応用着眼点: ${x.application}`,`媒体: ${x.sourceLabel}`,`関連度: ${x.relevance}`,`有用度: ${x.usefulness}`,`選別理由: ${x.selectionReason}`,`取得方式: ${x.acquisition}`].filter(Boolean).join(' ｜ ')}))}
async function research(){if(memoryCache.xml&&Date.now()-memoryCache.at<CACHE_TTL)return memoryCache;const [p,m,w]=await Promise.all([papers(),monoist(),webResearch()]);const selected=sorted([...seedItems(),...p.items,...m.items,...w.items]);if(!selected.length)throw new Error('条件を満たす技術リサーチ記事を取得できませんでした');const categoryCounts=Object.fromEntries(CATEGORIES.map(c=>[c,selected.filter(x=>x.category===c).length]));const xml=rssXml('技術リサーチ',`24時間キャッシュ＋Tavily一般Web/note検索＋J-STAGE/CiNii/MONOist。条件合格記事を全件配信。今回${selected.length}件。`,toRss(selected));const meta={categoryCounts,paperErrors:p.errors.length,monoistErrors:m.errors.length,webErrors:w.errors.length,webStats:w.stats,tavilyConfigured:w.configured,tavilyRequestsPlanned:w.requestsPlanned,tavilyRequestsSucceeded:w.requestsSucceeded};Object.assign(memoryCache,{at:Date.now(),xml,items:selected,meta});console.info('[technology-research] final',{count:selected.length,...meta,tavilyDaily:`${daily.used}/${DAILY_LIMIT}`});return memoryCache}
function catHeader(c={}){return CATEGORIES.map(k=>`${k}=${Number(c[k]||0)}`).join(',')}
function candidateHeader(s={}){return WEB_CATEGORIES.map(c=>`${c}:${Number(s[c]?.candidates||0)}/${Number(s[c]?.accepted||0)}/note${Number(s[c]?.noteAccepted||0)}`).join(',')}
export async function technologyResearchFeed(req,res){if(req.method!=='GET')return res.status(405).json({error:'Method Not Allowed'});try{const r=await research();res.setHeader('Content-Type','application/rss+xml; charset=utf-8');res.setHeader('Cache-Control','public, s-maxage=86400, stale-while-revalidate=604800');res.setHeader('X-Technology-Research-Count',String(r.items.length));res.setHeader('X-Technology-Research-Version','10');res.setHeader('X-Technology-Research-Tavily',r.meta.tavilyConfigured?'configured':'missing-key');res.setHeader('X-Technology-Research-Tavily-Requests',`${r.meta.tavilyRequestsSucceeded}/${r.meta.tavilyRequestsPlanned}`);res.setHeader('X-Technology-Research-Tavily-Daily',`${daily.used}/${DAILY_LIMIT}`);setAsciiHeader(res,'X-Technology-Research-Categories',catHeader(r.meta.categoryCounts));setAsciiHeader(res,'X-Technology-Research-Candidates',candidateHeader(r.meta.webStats));return res.status(200).send(r.xml)}catch(e){console.error('[technology-research]',e);if(memoryCache.xml){res.setHeader('Content-Type','application/rss+xml; charset=utf-8');res.setHeader('Cache-Control','public, s-maxage=86400, stale-while-revalidate=604800');res.setHeader('X-Technology-Research-Stale','1');return res.status(200).send(memoryCache.xml)}return res.status(502).json({error:'技術リサーチを取得できませんでした',detail:clean(e?.message||e,500)})}}
