import { state, update } from '../../app/store.js';
import { el, openSheet, showToast } from '../../shared/dom.js';
import { topbar, segmented } from '../../shared/components.js';
import { fetchHourlyJmaModel, fetchOfficialJma, parseOfficialForecast, geocodeJapan } from './weather-api.js';
import { iconSvg, weatherVisual } from './weather-icons.js';

let mode = 'today';
let selectedIndex = Number(localStorage.getItem('pdv2:weatherIndex') || 0);

function pointFrom(data) {
  const h = data.hourly || {};
  const times = h.time || [];
  const now = Date.now();
  const found = times.findIndex(t => new Date(t).getTime() >= now - 30*60*1000);
  const start = Math.max(0, found < 0 ? 0 : found);
  const next = Array.from({length:12},(_,n)=>start+n).filter(i=>i<times.length);
  const rainy = next.find(i => Number(h.precipitation?.[i] || 0) >= .2);
  if (rainy != null) return { icon:'umbrella', text:`${new Date(times[rainy]).getHours()}時ごろから雨の可能性。傘があると安心です。` };
  const temps = next.map(i=>Number(h.temperature_2m?.[i])).filter(Number.isFinite);
  if (temps.length > 1) {
    const delta = temps.at(-1) - temps[0];
    if (delta <= -4) return { icon:'down', text:`このあと約${Math.abs(Math.round(delta))}℃下がる予想。服装に注意。` };
    if (delta >= 4) return { icon:'up', text:`このあと約${Math.round(delta)}℃上がる予想。暑さに注意。` };
  }
  const windy = next.find(i => Number(h.wind_speed_10m?.[i] || 0) >= 25);
  if (windy != null) return { icon:'wind', text:`${new Date(times[windy]).getHours()}時ごろ風が強まる予想です。` };
  return { icon:'check', text:'しばらく大きな天気変化はなさそうです。' };
}

function hourlyCards(data, wantedMode) {
  const h = data.hourly || {};
  const times = h.time || [];
  const now = new Date();
  let indexes = [];
  if (wantedMode === 'today') {
    indexes = times.map((t,i)=>[new Date(t),i]).filter(([d])=>d.toDateString()===now.toDateString() && d >= new Date(now.getTime()-30*60*1000)).map(x=>x[1]);
  } else {
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate()+1);
    indexes = times.map((t,i)=>[new Date(t),i]).filter(([d])=>d.toDateString()===tomorrow.toDateString()).map(x=>x[1]);
  }
  const strip = el('div',{class:'hourly-strip'});
  indexes.forEach(i => {
    const visual = weatherVisual(h.weather_code?.[i]);
    const card = el('div',{class:'hour-card'});
    card.innerHTML = `<div class="time">${new Date(times[i]).getHours()}時</div><div class="wx">${iconSvg(visual.icon,{size:27})}</div><strong>${Math.round(Number(h.temperature_2m?.[i] || 0))}°</strong><div class="rain">${Number(h.precipitation?.[i]||0)>0 ? `${Number(h.precipitation[i]).toFixed(1)}mm` : ''}</div>`;
    strip.append(card);
  });
  return strip;
}

function weekRows(data, official) {
  const d = data.daily || {};
  const grid = el('div',{class:'daily-grid'});
  (d.time || []).slice(0,7).forEach((date,i)=>{
    const o = official.find(x=>x.date===date);
    const visual = weatherVisual(d.weather_code?.[i]);
    const dt = new Date(`${date}T00:00:00`);
    const row = el('div',{class:'daily-row'});
    row.innerHTML = `<strong>${dt.toLocaleDateString('ja-JP',{weekday:'short'})}</strong><div class="daily-weather">${iconSvg(visual.icon,{size:22})}<span>${o?.weather || visual.label}</span></div><div class="daily-temp"><span class="temp-high">${Math.round(d.temperature_2m_max?.[i] ?? 0)}°</span><span class="temp-low">${Math.round(d.temperature_2m_min?.[i] ?? 0)}°</span></div>`;
    grid.append(row);
  });
  return grid;
}

function openLocationManager(onDone) {
  const wrap = el('div');
  let sheet;
  const draft = state.weatherLocations.map(loc=>({...loc}));

  const render = () => {
    wrap.replaceChildren();
    draft.forEach((loc,index)=>{
      const row = el('div',{class:'sheet-row'});
      row.append(
        el('span',{text:loc.name}),
        el('div',{class:'inline-actions'},[
          el('button',{class:'soft-button',type:'button',text:'↑',onclick:()=>{if(index>0){[draft[index-1],draft[index]]=[draft[index],draft[index-1]];render();}}}),
          el('button',{class:'soft-button',type:'button',text:'↓',onclick:()=>{if(index<draft.length-1){[draft[index+1],draft[index]]=[draft[index],draft[index+1]];render();}}}),
          el('button',{class:'soft-button',type:'button',text:'削除',onclick:()=>{draft.splice(index,1);render();}})
        ])
      );
      wrap.append(row);
    });
    wrap.append(el('button',{class:'soft-button full-button',type:'button',text:'地域を追加',onclick:()=>{
      sheet?.close(); openLocationAdd(onDone);
    }}));
    wrap.append(el('button',{class:'primary-button full-button',type:'button',text:'保存',onclick:()=>{
      update('weatherLocations',draft); selectedIndex=Math.min(selectedIndex,Math.max(0,draft.length-1)); localStorage.setItem('pdv2:weatherIndex',String(selectedIndex)); sheet?.close(); onDone();
    }}));
  };
  render();
  sheet=openSheet(wrap,{title:'天気の地域'});
}

function openLocationAdd(onDone) {
  const wrap = el('div'); let sheet;
  const box = el('div',{class:'field'}); box.append(el('label',{text:'市区町村・地域名'}));
  const input = el('input',{placeholder:'例：京都市、丸亀市、札幌市'}); box.append(input); wrap.append(box);
  const results = el('div',{class:'list'}); wrap.append(results);
  wrap.append(el('button',{class:'primary-button full-button',type:'button',text:'検索',onclick:async()=>{
    results.innerHTML='<div class="loading">検索中...</div>';
    try {
      const found = await geocodeJapan(input.value.trim());
      results.replaceChildren();
      found.forEach(place=>results.append(el('button',{class:'list-item',type:'button',html:`<div class="list-item-title">${place.displayName}</div><div class="list-meta">${place.lat.toFixed(3)}, ${place.lon.toFixed(3)}</div>`,onclick:()=>{
        const next=[...state.weatherLocations,{name:place.displayName.split(' / ')[0],lat:place.lat,lon:place.lon,jmaCode:place.jmaCode}];
        update('weatherLocations',next); selectedIndex=next.length-1; localStorage.setItem('pdv2:weatherIndex',String(selectedIndex)); sheet?.close(); showToast('地域を追加しました'); onDone();
      }})));
      if(!found.length) results.append(el('div',{class:'empty',text:'地域が見つかりませんでした'}));
    } catch(err){results.innerHTML=`<div class="error-box">${err.message}</div>`;}
  }}));
  sheet=openSheet(wrap,{title:'地域を追加'});
}

export async function renderWeather(root, { navigate, refresh=false }) {
  if (selectedIndex >= state.weatherLocations.length) selectedIndex = 0;
  const location = state.weatherLocations[selectedIndex];
  const screen = el('section',{class:'screen'});
  screen.append(topbar('天気',{subtitle:'気象庁 + JMA MSM 1時間予報',actions:[
    {label:'＋',title:'地域',onClick:()=>openLocationManager(()=>renderWeather(root,{navigate,refresh:true}))},
    {label:'↻',title:'更新',onClick:()=>renderWeather(root,{navigate,refresh:true})},
    {label:'⚙︎',title:'設定',onClick:()=>navigate('settings')}
  ]}));
  if (!location) { screen.append(el('div',{class:'empty',text:'地域を追加してください'})); root.replaceChildren(screen); return; }

  const locTabs = el('div',{class:'chips'});
  state.weatherLocations.forEach((loc,i)=>locTabs.append(el('button',{class:`chip ${i===selectedIndex?'active':''}`,type:'button',text:loc.name,onclick:()=>{selectedIndex=i;localStorage.setItem('pdv2:weatherIndex',String(i));renderWeather(root,{navigate});}})));
  screen.append(locTabs, el('div',{class:'card',html:'<div class="loading">天気を読み込み中...</div>'})); root.replaceChildren(screen);

  const cacheKey = `pdv2:weatherCache:${location.lat},${location.lon}`;
  let model, officialData;
  if (!refresh) {
    try { const c=JSON.parse(localStorage.getItem(cacheKey)||'null'); if(c && Date.now()-c.at<30*60*1000) { model=c.model; officialData=c.officialData; } } catch{}
  }
  try {
    if (!model) {
      [model, officialData] = await Promise.all([fetchHourlyJmaModel(location), fetchOfficialJma(location.jmaCode).catch(()=>null)]);
      localStorage.setItem(cacheKey,JSON.stringify({at:Date.now(),model,officialData}));
    }
    const official = parseOfficialForecast(officialData);
    const current = model.current || {};
    const visual = weatherVisual(current.weather_code);
    const point = pointFrom(model);
    const card = el('div',{class:'card weather-now'});
    card.innerHTML = `<div class="weather-location">${location.name}</div><div class="weather-main-icon">${iconSvg(visual.icon,{size:48})}</div><div class="weather-temp">${Math.round(Number(current.temperature_2m||0))}°</div><div class="weather-desc">${visual.label}</div><div class="weather-feels">体感 ${Math.round(Number(current.apparent_temperature||0))}° ・ 湿度 ${Math.round(Number(current.relative_humidity_2m||0))}% ・ 風 ${Math.round(Number(current.wind_speed_10m||0))}km/h</div>`;
    card.append(el('div',{class:'weather-point',html:`<span class="weather-point-icon">${iconSvg(point.icon,{size:20})}</span><span>${point.text}</span>`}));

    const tabsHost = el('div',{style:'margin:12px 0'});
    const detail = el('div');
    const renderMode = () => {
      tabsHost.replaceChildren(segmented([{value:'today',label:'今日'},{value:'tomorrow',label:'明日'},{value:'week',label:'週間'}],mode,v=>{mode=v;renderMode();}));
      detail.replaceChildren();
      if (mode==='week') detail.append(weekRows(model,official));
      else {
        detail.append(el('div',{class:'section-title'},[el('h2',{text:'1時間ごとの予報'}),el('small',{text:'横にスクロール'})]));
        detail.append(hourlyCards(model,mode));
      }
    };
    renderMode();
    screen.replaceChildren(screen.firstChild,locTabs,card,tabsHost,detail);
    root.replaceChildren(screen);
  } catch(err) {
    screen.append(el('div',{class:'error-box',text:err.message})); root.replaceChildren(screen);
  }
}
