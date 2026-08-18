import { el } from '../../shared/dom.js';

const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));

export function openImageViewer(images,startIndex=0){
  const list=[...new Set((images||[]).filter(Boolean))];
  if(!list.length)return;

  let index=clamp(Number(startIndex)||0,0,list.length-1);
  let scale=1,tx=0,ty=0;
  let gestureStart=null;
  const pointers=new Map();

  const overlay=el('div',{class:'image-viewer','aria-label':'画像ビューア'});
  const stage=el('div',{class:'image-viewer-stage'});
  const img=el('img',{class:'image-viewer-img',alt:'拡大画像',draggable:'false'});
  const close=el('button',{class:'image-viewer-close',type:'button','aria-label':'閉じる',text:'✕'});
  const count=el('div',{class:'image-viewer-count'});
  const reset=()=>{scale=1;tx=0;ty=0;apply();};
  const apply=()=>{img.style.transform=`translate3d(${tx}px,${ty}px,0) scale(${scale})`;};
  const show=()=>{img.src=list[index];count.textContent=list.length>1?`${index+1} / ${list.length}`:'';reset();};
  const change=dir=>{if(list.length<2)return;index=(index+dir+list.length)%list.length;show();};
  const distance=()=>{const a=[...pointers.values()];if(a.length<2)return 0;return Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y);};
  const midpoint=()=>{const a=[...pointers.values()];if(a.length<2)return {x:0,y:0};return {x:(a[0].x+a[1].x)/2,y:(a[0].y+a[1].y)/2};};

  close.onclick=()=>overlay.remove();
  overlay.addEventListener('click',e=>{if(e.target===overlay)overlay.remove();});
  stage.addEventListener('dblclick',()=>{if(scale>1)reset();else{scale=2.5;apply();}});

  stage.addEventListener('pointerdown',e=>{
    stage.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pointers.size===1){gestureStart={x:e.clientX,y:e.clientY,tx,ty,scale,time:Date.now()};}
    if(pointers.size===2){gestureStart={distance:distance(),scale,mid:midpoint(),tx,ty};}
  });
  stage.addEventListener('pointermove',e=>{
    if(!pointers.has(e.pointerId))return;
    pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pointers.size>=2&&gestureStart?.distance){
      const d=distance();
      scale=clamp(gestureStart.scale*(d/Math.max(1,gestureStart.distance)),1,5);
      apply();
      return;
    }
    if(pointers.size===1&&gestureStart?.x!=null){
      const dx=e.clientX-gestureStart.x,dy=e.clientY-gestureStart.y;
      if(scale>1){tx=gestureStart.tx+dx;ty=gestureStart.ty+dy;apply();}
      else{tx=dx*.28;apply();}
    }
  });
  const finishPointer=e=>{
    const prev=pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if(pointers.size===0&&gestureStart?.x!=null){
      const dx=(prev?.x??e.clientX)-gestureStart.x;
      const dt=Date.now()-gestureStart.time;
      if(scale<=1.01&&Math.abs(dx)>55&&dt<700){change(dx<0?1:-1);}
      else if(scale<=1.01)reset();
      gestureStart=null;
    }else if(pointers.size===1){
      const one=[...pointers.values()][0];
      gestureStart={x:one.x,y:one.y,tx,ty,scale,time:Date.now()};
    }
  };
  stage.addEventListener('pointerup',finishPointer);
  stage.addEventListener('pointercancel',finishPointer);
  stage.addEventListener('wheel',e=>{
    e.preventDefault();
    scale=clamp(scale+(e.deltaY<0?.25:-.25),1,5);
    if(scale===1){tx=0;ty=0;}
    apply();
  },{passive:false});

  stage.append(img);
  overlay.append(stage,close,count);
  document.getElementById('overlay-root').append(overlay);
  show();
}
