'use strict';
/* Offline-first photo editor: crops to the square shown on the canvas, supports
   pinch/drag, rotation, brightness, edge-connected background whitening and undo.
   Original photo bytes are never uploaded; only a compressed JPEG is returned. */
window.BarcodePhotoEditor=(()=>{
  const SIZE=320;
  const $=id=>document.getElementById(id);
  let source=null, whitenedSource=null, state=null, history=[],active=null, resolver=null, rejecter=null;
  let pointers=new Map(),lastGesture=null,gestureBefore=null,gestureMoved=false,sliderBefore={};
  const snapshot=()=>({...state});
  const changed=(a,b)=>['rotation','zoom','panX','panY','brightness','whiten'].some(key=>a[key]!==b[key]);
  function remember(previous){
    if(previous&&changed(previous,state)){
      history.push(previous);
      if(history.length>30)history.shift();
    }
    $('photo-edit-undo').disabled=history.length===0;
  }
  function updateControls(){
    $('photo-edit-zoom').value=String(state.zoom);
    $('photo-edit-zoom-value').textContent=Math.round(state.zoom*100)+'%';
    $('photo-edit-brightness').value=String(state.brightness);
    $('photo-edit-brightness-value').textContent=state.brightness+'%';
    $('photo-edit-white').setAttribute('aria-pressed',String(state.whiten));
    $('photo-edit-white').textContent=state.whiten?'背景の白色化：ON':'背景を白くする';
    $('photo-edit-undo').disabled=history.length===0;
  }
  function backgroundWhite(ctx,width,height){
    // The background should touch an image edge and resemble two or more corners.
    // Pixels connected to the sampled edge color are whitened; unrelated objects
    // inside the outline are not traversed.
    const frame=ctx.getImageData(0,0,width,height),data=frame.data;
    const corner=[
      2*width+2,2*width+(width-3),
      (height-3)*width+2,(height-3)*width+(width-3)
    ];
    const color=i=>[data[i*4],data[i*4+1],data[i*4+2]];
    const colors=corner.map(color);
    const dist=(a,b)=>Math.pow(a[0]-b[0],2)+Math.pow(a[1]-b[1],2)+Math.pow(a[2]-b[2],2);
    let cluster=[];
    for(let i=0;i<4;i++){
      const group=colors.filter(c=>dist(c,colors[i])<3600);
      if(group.length>cluster.length)cluster=group;
    }
    if(cluster.length<2)return;
    const sample=[0,1,2].map(k=>cluster.reduce((sum,c)=>sum+c[k],0)/cluster.length);
    const within=i=>{
      const p=i*4;
      const dr=data[p]-sample[0],dg=data[p+1]-sample[1],db=data[p+2]-sample[2];
      return dr*dr+dg*dg+db*db<6800;
    };
    const seen=new Uint8Array(width*height),queue=new Int32Array(width*height);
    let head=0,tail=0;
    function offer(i){
      if(i<0||i>=width*height||seen[i])return;
      seen[i]=1;
      if(within(i))queue[tail++]=i;
    }
    for(let x=0;x<width;x++){offer(x);offer((height-1)*width+x);}
    for(let y=1;y<height-1;y++){offer(y*width);offer(y*width+width-1);}
    while(head<tail){
      const i=queue[head++],p=i*4;
      data[p]=255;data[p+1]=255;data[p+2]=255;data[p+3]=255;
      if(i%width>0)offer(i-1);
      if(i%width<width-1)offer(i+1);
      if(i>=width)offer(i-width);
      if(i<width*(height-1))offer(i+width);
    }
    ctx.putImageData(frame,0,0);
  }
  function preparedImage(){
    if(!state.whiten)return source;
    if(whitenedSource)return whitenedSource;
    // Whiten within the original photo bounds, not the square preview padding.
    // Downsampling reduces memory use and keeps edits responsive on iOS.
    const ratio=Math.min(1,800/Math.max(source.width,source.height));
    const c=document.createElement('canvas');
    c.width=Math.max(4,Math.round(source.width*ratio));
    c.height=Math.max(4,Math.round(source.height*ratio));
    const ctx=c.getContext('2d',{willReadFrequently:true});
    if(!ctx)throw Error('背景を処理できませんでした。');
    ctx.drawImage(source,0,0,c.width,c.height);
    backgroundWhite(ctx,c.width,c.height);
    whitenedSource=c;
    return c;
  }
  function draw(){
    if(!state||!source)return;
    const canvas=$('photo-edit-canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.save();ctx.clearRect(0,0,SIZE,SIZE);
    ctx.fillStyle='#ffffff';ctx.fillRect(0,0,SIZE,SIZE);
    ctx.translate(SIZE/2+state.panX,SIZE/2+state.panY);
    const image=preparedImage();
    const swap=state.rotation%180!==0;
    const rotatedW=swap?image.height:image.width;
    const rotatedH=swap?image.width:image.height;
    const scale=Math.min(SIZE/rotatedW,SIZE/rotatedH)*state.zoom;
    ctx.scale(scale,scale);
    ctx.rotate(state.rotation*Math.PI/180);
    ctx.filter='brightness('+state.brightness+'%)';
    ctx.drawImage(image,-image.width/2,-image.height/2);
    ctx.restore();
  }
  function resetView(){
    state={rotation:0,zoom:1,panX:0,panY:0,brightness:100,whiten:false};
    history=[];sliderBefore={};
    updateControls();draw();
  }
  function close(data,error){
    const overlay=$('photo-edit-overlay');
    overlay.hidden=true;document.body.classList.remove('photo-editing');
    pointers.clear();lastGesture=null;gestureBefore=null;
    source=null;whitenedSource=null;state=null;history=[];
    const resolve=resolver,reject=rejecter;
    resolver=null;rejecter=null;active=null;
    if(error)reject?.(error);else resolve?.(data);
  }
  async function loadSource(input){
    if(input instanceof Blob){
      if(!input.type.startsWith('image/'))throw Error('画像ファイルを選択してください。');
      if(input.size>18*1024*1024)throw Error('18MB以下の写真を選択してください。');
    }else if(typeof input!=='string'||!/^data:image\/jpeg;base64,/.test(input)){
      throw Error('編集する写真がありません。');
    }
    const url=input instanceof Blob?URL.createObjectURL(input):input;
    try{
      const image=await new Promise((resolve,reject)=>{
        const img=new Image();
        img.onload=()=>resolve(img);
        img.onerror=()=>reject(Error('写真を読み込めませんでした。'));
        img.src=url;
      });
      if(!image.naturalWidth||!image.naturalHeight)throw Error('写真を読み込めませんでした。');
      const ratio=Math.min(1,1280/Math.max(image.naturalWidth,image.naturalHeight));
      const canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(image.naturalWidth*ratio));
      canvas.height=Math.max(1,Math.round(image.naturalHeight*ratio));
      const ctx=canvas.getContext('2d');
      if(!ctx)throw Error('写真の編集を開始できませんでした。');
      ctx.drawImage(image,0,0,canvas.width,canvas.height);
      return canvas;
    }finally{if(input instanceof Blob)URL.revokeObjectURL(url);}
  }
  function jpeg(){
    const canvas=$('photo-edit-canvas');
    let result=canvas.toDataURL('image/jpeg',0.68);
    if(window.BarcodePhotos.valid(result))return result;
    const small=document.createElement('canvas');
    small.width=240;small.height=240;
    const ctx=small.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,240,240);
    ctx.drawImage(canvas,0,0,240,240);
    result=small.toDataURL('image/jpeg',0.58);
    if(!window.BarcodePhotos.valid(result))throw Error('写真の容量が大きすぎます。');
    return result;
  }
  function open(input){
    if(active)return Promise.reject(Error('写真の編集画面は既に開いています。'));
    const promise=new Promise((resolve,reject)=>{resolver=resolve;rejecter=reject;});
    active=promise;
    const overlay=$('photo-edit-overlay');
    overlay.hidden=false;document.body.classList.add('photo-editing');
    $('photo-edit-status').textContent='写真を読み込んでいます…';
    $('photo-edit-apply').disabled=true;
    source=null;whitenedSource=null;state=null;
    loadSource(input).then(canvas=>{
      if(resolver===null)return;
      source=canvas;resetView();
      $('photo-edit-status').textContent='四角い枠が切り抜き範囲です。写真を動かすか、拡大して調整してください。';
      $('photo-edit-apply').disabled=false;
      $('photo-edit-cancel').focus();
    }).catch(err=>close(null,err));
    return promise;
  }
  function applyChange(fn){
    if(!state)return;
    const before=snapshot();fn();remember(before);updateControls();draw();
  }
  function sliderInput(type){
    if(!state)return;
    if(!sliderBefore[type])sliderBefore[type]=snapshot();
    const value=Number($(type==='zoom'?'photo-edit-zoom':'photo-edit-brightness').value);
    if(type==='zoom')state.zoom=Math.min(4,Math.max(1,value));
    else state.brightness=Math.min(160,Math.max(60,value));
    updateControls();draw();
  }
  function sliderChange(type){
    if(!state)return;
    remember(sliderBefore[type]);delete sliderBefore[type];updateControls();
  }
  function point(event){
    const rect=$('photo-edit-canvas').getBoundingClientRect();
    return{x:(event.clientX-rect.left)*SIZE/rect.width,y:(event.clientY-rect.top)*SIZE/rect.height};
  }
  function gesture(){
    const values=[...pointers.values()];
    if(!values.length)return null;
    const center={x:values.reduce((n,p)=>n+p.x,0)/values.length,y:values.reduce((n,p)=>n+p.y,0)/values.length};
    const distance=values.length>=2?Math.hypot(values[0].x-values[1].x,values[0].y-values[1].y):null;
    return {...center,distance,count:values.length};
  }
  function down(event){
    if(!state||event.pointerType==='mouse'&&event.button!==0)return;
    event.preventDefault();
    if(!pointers.size){gestureBefore=snapshot();gestureMoved=false;}
    pointers.set(event.pointerId,point(event));
    lastGesture=gesture();
    try{event.currentTarget.setPointerCapture(event.pointerId);}catch{}
  }
  function move(event){
    if(!state||!pointers.has(event.pointerId))return;
    event.preventDefault();
    pointers.set(event.pointerId,point(event));
    const now=gesture(),prev=lastGesture;
    if(prev&&now){
      state.panX=Math.min(SIZE,Math.max(-SIZE,state.panX+now.x-prev.x));
      state.panY=Math.min(SIZE,Math.max(-SIZE,state.panY+now.y-prev.y));
      if(prev.distance&&now.distance)state.zoom=Math.min(4,Math.max(1,state.zoom*now.distance/prev.distance));
      gestureMoved=true;
      updateControls();draw();
    }
    lastGesture=now;
  }
  function up(event){
    if(!pointers.has(event.pointerId))return;
    pointers.delete(event.pointerId);
    lastGesture=gesture();
    if(!pointers.size){
      if(gestureMoved)remember(gestureBefore);
      gestureBefore=null;gestureMoved=false;
      updateControls();
    }
  }
  function init(){
    const canvas=$('photo-edit-canvas');
    canvas.addEventListener('pointerdown',down);
    canvas.addEventListener('pointermove',move);
    canvas.addEventListener('pointerup',up);
    canvas.addEventListener('pointercancel',up);
    canvas.addEventListener('lostpointercapture',up);
    $('photo-edit-rotate-left').addEventListener('click',()=>applyChange(()=>{state.rotation=(state.rotation+270)%360;}));
    $('photo-edit-rotate-right').addEventListener('click',()=>applyChange(()=>{state.rotation=(state.rotation+90)%360;}));
    $('photo-edit-white').addEventListener('click',()=>applyChange(()=>{state.whiten=!state.whiten;}));
    $('photo-edit-zoom').addEventListener('input',()=>sliderInput('zoom'));
    $('photo-edit-zoom').addEventListener('change',()=>sliderChange('zoom'));
    $('photo-edit-brightness').addEventListener('input',()=>sliderInput('brightness'));
    $('photo-edit-brightness').addEventListener('change',()=>sliderChange('brightness'));
    $('photo-edit-undo').addEventListener('click',()=>{
      if(!state||!history.length)return;
      state=history.pop();sliderBefore={};updateControls();draw();
    });
    $('photo-edit-reset').addEventListener('click',()=>{
      if(!state)return;
      const prev=snapshot();resetView();remember(prev);
    });
    $('photo-edit-cancel').addEventListener('click',()=>{if(active)close(null);});
    $('photo-edit-apply').addEventListener('click',()=>{
      if(!active||!state)return;
      try{const data=jpeg();close(data);}catch(error){$('photo-edit-status').textContent=error.message;}
    });
    $('photo-edit-overlay').addEventListener('click',event=>{if(event.target.id==='photo-edit-overlay'&&active)close(null);});
    document.addEventListener('keydown',event=>{
      if(!active)return;
      if(event.key==='Escape'){event.preventDefault();close(null);}
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
  return Object.freeze({open});
})();
