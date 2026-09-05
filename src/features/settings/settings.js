import { state, patchSettings } from '../../app/store.js';
import { el, showToast } from '../../shared/dom.js';
import { topbar } from '../../shared/components.js';
import { exportAll, importAll } from '../../shared/storage.js';
import { disconnectTwitchChat, hasTwitchChatToken } from '../twitch/twitch-chat.js';

function toggle(value,onChange){const b=el('button',{class:`toggle ${value?'on':''}`,type:'button','aria-pressed':String(value)});b.onclick=()=>{value=!value;b.classList.toggle('on',value);b.setAttribute('aria-pressed',String(value));onChange(value);};return b;}
function row(label,control,detail=''){const left=el('div');left.append(el('strong',{text:label}));if(detail)left.append(el('div',{class:'setting-detail',text:detail}));return el('div',{class:'setting-row'},[left,control]);}
function range(value,min,max,step,onChange){const input=el('input',{type:'range',min,max,step,value});input.addEventListener('input',()=>onChange(Number(input.value)));return input;}
function color(value,onChange){const input=el('input',{type:'color',class:'color-input',value});input.addEventListener('input',()=>onChange(input.value));return input;}
function downloadSettings(){const blob=new Blob([JSON.stringify(exportAll(),null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`dashboard-v2-settings-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
function importSettings(){const input=document.createElement('input');input.type='file';input.accept='application/json';input.onchange=async()=>{try{const p=JSON.parse(await input.files[0].text());importAll(p);showToast('設定を読み込みました');setTimeout(()=>location.reload(),600);}catch(err){showToast(err.message)}};input.click();}

export async function renderSettings(root,{navigate}){
  const s=state.settings;const screen=el('section',{class:'screen'});screen.append(topbar('設定',{subtitle:'見た目・データ・連携',actions:[{label:'←',title:'ホーム',onClick:()=>navigate('home')}]}));
  const appearance=el('div',{class:'card settings-section'});appearance.append(el('h2',{text:'画面の輪郭'}));appearance.append(row('機能ごとの輪郭色',toggle(s.edgeEnabled,v=>patchSettings({edgeEnabled:v})),'PWAの表示領域に控えめな色を付けます。画面の種類を色で思い出しやすくする補助表示です。'));
  appearance.append(row('太さ',range(s.edgeWidth,1,5,.5,v=>patchSettings({edgeWidth:v}))));appearance.append(row('透明度',range(s.edgeOpacity,.15,1,.05,v=>patchSettings({edgeOpacity:v}))));appearance.append(row('発光',range(s.edgeGlow,0,30,1,v=>patchSettings({edgeGlow:v}))));
  const colors=[['home','ホーム'],['weather','天気'],['news','ニュース'],['knowledge','知識'],['papers','論文'],['youtube','YouTube'],['twitch','Twitch'],['twitter','X'],['settings','設定']];colors.forEach(([k,l])=>appearance.append(row(`${l}の色`,color(s.colors[k],v=>patchSettings({colors:{[k]:v}})))));

  const behavior=el('div',{class:'card settings-section'});behavior.append(el('h2',{text:'動作'}));behavior.append(row('「いま押さえる」のAI補正',toggle(s.rankWithAi,v=>patchSettings({rankWithAi:v})),'表示はすぐ行い、AI評価は次回候補選定に使います。'));
  const density=el('select');[['low','少'],['normal','標準'],['high','多']].forEach(([v,l])=>density.append(el('option',{value:v,text:l})));density.value=s.twitchCommentDensity;density.onchange=()=>patchSettings({twitchCommentDensity:density.value});behavior.append(row('Twitch流れるコメント',density));

  const data=el('div',{class:'card settings-section'});data.append(el('h2',{text:'データ'}));data.append(row('設定を書き出す',el('button',{class:'soft-button',type:'button',text:'エクスポート',onclick:downloadSettings}),'新しいVercel URLへ移すときにも使えます。'));data.append(row('設定を読み込む',el('button',{class:'soft-button',type:'button',text:'インポート',onclick:importSettings})));
  data.append(row('Gemini接続',el('button',{class:'soft-button',type:'button',text:'確認',onclick:async()=>{try{const d=await fetch('/api/rank-items?mode=gemini-check&live=1').then(r=>r.json());showToast(d.message||d.error||'確認完了',3500);}catch{showToast('接続確認に失敗')}}})));
  data.append(row('Twitchコメント連携',el('button',{class:'soft-button',type:'button',text:hasTwitchChatToken()?'接続解除':'未接続',onclick:()=>{if(hasTwitchChatToken()){disconnectTwitchChat();showToast('Twitch連携を解除しました');location.reload();}else showToast('Twitch再生画面の「Twitch連携」から接続できます');}})));
  screen.append(appearance,behavior,data);root.replaceChildren(screen);
}
