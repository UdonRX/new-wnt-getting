import { warmTwitterFeeds } from './twitter.js';
import { instagramAccounts, instagramProfileUrl } from './instagram-accounts.js';
import { deleteInstagramCachesExcept, readInstagramCaches, writeInstagramCache } from './instagram-cache.js';

const PAGE_SIZE=12;
const CONCURRENCY=3;
let refreshJob=null;

function itemKey(item){return String(item?.id||`${item?.account?.username||''}:${item?.shortcode||''}`).trim()}
function itemTime(item){return Number(item?.timestamp||0)}
function mergeMedia(freshMedia,cachedMedia){
  const fresh=Array.isArray(freshMedia)?freshMedia:[],cached=Array.isArray(cachedMedia)?cachedMedia:[];
  return fresh.map((entry,index)=>{const old=cached[index]||{};return{...old,...entry,highResUrl:entry?.highResUrl||old?.highResUrl||'',width:entry?.width||old?.width||null,height:entry?.height||old?.height||null,qualityResolvedAt:entry?.qualityResolvedAt||old?.qualityResolvedAt||null}});
}
function mergeItem(fresh,cached){if(!cached)return fresh;return{...cached,...fresh,account:{...(cached.account||{}),...(fresh.account||{})},media:mergeMedia(fresh.media,cached.media)}}
function dedupeSort(items){const seen=new Set();return(Array.isArray(items)?items:[]).filter(item=>{const key=itemKey(item);if(!key||seen.has(key))return false;seen.add(key);return true}).sort((a,b)=>itemTime(b)-itemTime(a))}
function normalizeItem(item,username,responseAccount){return{
  source:'instagram',account:{...responseAccount,...(item.account||{})},id:item.id,externalId:item.externalId||null,shortcode:item.shortcode||null,text:String(item.text||''),timestamp:Number.isFinite(Number(item.timestamp))?Number(item.timestamp):null,timestampIso:item.timestampIso||null,media:Array.isArray(item.media)?item.media:[],mediaType:item.mediaType||'image',permalink:item.permalink||instagramProfileUrl(username),reelPermalink:item.reelPermalink||null
}}
async function fetchAccount(username){
  const query=new URLSearchParams({username,limit:String(PAGE_SIZE),t:String(Date.now())});
  const response=await fetch(`/api/instagram-profile?${query}`,{headers:{Accept:'application/json'},cache:'no-store',signal:AbortSignal.timeout(13000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.ok||!Array.isArray(data.items))throw new Error(data.error||`Instagram取得 HTTP ${response.status}`);
  const account=data.account||{username,profileUrl:instagramProfileUrl(username)};
  return{items:data.items.filter(item=>item?.source==='instagram').map(item=>normalizeItem(item,username,account)),nextCursor:data.hasMore&&data.nextCursor?String(data.nextCursor):''};
}
async function refreshInstagramAll(){
  const accounts=instagramAccounts();
  await deleteInstagramCachesExcept(accounts).catch(()=>{});
  if(!accounts.length)return{accounts:0,updated:0,failed:0};
  const records=await readInstagramCaches(accounts);
  let cursor=0,updated=0,failed=0;
  const worker=async()=>{
    while(cursor<accounts.length){
      const username=accounts[cursor++];
      try{
        const result=await fetchAccount(username);
        const old=records.get(username)||{username,items:[],nextCursor:'',checkedAt:0,updatedAt:0};
        const oldByKey=new Map((old.items||[]).map(item=>[itemKey(item),item]));
        const fresh=result.items.map(item=>mergeItem(item,oldByKey.get(itemKey(item))));
        const combined=dedupeSort([...fresh,...(old.items||[])]);
        const oldHadDeepHistory=(old.items||[]).length>result.items.length&&Boolean(old.nextCursor);
        const next={username,items:combined,nextCursor:oldHadDeepHistory?old.nextCursor:(result.nextCursor||''),checkedAt:Date.now(),updatedAt:Date.now()};
        records.set(username,next);
        await writeInstagramCache(next);
        updated+=1;
      }catch(error){
        failed+=1;
        console.warn('[home-instagram-refresh]',username,error?.message||error);
      }
    }
  };
  await Promise.all(Array.from({length:Math.min(CONCURRENCY,accounts.length)},()=>worker()));
  return{accounts:accounts.length,updated,failed};
}
function signal(service,detail={}){window.dispatchEvent(new CustomEvent('pdv2:service-seen',{detail:{service,source:'home-auto-refresh',at:Date.now(),...detail}}))}

export function refreshHomeSocialFeeds(){
  if(refreshJob)return refreshJob;
  refreshJob=(async()=>{
    const x=(async()=>{
      try{await warmTwitterFeeds({force:true});signal('x',{updated:true})}
      catch(error){console.warn('[home-x-refresh]',error?.message||error);signal('x',{updated:false})}
    })();
    const instagram=(async()=>{
      try{const result=await refreshInstagramAll();signal('instagram',{updated:result.failed===0,...result})}
      catch(error){console.warn('[home-instagram-refresh]',error?.message||error);signal('instagram',{updated:false})}
    })();
    await Promise.allSettled([x,instagram]);
  })().finally(()=>{refreshJob=null});
  return refreshJob;
}
