import { state, update } from '../../app/store.js';
import { el } from '../../shared/dom.js';
import { topbar, segmented } from '../../shared/components.js';
import { renderYouTube } from '../youtube/youtube.js';
import { renderTwitch } from '../twitch/twitch.js';
import { applyTheme } from '../../app/router.js';

export async function renderMedia(root,{navigate,refresh=false}){
  const mode=state.mediaMode||'youtube';const screen=el('section',{class:'screen'});screen.append(topbar('動画',{subtitle:'YouTube / Twitch',actions:[{label:'↻',title:'更新',onClick:()=>renderMedia(root,{navigate,refresh:true})},{label:'⚙︎',title:'設定',onClick:()=>navigate('settings')}]}));const segHost=el('div',{style:'margin-bottom:10px'});const host=el('div');screen.append(segHost,host);root.replaceChildren(screen);
  const renderSeg=()=>segHost.replaceChildren(segmented([{value:'youtube',label:'YouTube'},{value:'twitch',label:'Twitch'}],state.mediaMode,v=>{update('lastMediaMode',v);applyTheme();renderMedia(root,{navigate});}));renderSeg();if(mode==='twitch')await renderTwitch(host,{refresh});else await renderYouTube(host,{refresh});
}
