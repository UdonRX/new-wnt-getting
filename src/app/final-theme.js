const STYLE_ID='pdv2-final-theme-style';
const META={sunny:'#5b382e',cloudy:'#35414a',rain:'#23435e',snow:'#49616c',night:'#20254f'};

function kindFromCode(code){
  const c=Number(code);
  if((c>=71&&c<=77)||(c>=85&&c<=86))return'snow';
  if((c>=51&&c<=67)||(c>=80&&c<=82)||c>=95)return'rain';
  if(c<=2)return'sunny';
  return'cloudy';
}
function ensureStyles(){
  if(document.getElementById(STYLE_ID))return;
  const style=document.createElement('style');style.id=STYLE_ID;style.textContent=`
  :root{--app-weather-accent:#8398aa;--app-weather-accent-2:#b1bcc5;--app-weather-deep:#22303a;--app-shell-bg:color-mix(in srgb,#8398aa 12%,var(--bg))}
  html[data-app-weather="sunny"]{--app-weather-accent:#ff9c77;--app-weather-accent-2:#ffc18f;--app-weather-deep:#44261f;--app-shell-bg:color-mix(in srgb,#ff9c77 12%,var(--bg))}
  html[data-app-weather="cloudy"]{--app-weather-accent:#8398aa;--app-weather-accent-2:#b1bcc5;--app-weather-deep:#22303a;--app-shell-bg:color-mix(in srgb,#8398aa 12%,var(--bg))}
  html[data-app-weather="rain"]{--app-weather-accent:#4e9bdb;--app-weather-accent-2:#76c4e9;--app-weather-deep:#14334d;--app-shell-bg:color-mix(in srgb,#4e9bdb 13%,var(--bg))}
  html[data-app-weather="snow"]{--app-weather-accent:#a9d5e6;--app-weather-accent-2:#d8eef5;--app-weather-deep:#274454;--app-shell-bg:color-mix(in srgb,#d8eef5 14%,var(--bg))}
  html[data-app-weather="night"]{--app-weather-accent:#5669bd;--app-weather-accent-2:#7868bf;--app-weather-deep:#181c43;--app-shell-bg:color-mix(in srgb,#5669bd 15%,var(--bg))}
  html,body,#app-shell{background:var(--app-shell-bg,var(--bg))!important}body,#app-shell{min-height:100dvh}
  #edge-frame::before{border-color:color-mix(in srgb,var(--app-weather-accent) var(--edge-opacity-pct,38%),transparent)!important;box-shadow:0 0 var(--edge-glow,4px) var(--app-weather-accent),inset 0 0 var(--edge-glow,4px) var(--app-weather-accent)!important}
  #edge-frame::after{border-color:color-mix(in srgb,var(--app-weather-accent) 34%,transparent)!important}
  body.pdv2-home-fullscreen #edge-frame::before,body.pdv2-home-fullscreen #edge-frame::after{bottom:max(2px,env(safe-area-inset-bottom));border-radius:clamp(15px,4.8vw,24px)}
  `;document.head.append(style);
}
function resolveKind(state){
  try{
    const locations=state?.weatherLocations||[];
    const raw=Number(localStorage.getItem('pdv2:weatherIndex')||0);
    const index=Number.isFinite(raw)?Math.max(0,Math.min(locations.length-1,raw)):0;
    const location=locations[index];if(!location)return'cloudy';
    const cache=JSON.parse(localStorage.getItem(`pdv2:weatherCache:multi-source:${location.lat},${location.lon}`)||'null');
    if(!cache?.model)return'cloudy';
    const hour=new Date().getHours();
    return(hour<6||hour>=18)?'night':kindFromCode(cache.model?.current?.weather_code);
  }catch{return'cloudy';}
}
export function installFinalTheme({state}={}){
  ensureStyles();
  const sync=()=>{
    const kind=resolveKind(state),html=document.documentElement;
    html.dataset.appWeather=kind;document.body?.setAttribute('data-app-weather',kind);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',META[kind]||META.cloudy);
    return kind;
  };
  const onWeather=()=>sync();
  const onVisible=()=>{if(document.visibilityState==='visible')sync();};
  window.addEventListener('pdv2:weather-cache-updated',onWeather);
  window.addEventListener('pdv2:context-changed',onWeather);
  document.addEventListener('visibilitychange',onVisible,{passive:true});
  sync();
  return {sync,destroy(){window.removeEventListener('pdv2:weather-cache-updated',onWeather);window.removeEventListener('pdv2:context-changed',onWeather);document.removeEventListener('visibilitychange',onVisible);}};
}
