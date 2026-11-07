'use strict';
// JAN/EAN printing is generated locally. Scanning loads a pinned ZXing decoder only when requested.
const STORE_KEY = 'barcode-label-local-v1';
const CATALOG_KEY = 'barcode-label-catalog-v1';
const FOLDERS_KEY = 'barcode-label-folders-v1';
const DATA_KEY = 'barcode-label-data-v2';
let storageReadError = false;
let storedSnapshot = readSnapshot();
const LABEL_LAYOUT_KEY = 'barcode-label-print-layout-v1';
const LABEL_HEIGHT_KEY = 'barcode-label-print-height-mm-v1';
const MAX_FOLDERS = 50;
const MAX_FOLDER_NAME = 30;
const SCAN_LIBRARY_URL = 'https://unpkg.com/@zxing/browser@0.2.1/umd/zxing-browser.min.js';
const L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const R = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
const PARITY = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];
const $ = selector => document.querySelector(selector);
let records = readRecords();
let folders = readFolders();
let catalog = readCatalog();
let activeFolder = 'all';
let catalogFolderOpened = false;
let catalogSelectionMode = false;
let selectedCatalogIds = new Set();
let visibleCatalogIds = [];
let folderGesture = null;
let folderSuppressClickUntil = 0;
let folderIgnoreMouseUntil = 0;
let productGesture = null;
let productSuppressClickUntil = 0;
let productIgnoreMouseUntil = 0;
let editingCatalogId = null;
let editingId = null;
let scanControls = null;
let reader = null;
let decoderLoading = null;
let scanSession = 0;
let toastTimer = null;
let stagedPrintItems = [];
let labelHeightMm = readLabelHeight();
let labelLayout = readLabelLayout();
let printBusy = false;
let productSaving = false;
const catalogBarcodeObserver=typeof IntersectionObserver==='function'
  ?new IntersectionObserver(entries=>{
    for(const entry of entries){
      if(!entry.isIntersecting)continue;
      const target=entry.target;
      catalogBarcodeObserver.unobserve(target);
      if(!target.isConnected||!target.dataset.code)continue;
      target.append(createBarcodeSvg(target.dataset.code));
    }
  },{rootMargin:'250px'}):null;
let manualNameBreak = null;
let previousNameValue = '';

function normalizeCode(value) {
  const translated = String(value).replace(/[０-９]/g, ch=>String(ch.charCodeAt(0)-0xff10));
  const normalized = translated.replace(/[\s\u3000\-‐‑‒–—―－]/g,'');
  return /^\d*$/.test(normalized) ? normalized : null;
}
function checkDigit(body) {
  let sum=0;
  for (let i=body.length-1, weight=3;i>=0;i--,weight=weight===3?1:3) sum+=Number(body[i])*weight;
  return String((10-sum%10)%10);
}
function codeInfo(raw) {
  const code=normalizeCode(raw);
  if(code===null)return {ok:false,error:'数字以外の文字が含まれています。'};
  if(!code)return {ok:false,error:'番号を入力してください。'};
  const types={13:'JAN-13 / EAN-13',8:'JAN-8 / EAN-8',12:'UPC-A'};
  if(!types[code.length])return {ok:false,error:'13桁・8桁・12桁の番号に対応しています。'};
  const expected=checkDigit(code.slice(0,-1));
  if(code.at(-1)!==expected)return {ok:false,error:`番号に誤りがあります（末尾の正しいチェック数字は ${expected}）。`};
  return {ok:true,code,type:types[code.length]};
}
function barcodeBits(raw) {
  const code=raw.length===12?'0'+raw:raw;
  if(code.length===8){return '101'+Array.from(code.slice(0,4), d=>L[+d]).join('')+'01010'+Array.from(code.slice(4), d=>R[+d]).join('')+'101';}
  const parity=PARITY[+code[0]];
  let bits='101';
  for(let i=1;i<=6;i++)bits+=(parity[i-1]==='L'?L:G)[+code[i]];
  bits+='01010';
  for(let i=7;i<=12;i++)bits+=R[+code[i]];
  return bits+'101';
}
function svgElem(name,attrs={}) {
  const element=document.createElementNS('http://www.w3.org/2000/svg',name);
  for (const [key,value] of Object.entries(attrs))element.setAttribute(key,String(value));
  return element;
}
// For printed labels only: modest, proportional magnification where physical
// space permits. Compact 5/10mm and 15mm remain at their existing dimensions.
function printBarcodeMagnification(height,compact){
  if(compact||height<20)return 1;
  return height>=30?12/11:1.07;
}
function createBarcodeSvg(code,compact=false,miniature=false,magnification=1) {
  const info=codeInfo(code);
  if(!info.ok)throw Error(info.error);
  code=info.code;
  const bits=barcodeBits(code),isSmall=code.length===8,isUPC=code.length===12;
  const qleft=isSmall?7:isUPC?9:11,qright=isUPC?9:7;
  const modules=qleft+bits.length+qright;
  const small=miniature||compact,barHeight=small?40:22.85/.33,viewHeight=compact?44:small?54:81;
  const moduleWidth=.33*magnification;
  const svg=svgElem('svg',{xmlns:'http://www.w3.org/2000/svg',
    viewBox:`0 0 ${modules} ${viewHeight}`,width:`${(modules*moduleWidth).toFixed(2)}mm`,
    height:`${((small?17.82:26.73)*magnification).toFixed(2)}mm`,
    ...(compact?{preserveAspectRatio:'none'}:{}),role:'img','aria-label':`バーコード ${code}`});
  svg.append(svgElem('rect',{x:0,y:0,width:modules,height:viewHeight,fill:'#ffffff'}));
  let i=0;
  while(i<bits.length){
    if(bits[i]==='0'){i++;continue;}
    const first=i;
    while(i<bits.length&&bits[i]==='1')i++;
    const guard=first<3||first>=bits.length-3
      ||(first>=(bits.length-5)/2&&first<(bits.length+5)/2);
    svg.append(svgElem('rect',{x:qleft+first,y:0,width:i-first,
      height:guard?barHeight+(small?4:5):barHeight,fill:'#000000'}));
  }
  if(!compact){
  const text=svgElem('text',{x:modules/2,y:small?52.1:79,'text-anchor':'middle','font-size':'8.3',
    'font-family':'Arial, sans-serif','font-weight':'500',fill:'#000000','letter-spacing':'.45'});
  text.textContent=code;svg.append(text);
  }
  return svg;
}
// UTF-16 indices match selectionStart from the input field.
function normalizeNameBreak(name,index){
  if(typeof name!=='string'||!Number.isInteger(index)||index<=0||index>=name.length)return null;
  const a=name.charCodeAt(index-1),b=name.charCodeAt(index);
  if(a>=0xd800&&a<=0xdbff&&b>=0xdc00&&b<=0xdfff)return null;
  return index;
}
function reconcileNameBreak(oldName,newName,index){
  if(normalizeNameBreak(oldName,index)===null)return null;
  if(oldName===newName)return index;
  let prefix=0;
  while(prefix<oldName.length&&prefix<newName.length&&oldName[prefix]===newName[prefix])prefix++;
  let suffix=0;
  while(suffix<oldName.length-prefix&&suffix<newName.length-prefix
    &&oldName[oldName.length-1-suffix]===newName[newName.length-1-suffix])suffix++;
  const next=index<=prefix?index:index>=oldName.length-suffix?index+newName.length-oldName.length:null;
  return normalizeNameBreak(newName,next);
}
// A newly entered ideographic space explicitly requests a line break.
// Legacy names are never reinterpreted unless that space was newly inserted.
function insertedFullwidthSpace(before,after){
  if(before===after)return null;
  let prefix=0;
  while(prefix<before.length&&prefix<after.length&&before[prefix]===after[prefix])prefix++;
  let suffix=0;
  while(suffix<before.length-prefix&&suffix<after.length-prefix
    &&before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
  const offset=after.slice(prefix,after.length-suffix).indexOf('　');
  return offset<0?null:prefix+offset;
}
function keepBreakWhenEditing(oldName,newName,index){
  if(Number.isInteger(index)&&oldName[index]==='　'){
    let prefix=0;
    while(prefix<oldName.length&&prefix<newName.length&&oldName[prefix]===newName[prefix])prefix++;
    let suffix=0;
    while(suffix<oldName.length-prefix&&suffix<newName.length-prefix
      &&oldName[oldName.length-1-suffix]===newName[newName.length-1-suffix])suffix++;
    const moved=index<=prefix?index:index>=oldName.length-suffix?index+newName.length-oldName.length:null;
    return Number.isInteger(moved)&&newName[moved]==='　'?moved:null;
  }
  return reconcileNameBreak(oldName,newName,index);
}
function spaceBreakCount(name){return (name.match(/　/g)||[]).length;}
function tooManySpaceBreaks(name,index){
  return name[index]==='　'&&spaceBreakCount(name)>1;
}
function createLabel({code,name,nameBreak},compact=false){
  const container=document.createElement('div');container.className='product-label';
  container.dataset.singleLine=String(compact);
  container.dataset.layout=labelLayout;
  const body=document.createElement('div');body.className='label-body';
  const nameCell=document.createElement('div');nameCell.className='name-cell';
  const span=document.createElement('span');span.className='label-name-text';
  const text=name||'商品名',position=normalizeNameBreak(text,nameBreak);
  if(position!==null&&text[position]==='　'){
    const first=text.slice(0,position),second=text.slice(position+1);
    if(compact)span.textContent=first+' '+second;
    else span.append(document.createTextNode(first),document.createElement('br'),document.createTextNode(second));
  }else if(position!==null&&!compact){
    // Preserve a break explicitly saved by the previous version of the app.
    span.append(document.createTextNode(text.slice(0,position)),document.createElement('br'),
      document.createTextNode(text.slice(position)));
  }else span.textContent=text;
  nameCell.append(span);
  const barcodeCell=document.createElement('div');barcodeCell.className='barcode-cell';
  const scale=printBarcodeMagnification(labelHeightMm,compact);
  const svg=createBarcodeSvg(code,compact,labelHeightMm<30,scale);
  if(labelLayout==='vertical')svg.setAttribute('preserveAspectRatio','none');
  barcodeCell.style.setProperty('--barcode-width',svg.getAttribute('width'));
  barcodeCell.style.setProperty('--symbol-height',compact?(labelHeightMm===5?'3.9mm':'8.5mm')
    :`${((labelHeightMm<30?17.82:26.73)*scale).toFixed(2)}mm`);
  barcodeCell.append(svg);
  body.append(nameCell,barcodeCell);
  container.append(body);
  return container;
}
// Fit up to two lines, or one on 5mm/10mm labels, using the actual available space.
function fitLabelName(cell){
  const span=cell?.querySelector('.label-name-text');
  if(!span)return null;
  const style=getComputedStyle(cell),base=parseFloat(style.fontSize);
  const allowedHeight=cell.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom)-2;
  if(!(cell.clientWidth>0)||!(allowedHeight>0)||!(base>0))return null;
  const lines=cell.closest('.product-label')?.dataset.singleLine==='true'?1:2;
  function fits(size){
    span.style.fontSize=size.toFixed(3)+'px';
    const height=parseFloat(getComputedStyle(span).lineHeight);
    return span.scrollWidth<=span.clientWidth+1
      &&span.scrollHeight<=lines*height+2
      &&span.scrollHeight<=allowedHeight+1;
  }
  if(fits(base))return span.style.fontSize;
  let low=0.25,high=base;
  for(let i=0;i<19;i++){
    const middle=(low+high)/2;
    if(fits(middle))low=middle;else high=middle;
  }
  fits(low);
  return span.style.fontSize;
}
function fitPrintNames(){
  // Printed sheets are hidden until printing; measure their identical visible clones.
  const originals=$('#print-sheet').querySelectorAll('.label-name-text');
  document.querySelectorAll('#print-preview-pages .label-name-text').forEach((span,index)=>{
    const size=fitLabelName(span.parentElement);
    if(size&&originals[index])originals[index].style.fontSize=size;
  });
}
function setNameBreakState(position){
  const name=$('#name').value;
  manualNameBreak=normalizeNameBreak(name,position);
  previousNameValue=name;
  updateNameBreakStatus();
}
function updateNameBreakStatus(){
  const name=$('#name').value;
  const invalid=tooManySpaceBreaks(name,manualNameBreak);
  const text=$('#name-break-status');
  text.textContent=invalid?'全角スペースは改行指定として1か所までにしてください。'
    :'全角スペースで改行（1か所まで）';
  text.classList.toggle('invalid',invalid);
}

// One localStorage value is the commit point for products, print items and folders.
// Legacy keys are kept intact; they are read only until the first successful save.
function readSnapshot(){
  try{
    const text=localStorage.getItem(DATA_KEY);
    if(text===null)return null;
    const data=JSON.parse(text);
    if(data?.version!==1||!Array.isArray(data.catalog)
      ||!Array.isArray(data.records)||!Array.isArray(data.folders))throw Error('snapshot');
    return data;
  }catch{storageReadError=true;return null;}
}
function readStoredData(key){
  if(storageReadError)throw Error('保存データを読み取れません。元のデータを保護するため保存を停止しています。');
  if(storedSnapshot){
    const field=key===CATALOG_KEY?'catalog':key===STORE_KEY?'records':'folders';
    return JSON.stringify(storedSnapshot[field]);
  }
  return localStorage.getItem(key);
}
function persistState(nextCatalog=catalog,nextRecords=records,nextFolders=folders){
  if(storageReadError)throw Error('保存データを読み取れないため保存できません。バックアップをご確認ください。');
  const next={version:1,catalog:nextCatalog,records:nextRecords,folders:nextFolders};
  localStorage.setItem(DATA_KEY,JSON.stringify(next));
  storedSnapshot=next;
}

function readRecords(){
  try{
    const data=JSON.parse(readStoredData(STORE_KEY)||'[]');
    if(!Array.isArray(data))return [];
    return data.filter(x=>x&&typeof x.name==='string'&&x.name.length<=80&&codeInfo(x.code).ok).slice(0,200)
      .map(x=>({id:String(x.id||''),code:codeInfo(x.code).code,name:x.name,nameBreak:normalizeNameBreak(x.name,x.nameBreak),qty:Math.max(1,Math.min(99,Number(x.qty)||1)),selected:x.selected!==false}));
  }catch{return []}
}



function validateFolderName(name){
  if(typeof name!=='string')throw Error('フォルダ名を入力してください。');
  const value=name.trim();
  if(!value||value.length>MAX_FOLDER_NAME||/[\x00-\x1f\x7f]/.test(value)){
    throw Error('フォルダ名は1～30文字で入力してください。');
  }
  return value;
}
function validFolderId(value){
  return typeof value==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(value);
}
function readFolders(){
  try{
    const raw=JSON.parse(readStoredData(FOLDERS_KEY)||'[]');
    if(!Array.isArray(raw))return [];
    const ids=new Set(),names=new Set(),result=[];
    for(const item of raw){
      if(!item||!validFolderId(item.id))continue;
      let name;
      try{name=validateFolderName(item.name);}catch{continue;}
      const key=name.toLocaleLowerCase('ja');
      if(ids.has(item.id)||names.has(key))continue;
      ids.add(item.id);names.add(key);
      result.push({id:item.id,name});
      if(result.length===MAX_FOLDERS)break;
    }
    return result;
  }catch{return [];}
}
function resolveFolderId(id){
  return typeof id==='string'&&folders.some(f=>f.id===id)?id:null;
}
function folderName(id){
  return folders.find(f=>f.id===id)?.name||'未分類';
}
function persistFolders(nextFolders,nextCatalog=null){
  try{persistState(nextCatalog??catalog,records,nextFolders);}
  catch{throw Error('フォルダの保存に失敗しました。端末の空き容量をご確認ください。');}
  folders=nextFolders;
  if(nextCatalog!==null)catalog=nextCatalog;
  renderCatalog();
}
function addFolder(name){
  name=validateFolderName(name);
  if(folders.length>=MAX_FOLDERS)throw Error('フォルダは50個までです。');
  if(folders.some(f=>f.name.toLocaleLowerCase('ja')===name.toLocaleLowerCase('ja')))throw Error('同じ名前のフォルダがすでにあります。');
  const folder={id:makeId(),name};
  persistFolders([...folders,folder]);
  return folder;
}
function renameFolder(id,name){
  const existing=folders.find(f=>f.id===id);
  if(!existing)throw Error('フォルダが見つかりません。');
  name=validateFolderName(name);
  if(folders.some(f=>f.id!==id&&f.name.toLocaleLowerCase('ja')===name.toLocaleLowerCase('ja')))throw Error('同じ名前のフォルダがすでにあります。');
  persistFolders(folders.map(f=>f.id===id?{...f,name}:f));
}
function deleteFolder(id){
  const existing=folders.find(f=>f.id===id);
  if(!existing)throw Error('フォルダが見つかりません。');
  const count=catalog.filter(p=>p.folderId===id).length;
  if(!window.confirm('「'+existing.name+'」を削除しますか？\\n中の'+count+'商品は削除せず「未分類」に移動します。'))return false;
  const nextCatalog=catalog.map(p=>p.folderId===id?{...p,folderId:null}:p);
  persistFolders(folders.filter(f=>f.id!==id),nextCatalog);
  if(activeFolder===id){activeFolder='none';catalogFolderOpened=false;}
  renderCatalog();
  return true;
}
function changeProductFolders(ids,targetId){
  if(targetId!==null&&!folders.some(f=>f.id===targetId))throw Error('移動先フォルダがありません。');
  const idSet=new Set(ids),count=catalog.filter(p=>idSet.has(p.id)&&p.folderId!==targetId).length;
  if(!idSet.size)return 0;
  if(!count)return 0;
  const before=catalog;
  catalog=catalog.map(p=>idSet.has(p.id)?{...p,folderId:targetId}:p);
  if(!saveCatalog()){
    catalog=before;
    throw Error('商品の移動を保存できませんでした。');
  }
  renderCatalog();
  return count;
}
function renderFolderOptions(select,includeAll=false){
  const current=select.value;
  select.replaceChildren();
  if(includeAll){
    const option=document.createElement('option');option.value='all';option.textContent='すべての商品';select.append(option);
  }
  const unclassified=document.createElement('option');unclassified.value='';unclassified.textContent='未分類';select.append(unclassified);
  for(const folder of folders){
    const option=document.createElement('option');option.value=folder.id;option.textContent=folder.name;select.append(option);
  }
  select.value=[...select.options].some(x=>x.value===current)?current:(includeAll?'all':'');
}

/* Folder order: touch-and-hold or mouse hold, leaving the two built-in folders fixed. */
function reorderFolder(sourceId,targetId){
  const from=folders.findIndex(x=>x.id===sourceId);
  const to=folders.findIndex(x=>x.id===targetId);
  if(from<0||to<0||from===to)return false;
  const next=[...folders];
  const [moved]=next.splice(from,1);
  next.splice(to,0,moved);
  persistFolders(next);
  return true;
}
function clearFolderGesture(){
  const gesture=folderGesture;
  if(!gesture)return;
  clearTimeout(gesture.timer);
  gesture.source.classList.remove('folder-is-dragging');
  const grid=$('#folder-grid');
  grid.classList.remove('folder-sort-active');
  for(const card of grid.querySelectorAll('.folder-drop-target'))card.classList.remove('folder-drop-target');
  gesture.ghost?.remove();
  folderGesture=null;
}
function beginFolderDragging(){
  const gesture=folderGesture;
  if(!gesture||!folders.some(f=>f.id===gesture.id))return;
  gesture.dragging=true;
  folderSuppressClickUntil=Date.now()+800;
  gesture.source.classList.add('folder-is-dragging');
  $('#folder-grid').classList.add('folder-sort-active');
  const bounds=gesture.source.getBoundingClientRect();
  const ghost=gesture.source.cloneNode(true);
  ghost.classList.add('folder-drag-ghost');
  ghost.setAttribute('aria-hidden','true');
  ghost.style.left=bounds.left+'px';
  ghost.style.top=bounds.top+'px';
  ghost.style.width=bounds.width+'px';
  ghost.style.height=bounds.height+'px';
  ghost.style.transform='translate(0px, 0px)';
  document.body.append(ghost);
  gesture.ghost=ghost;
}
function startFolderPress(event,kind){
  if(folderGesture)return;
  if(kind==='mouse'&&(event.button!==0||Date.now()<folderIgnoreMouseUntil))return;
  const view=event.target.closest('.folder-open');
  if(!view||!$('#folder-grid').contains(view))return;
  const id=view.dataset.folderId;
  if(!folders.some(f=>f.id===id))return;
  const touch=kind==='touch'?event.touches.length===1?event.touches[0]:null:null;
  if(kind==='touch'&&!touch)return;
  const startX=kind==='touch'?touch.clientX:event.clientX;
  const startY=kind==='touch'?touch.clientY:event.clientY;
  if(kind==='touch')folderIgnoreMouseUntil=Date.now()+900;
  const gesture={
    id,kind,identifier:touch?.identifier,startX,startX,startX0:startX,startY,
    x:startX,y:startY,source:view.parentElement,dragging:false,dropId:null,
    ghost:null,timer:null
  };
  gesture.timer=setTimeout(beginFolderDragging,480);
  folderGesture=gesture;
}
function moveFolderPress(event,kind){
  const gesture=folderGesture;
  if(!gesture||gesture.kind!==kind)return;
  const touch=kind==='touch'?[...event.touches].find(t=>t.identifier===gesture.identifier):null;
  if(kind==='touch'&&!touch){clearFolderGesture();return;}
  const x=kind==='touch'?touch.clientX:event.clientX;
  const y=kind==='touch'?touch.clientY:event.clientY;
  gesture.x=x;gesture.y=y;
  if(!gesture.dragging){
    if(Math.hypot(x-gesture.startX,y-gesture.startY)>12)clearFolderGesture();
    return;
  }
  if(event.cancelable)event.preventDefault();
  gesture.ghost.style.transform='translate('+(x-gesture.startX)+'px,'+(y-gesture.startY)+'px)';
  const atPoint=document.elementFromPoint(x,y);
  const card=atPoint?.closest('.folder-list-item');
  const target=card?.dataset.folderId;
  const nextId=target!==gesture.id&&folders.some(f=>f.id===target)?target:null;
  if(nextId===gesture.dropId)return;
  for(const el of $('#folder-grid').querySelectorAll('.folder-drop-target'))el.classList.remove('folder-drop-target');
  if(nextId)card.classList.add('folder-drop-target');
  gesture.dropId=nextId;
}
function endFolderPress(event,kind,commit=true){
  const gesture=folderGesture;
  if(!gesture||gesture.kind!==kind)return;
  if(kind==='touch'&&event.changedTouches&&![...event.changedTouches].some(t=>t.identifier===gesture.identifier))return;
  const wasDragging=gesture.dragging;
  const source=gesture.id,target=gesture.dropId;
  if(wasDragging){
    if(event.cancelable)event.preventDefault();
    folderSuppressClickUntil=Date.now()+600;
  }
  clearFolderGesture();
  if(!wasDragging||!commit||!target)return;
  try{
    if(reorderFolder(source,target))toast('フォルダの順番を保存しました。');
  }catch(error){toast(error.message,'error');}
}
function installFolderReordering(){
  const grid=$('#folder-grid');
  grid.addEventListener('touchstart',event=>startFolderPress(event,'touch'),{passive:true});
  document.addEventListener('touchmove',event=>moveFolderPress(event,'touch'),{passive:false});
  document.addEventListener('touchend',event=>endFolderPress(event,'touch'),{passive:false});
  document.addEventListener('touchcancel',event=>endFolderPress(event,'touch',false));
  grid.addEventListener('mousedown',event=>startFolderPress(event,'mouse'));
  document.addEventListener('mousemove',event=>moveFolderPress(event,'mouse'));
  document.addEventListener('mouseup',event=>endFolderPress(event,'mouse'));
  window.addEventListener('blur',clearFolderGesture);
  grid.addEventListener('contextmenu',event=>{
    if(event.target.closest('.folder-open')?.dataset.folderId
      &&folders.some(f=>f.id===event.target.closest('.folder-open').dataset.folderId)){
      event.preventDefault();
    }
  });
}

function openCatalogFolder(folderId){
  activeFolder=folderId;
  catalogFolderOpened=true;
  catalogSelectionMode=false;
  selectedCatalogIds.clear();
  $('#catalog-search').value='';
  renderCatalog();
  window.scrollTo({top:0,behavior:'auto'});
}
function renderFolders(){
  const list=$('#folder-grid');
  list.replaceChildren();
  const allCount=catalog.length,noneCount=catalog.filter(p=>!resolveFolderId(p.folderId)).length;
  const items=[{id:'all',name:'すべての商品',count:allCount},
    {id:'none',name:'未分類',count:noneCount},
    ...folders.map(f=>({...f,count:catalog.filter(p=>p.folderId===f.id).length}))];
  for(const folder of items){
    const item=document.createElement('div');item.className='folder-list-item';
    item.dataset.folderId=folder.id;
    const view=document.createElement('button');view.type='button';view.className='folder-open';
    view.dataset.folderId=folder.id;
    view.setAttribute('aria-pressed',String(activeFolder===folder.id));
    const glyph=document.createElement('span');glyph.className='folder-glyph';glyph.setAttribute('aria-hidden','true');
    glyph.textContent=folder.id==='all'?'▤':folder.id==='none'?'▢':'▣';
    const data=document.createElement('span');data.className='folder-info';
    const name=document.createElement('span');name.className='folder-name';name.textContent=folder.name;
    const qty=document.createElement('span');qty.className='folder-count';qty.textContent=folder.count+'商品';
    data.append(name,qty);
    const arrow=document.createElement('span');arrow.className='folder-chevron';arrow.textContent='›';arrow.setAttribute('aria-hidden','true');
    view.append(glyph,data,arrow);
    if(folder.id!=='all'&&folder.id!=='none'){
      view.addEventListener('keydown',event=>{
        if(!event.altKey||!['ArrowLeft','ArrowUp','ArrowRight','ArrowDown'].includes(event.key))return;
        event.preventDefault();
        const index=folders.findIndex(f=>f.id===folder.id);
        const step=event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:1;
        const target=folders[index+step];
        if(!target)return;
        try{
          if(reorderFolder(folder.id,target.id)){
            const focused=[...$('#folder-grid').querySelectorAll('.folder-open')]
              .find(button=>button.dataset.folderId===folder.id);
            focused?.focus();
            toast('フォルダの順番を保存しました。');
          }
        }catch(error){toast(error.message,'error');}
      });
    }
    view.addEventListener('click',event=>{
      if(Date.now()<folderSuppressClickUntil){event.preventDefault();return;}
      openCatalogFolder(folder.id);
    });
    item.append(view);
    list.append(item);
  }
  renderFolderOptions($('#folder-select'));
  renderFolderOptions($('#bulk-folder-target'));
}
function updateBulkSelection(){
  selectedCatalogIds=new Set([...selectedCatalogIds].filter(id=>catalog.some(x=>x.id===id)));
  $('#bulk-count').textContent=selectedCatalogIds.size+'件選択中';
  $('#bulk-move').disabled=selectedCatalogIds.size===0;
  $('#bulk-clear').disabled=selectedCatalogIds.size===0;
}

function readCatalog(){
  try{
    const items=JSON.parse(readStoredData(CATALOG_KEY)||'[]');
    if(!Array.isArray(items))return [];
    const seen=new Set();
    return items.filter(x=>{
      if(!x||typeof x.name!=='string'||!x.name.trim()||x.name.length>80)return false;
      const info=codeInfo(x.code);
      if(!info.ok||seen.has(info.code))return false;
      seen.add(info.code);return true;
    }).slice(0,500).map(x=>({
      id:String(x.id||makeId()),code:codeInfo(x.code).code,name:x.name,nameBreak:normalizeNameBreak(x.name,x.nameBreak),folderId:resolveFolderId(x.folderId),
      createdAt:typeof x.createdAt==='string'&&!Number.isNaN(Date.parse(x.createdAt))?x.createdAt:null,
      updatedAt:typeof x.updatedAt==='string'&&!Number.isNaN(Date.parse(x.updatedAt))?x.updatedAt:null
    }));
  }catch{return [];}
}
function makeId(){return globalThis.crypto?.randomUUID?.()||String(Date.now())+'-'+Math.random().toString(36).slice(2);}
function saveCatalog(){
  try{persistState();return true;}
  catch{toast('保存に失敗しました。端末の空き容量やSafariの設定を確認してください。','error');return false;}
}
function migrateOldProducts(){
  try{if(readStoredData(CATALOG_KEY)!==null)return;}catch{return;}
  const unique=new Map();
  for(const rec of records)if(!unique.has(rec.code))unique.set(rec.code,{
    id:makeId(),code:rec.code,name:rec.name,nameBreak:rec.nameBreak??null,folderId:null,createdAt:null,updatedAt:null
  });
  catalog=[...unique.values()];
  saveCatalog();
}
function registrationLabel(value){
  if(!value)return '登録日：不明（以前の登録）';
  try{
    const date=new Date(value);
    if(Number.isNaN(date.getTime()))return '登録日：不明';
    const formatted=new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
    return '登録日：'+formatted;
  }catch{return '登録日：不明';}
}
function upsertCatalog(data,originalCode=null,persist=true){
  let original=originalCode?catalog.find(x=>x.code===originalCode):catalog.find(x=>x.code===data.code);
  const duplicate=catalog.find(x=>x.code===data.code);
  if(original&&duplicate&&original.id!==duplicate.id)throw Error('このバーコード番号は別の商品として登録済みです。');
  if(!original)original=duplicate;
  if(!original&&catalog.length>=500)throw Error('保存できる商品は500件までです。');
  if(data.folderId!==undefined&&data.folderId!==null&&!folders.some(f=>f.id===data.folderId))throw Error('指定したフォルダが見つかりません。');
  const now=new Date().toISOString();
  const entry=original
    ?{...original,code:data.code,name:data.name,nameBreak:normalizeNameBreak(data.name,data.nameBreak),folderId:data.folderId===undefined?(original.folderId??null):data.folderId,updatedAt:now}
    :{id:makeId(),code:data.code,name:data.name,nameBreak:normalizeNameBreak(data.name,data.nameBreak),folderId:data.folderId??null,createdAt:now,updatedAt:now};
  const previous=catalog;
  catalog=original
    ?catalog.map(x=>x.id===original.id?entry:x)
    :[entry,...catalog];
  if(persist&&!saveCatalog()){catalog=previous;throw Error('商品データを保存できませんでした。');}
  return entry;
}
function showPage(page){
  closeFolderMenu();
  const saved=page==='saved';
  $('#create-page').hidden=saved;
  $('#catalog-page').hidden=!saved;
  if(!saved)fitLabelName($('#preview .name-cell'));
  $('#nav-create').setAttribute('aria-current',saved?'false':'page');
  $('#nav-saved').setAttribute('aria-current',saved?'page':'false');
  if(saved)stopCamera();
  window.scrollTo({top:0,behavior:'auto'});
}
function openCreatePage(){
  showPage('create');
  if(window.location.hash!=='#create')window.location.hash='#create';
}


/* Manual order is stored as the existing catalog array: no new storage key. */
function canSortProducts(){
 return activeFolder!=='all'&&!catalogSelectionMode
   &&!$('#catalog-search').value.trim();
}
function reorderProduct(source,target,folderId,displayed){
 if(!Array.isArray(displayed)||folderId==='all')return false;
 const id=folderId==='none'?null:folderId;
 const same=p=>(p.folderId??null)===id;
 const members=catalog.filter(same);
 const valid=new Set(members.map(p=>p.id));
 if(displayed.length!==members.length||new Set(displayed).size!==members.length||displayed.some(x=>!valid.has(x)))return false;
 const from=displayed.indexOf(source),to=displayed.indexOf(target);
 if(from<0||to<0||from===to)return false;
 const order=[...displayed],previous=catalog;
 const [moved]=order.splice(from,1);order.splice(to,0,moved);
 const byId=new Map(members.map(p=>[p.id,p]));
 let cursor=0;
 catalog=catalog.map(p=>same(p)?byId.get(order[cursor++]):p);
 if(!saveCatalog()){catalog=previous;throw Error('商品の並べ替えを保存できませんでした。');}
 $('#catalog-sort').value='manual';
 renderCatalog();
 return true;
}
function clearProductGesture(){
 const g=productGesture;if(!g)return;
 clearTimeout(g.timer);g.source.classList.remove('product-is-dragging');
 const list=$('#catalog-items');list.classList.remove('product-sort-active');
 for(const el of list.querySelectorAll('.product-drop-target'))el.classList.remove('product-drop-target');
 g.ghost?.remove();productGesture=null;
}
function beginProductDrag(){
 const g=productGesture;
 if(!g||!canSortProducts()||activeFolder!==g.folderId)return;
 g.dragging=true;productSuppressClickUntil=Date.now()+850;
 g.source.classList.add('product-is-dragging');$('#catalog-items').classList.add('product-sort-active');
 const rect=g.source.getBoundingClientRect(),ghost=g.source.cloneNode(true);
 ghost.classList.add('product-drag-ghost');ghost.setAttribute('aria-hidden','true');
 ghost.style.left=rect.left+'px';ghost.style.top=rect.top+'px';
 ghost.style.width=rect.width+'px';ghost.style.height=rect.height+'px';
 ghost.style.transform='translate(0px,0px)';
 document.body.append(ghost);g.ghost=ghost;
}
function startProductPress(e,kind){
 if(productGesture||!canSortProducts()||visibleCatalogIds.length<2)return;
 if(kind==='mouse'&&(e.button!==0||Date.now()<productIgnoreMouseUntil))return;
 if(e.target.closest('button,input,select,textarea,summary,a,label'))return;
 const summary=e.target.closest('.catalog-summary');
 if(!summary||!$('#catalog-items').contains(summary))return;
 const row=summary.closest('.catalog-item');
 if(!row||!visibleCatalogIds.includes(row.dataset.productId))return;
 const touch=kind==='touch'?(e.touches.length===1?e.touches[0]:null):null;
 if(kind==='touch'&&!touch)return;
 const x=kind==='touch'?touch.clientX:e.clientX,y=kind==='touch'?touch.clientY:e.clientY;
 if(kind==='touch')productIgnoreMouseUntil=Date.now()+1000;
 productGesture={
   id:row.dataset.productId,folderId:activeFolder,displayed:[...visibleCatalogIds],
   kind,identifier:touch?.identifier,startX:x,startY:y,source:row,dragging:false,
   target:null,ghost:null,timer:null
 };
 productGesture.timer=setTimeout(beginProductDrag,480);
}
function moveProductPress(e,kind){
 const g=productGesture;if(!g||g.kind!==kind)return;
 const touch=kind==='touch'?[...e.touches].find(t=>t.identifier===g.identifier):null;
 if(kind==='touch'&&!touch){clearProductGesture();return;}
 const x=kind==='touch'?touch.clientX:e.clientX,y=kind==='touch'?touch.clientY:e.clientY;
 if(!g.dragging){if(Math.hypot(x-g.startX,y-g.startY)>12)clearProductGesture();return;}
 if(e.cancelable)e.preventDefault();
 g.ghost.style.transform='translate('+(x-g.startX)+'px,'+(y-g.startY)+'px)';
 if(typeof window.innerHeight==='number'&&typeof window.scrollBy==='function'){
   if(y>window.innerHeight-48)window.scrollBy(0,15);
   else if(y<48)window.scrollBy(0,-15);
 }
 const row=document.elementFromPoint(x,y)?.closest('.catalog-item');
 const id=row?.dataset.productId;
 const next=id!==g.id&&g.displayed.includes(id)?id:null;
 if(g.target===next)return;
 for(const el of $('#catalog-items').querySelectorAll('.product-drop-target'))el.classList.remove('product-drop-target');
 if(next)row.classList.add('product-drop-target');
 g.target=next;
}
function endProductPress(e,kind,commit=true){
 const g=productGesture;if(!g||g.kind!==kind)return;
 if(kind==='touch'&&e.changedTouches&&![...e.changedTouches].some(t=>t.identifier===g.identifier))return;
 const dragging=g.dragging,{id,target,folderId,displayed}=g;
 if(dragging){if(e.cancelable)e.preventDefault();productSuppressClickUntil=Date.now()+650;}
 clearProductGesture();
 if(!dragging||!commit||!target||!canSortProducts()||activeFolder!==folderId)return;
 try{if(reorderProduct(id,target,folderId,displayed))toast('商品の順番を保存しました。');}
 catch(error){toast(error.message,'error');}
}
function installProductReordering(){
 const list=$('#catalog-items');
 list.addEventListener('touchstart',e=>startProductPress(e,'touch'),{passive:true});
 document.addEventListener('touchmove',e=>moveProductPress(e,'touch'),{passive:false});
 document.addEventListener('touchend',e=>endProductPress(e,'touch'),{passive:false});
 document.addEventListener('touchcancel',e=>endProductPress(e,'touch',false));
 list.addEventListener('mousedown',e=>startProductPress(e,'mouse'));
 document.addEventListener('mousemove',e=>moveProductPress(e,'mouse'));
 document.addEventListener('mouseup',e=>endProductPress(e,'mouse'));
 window.addEventListener('blur',clearProductGesture);
 window.addEventListener('scroll',()=>{if(productGesture&&!productGesture.dragging)clearProductGesture();},{passive:true});
 list.addEventListener('click',e=>{
   // Suppress the synthetic click on a dragged row, never the action buttons.
   if(Date.now()<productSuppressClickUntil&&e.target.closest('.catalog-summary')){
     e.preventDefault();e.stopPropagation();
   }
 },true);
 list.addEventListener('contextmenu',e=>{
   if(canSortProducts()&&e.target.closest('.catalog-summary'))e.preventDefault();
 });
}

// Only one saved-product action menu can be open at a time.
// Closing an unrelated menu does not change its product or action state.
function closeOtherProductMenus(activeMenu){
  for(const other of $('#catalog-items').querySelectorAll('.product-menu[open]')){
    if(other!==activeMenu)other.open=false;
  }
}
function shouldOpenProductMenuAbove(rect,menuHeight,viewportHeight){
  const spaceBelow=Math.max(0,viewportHeight-rect.bottom);
  return spaceBelow<menuHeight+8&&rect.top>spaceBelow;
}
function renderCatalog(){
  $('#catalog-count').textContent=catalog.length+'件';
  const term=$('#catalog-search').value.trim().toLocaleLowerCase();
  const filtered=catalog.filter(x=>
    (activeFolder==='all'||(activeFolder==='none'&&!resolveFolderId(x.folderId))||x.folderId===activeFolder)
    &&(x.name.toLocaleLowerCase().includes(term)||x.code.includes(term))
  );
  const order=$('#catalog-sort').value;
  const compare=(a,b)=>a.localeCompare(b,'ja',{numeric:true});
  filtered.sort((a,b)=>{
    if(order==='manual')return 0;
    if(order==='name')return compare(a.name,b.name)||compare(a.code,b.code);
    if(order==='code')return compare(a.code,b.code);
    const da=a.createdAt?new Date(a.createdAt).getTime():0;
    const db=b.createdAt?new Date(b.createdAt).getTime():0;
    return (order==='oldest'?da-db:db-da)||compare(a.name,b.name);
  });
  visibleCatalogIds=filtered.map(x=>x.id);
  const currentName=activeFolder==='all'?'すべての商品':activeFolder==='none'?'未分類':folderName(activeFolder);
  $('#catalog-current-name').textContent=currentName;
  const editableFolder=catalogFolderOpened?folders.find(folder=>folder.id===activeFolder):null;
  closeFolderMenu();
  $('#folder-page-actions').hidden=!editableFolder;
  if(editableFolder){
    $('#folder-page-menu-toggle').setAttribute('aria-label',editableFolder.name+'の操作');
    $('#folder-page-edit').setAttribute('aria-label',editableFolder.name+'の名前を編集');
    $('#folder-page-delete').setAttribute('aria-label',editableFolder.name+'を削除');
  }
  $('#catalog-browser').dataset.opened=String(catalogFolderOpened);
  $('#catalog-backup-section').hidden=catalogFolderOpened;
  $('#catalog-content').dataset.selecting=String(catalogSelectionMode);
  const selectButton=$('#catalog-select-mode');
  selectButton.textContent=catalogSelectionMode?'完了':'選択';
  selectButton.setAttribute('aria-pressed',String(catalogSelectionMode));
  $('#catalog-bulk').hidden=!catalogSelectionMode;
  renderFolders();
  updateBulkSelection();
  const target=$('#catalog-items');
  catalogBarcodeObserver?.disconnect();target.replaceChildren();
  if(!filtered.length){
    const empty=document.createElement('div');empty.className='empty-list';
    empty.textContent=catalog.length?'条件に合う商品がありません。':'商品を登録すると、ここに保存されます。';
    target.append(empty);return;
  }
  for(const product of filtered){
    const row=document.createElement('div');row.className='catalog-item';
    row.dataset.productId=product.id;
    const line=document.createElement('div');line.className='catalog-row';
    const check=document.createElement('input');check.type='checkbox';check.className='catalog-select';
    check.checked=selectedCatalogIds.has(product.id);
    check.setAttribute('aria-label',product.name+'を選択');
    check.addEventListener('change',()=>{
      if(check.checked)selectedCatalogIds.add(product.id);
      else selectedCatalogIds.delete(product.id);
      updateBulkSelection();
    });
    line.append(check);
    const data=document.createElement('div');data.className='catalog-details';
    const name=document.createElement('div');name.className='catalog-name';name.textContent=product.name;
    const code=document.createElement('div');code.className='catalog-code';code.textContent=product.code;
    data.append(name,code);
    const meta=document.createElement('div');meta.className='catalog-meta';
    const date=document.createElement('div');date.className='catalog-date';date.textContent=registrationLabel(product.createdAt);
    meta.append(date);
    const summary=document.createElement('div');summary.className='catalog-summary';
    summary.tabIndex=0;
    summary.addEventListener('keydown',event=>{
      if(!event.altKey||!['ArrowUp','ArrowDown'].includes(event.key)||!canSortProducts())return;
      event.preventDefault();
      const index=visibleCatalogIds.indexOf(product.id),target=visibleCatalogIds[index+(event.key==='ArrowUp'?-1:1)];
      if(!target)return;
      try{
        if(reorderProduct(product.id,target,activeFolder,[...visibleCatalogIds])){
          const same=[...$('#catalog-items').querySelectorAll('.catalog-item')].find(el=>el.dataset.productId===product.id);
          same?.querySelector('.catalog-summary')?.focus();
          toast('商品の順番を保存しました。');
        }
      }catch(error){toast(error.message,'error');}
    });
    summary.append(data,meta);line.append(summary);
    const menu=document.createElement('details');menu.className='product-menu';
    const trigger=document.createElement('summary');trigger.textContent='…';
    trigger.setAttribute('aria-label',product.name+'の操作メニュー');
    const actions=document.createElement('div');actions.className='product-menu-options';
    const add=document.createElement('button');add.type='button';add.textContent='印刷リストに追加';
    add.addEventListener('click',()=>{
      menu.open=false;
      const before=cloneData(records),existing=records.find(x=>x.code===product.code);
      if(existing){existing.name=product.name;existing.nameBreak=product.nameBreak;existing.selected=true;}
      else{
        if(records.length>=200){toast('印刷リストは200件までです。不要な商品をリストから削除してください。','error');return;}
        records.unshift({id:makeId(),code:product.code,name:product.name,nameBreak:product.nameBreak,qty:1,selected:true});
      }
      if(!saveRecords())records=before;
      else toast(existing?'印刷リストの既存商品を選択しました。':'印刷リストに追加しました。');
      renderRecords();
    });
    const edit=document.createElement('button');edit.type='button';edit.textContent='商品を編集';
    edit.addEventListener('click',()=>{
      editingId=null;editingCatalogId=product.id;
      $('#code').value=product.code;$('#name').value=product.name;$('#qty').value='1';setNameBreakState(product.nameBreak);
      $('#folder-select').value=resolveFolderId(product.folderId)||'';
      $('#save').textContent='商品情報を更新';
      updatePreview();openCreatePage();$('#name').focus();
    });
    const moveLabel=document.createElement('label');moveLabel.className='menu-move-label';
    moveLabel.textContent='フォルダに移動';
    const moveSelect=document.createElement('select');moveSelect.className='catalog-folder-move';
    const unset=document.createElement('option');unset.value='';unset.textContent='未分類';moveSelect.append(unset);
    for(const folder of folders){
      const opt=document.createElement('option');opt.value=folder.id;opt.textContent=folder.name;moveSelect.append(opt);
    }
    moveSelect.value=resolveFolderId(product.folderId)||'';
    moveSelect.addEventListener('change',()=>{
      menu.open=false;
      try{
        if(changeProductFolders([product.id],moveSelect.value||null))toast('所属フォルダを変更しました。');
      }catch(err){toast(err.message,'error');renderCatalog();}
    });
    moveLabel.append(moveSelect);
    const del=document.createElement('button');del.type='button';del.className='destructive';del.textContent='保存商品を削除';
    del.addEventListener('click',()=>{
      menu.open=false;
      if(!window.confirm('「'+product.name+'」を保存商品から削除しますか？\\n印刷リストの内容は残ります。'))return;
      const old=catalog;catalog=catalog.filter(x=>x.id!==product.id);
      if(!saveCatalog()){catalog=old;return;}
      if(editingCatalogId===product.id)clearForm();
      selectedCatalogIds.delete(product.id);renderCatalog();toast('保存商品から削除しました。');
    });
    actions.append(add,edit,moveLabel,del);
    menu.append(trigger,actions);line.append(menu);
    // Run before the summary's default toggle, so rapid successive taps always
    // keep the most recently selected product menu open (also on iOS Safari).
    trigger.addEventListener('click',()=>{
      if(!menu.open)closeOtherProductMenus(menu);
    });
    menu.addEventListener('toggle',()=>{
      row.classList.toggle('catalog-menu-open',menu.open);
      if(!menu.open){menu.classList.remove('open-up');return;}
      // Also handle keyboard / script-initiated opens.
      closeOtherProductMenus(menu);
      menu.classList.toggle('open-up',shouldOpenProductMenuAbove(
        trigger.getBoundingClientRect(),actions.offsetHeight,window.innerHeight));
    });
    // Display the same locally generated, valid barcode used on printed labels.
    // Keep it below the name, number, date and actions so narrow screens do not
    // compress the bars or displace the existing product controls.
    const barcode=document.createElement('div');
    barcode.className='catalog-barcode';
    barcode.dataset.code=product.code;
    row.append(line,barcode);target.append(row);
    if(catalogBarcodeObserver)catalogBarcodeObserver.observe(barcode);
    else barcode.append(createBarcodeSvg(product.code));
  }
}

const BACKUP_FORMAT = 'barcode-label-app-backup';
const BACKUP_VERSION = 1;
const ENCRYPTED_BACKUP_FORMAT = 'barcode-label-app-backup-encrypted';
const BACKUP_KDF_ITERATIONS = 250000;
const BACKUP_FILE_LIMIT = 2 * 1024 * 1024;

function backupStatus(message,isError=false){
  const target=$('#backup-status');
  target.textContent=message;
  target.hidden=!message;
  target.className=isError?'backup-status error':'backup-status';
}
async function makeBackupDocument(){
  return {
    format:BACKUP_FORMAT,
    version:BACKUP_VERSION,
    exportedAt:new Date().toISOString(),
    folders:folders.map(f=>({id:f.id,name:f.name})),
    savedProducts:catalog.map(x=>({
      id:x.id,code:x.code,name:x.name,nameBreak:x.nameBreak??null,folderId:resolveFolderId(x.folderId),
      createdAt:x.createdAt,updatedAt:x.updatedAt
    })),
    printList:records.map(x=>({
      id:x.id,code:x.code,name:x.name,nameBreak:x.nameBreak??null,qty:x.qty,selected:x.selected
    }))
  };
}
function toBase64(bytes){
  let text='';
  for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(text);
}
function fromBase64(text,limit){
  if(typeof text!=='string'||text.length>Math.ceil(limit*4/3)+4||!/^[A-Za-z0-9+/]*={0,2}$/.test(text))
    throw Error('暗号化バックアップの形式が不正です。');
  try{
    const decoded=atob(text);
    if(decoded.length>limit)throw Error('ファイルが大きすぎます。');
    return Uint8Array.from(decoded,char=>char.charCodeAt(0));
  }catch{throw Error('暗号化バックアップを読み取れません。');}
}
async function backupKey(password,salt,usage){
  if(!globalThis.crypto?.subtle)throw Error('暗号化にはHTTPSでの利用が必要です。');
  const passwordKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:BACKUP_KDF_ITERATIONS,hash:'SHA-256'},passwordKey,
    {name:'AES-GCM',length:256},false,[usage]);
}
async function encryptBackup(data,password){
  if(password.length<8||password.length>128)throw Error('暗号化パスワードは8〜128文字で入力してください。');
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await backupKey(password,salt,'encrypt');
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(data)));
  return {format:ENCRYPTED_BACKUP_FORMAT,version:1,kdf:'PBKDF2-SHA256',
    iterations:BACKUP_KDF_ITERATIONS,salt:toBase64(salt),iv:toBase64(iv),
    ciphertext:toBase64(new Uint8Array(encrypted))};
}
async function decryptBackup(envelope,password){
  if(!envelope||envelope.format!==ENCRYPTED_BACKUP_FORMAT||envelope.version!==1
    ||envelope.kdf!=='PBKDF2-SHA256'||envelope.iterations!==BACKUP_KDF_ITERATIONS)
    throw Error('対応していない暗号化バックアップ形式です。');
  const salt=fromBase64(envelope.salt,16),iv=fromBase64(envelope.iv,12);
  if(salt.length!==16||iv.length!==12)throw Error('暗号化バックアップの形式が不正です。');
  const payload=fromBase64(envelope.ciphertext,BACKUP_FILE_LIMIT);
  const key=await backupKey(password,salt,'decrypt');
  try{
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,payload);
    return JSON.parse(new TextDecoder().decode(plain));
  }catch{throw Error('パスワードが違うか、バックアップが破損しています。');}
}
async function exportBackup(){
  if(!catalog.length&&!records.length&&!folders.length){
    backupStatus('保存されている商品・印刷リストがありません。',true);return;
  }
  let documentData;
  const password=$('#backup-password').value;
  try{
    documentData=await makeBackupDocument();
    if(password)documentData=await encryptBackup(documentData,password);
  }catch(error){backupStatus(error?.message||'バックアップを作成できませんでした。',true);return;}
  $('#backup-password').value='';
  const blob=new Blob([JSON.stringify(documentData,null,2)],{type:'application/json'});
  const dateParts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(part=>[part.type,part.value]));
  const localDay=[dateParts.year,dateParts.month,dateParts.day].join('-');
  const filename='barcode-label-backup-'+localDay+'.json';
  try{
    // Safari on iPhone/iPad can save the shared file directly to Files.
    if(typeof File!=='undefined' && navigator.canShare && navigator.share){
      const file=new File([blob],filename,{type:'application/json'});
      if(navigator.canShare({files:[file]})){
        try{
          await navigator.share({files:[file],title:'バーコードラベル バックアップ'});
          backupStatus('共有操作を終了しました。「ファイルに保存」などで保存先をご確認ください。');
          return;
        }catch(error){
          if(error?.name==='AbortError'){backupStatus('バックアップの保存をキャンセルしました。');return;}
          // If sharing fails, fall back to the ordinary file download.
        }
      }
    }
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');
    link.href=url;link.download=filename;
    document.body.append(link);
    link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
    backupStatus('JSONファイルの保存を開始しました。ダウンロード先をご確認ください。');
  }catch(error){
    backupStatus('バックアップを保存できませんでした。Safariでサイトを開いて再度お試しください。',true);
  }
}
function validateBackupDocument(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.format!==BACKUP_FORMAT||raw.version!==BACKUP_VERSION){
    throw Error('このアプリの対応バックアップファイルではありません。');
  }
  if(!Array.isArray(raw.savedProducts)||!Array.isArray(raw.printList)){
    throw Error('ファイルに商品情報または印刷リストがありません。');
  }
  if(raw.savedProducts.length>500||raw.printList.length>200||(raw.folders!==undefined&&(!Array.isArray(raw.folders)||raw.folders.length>MAX_FOLDERS))){
    throw Error('ファイル内の商品件数が多すぎます。');
  }
  const validName=name=>typeof name==='string'&&name.trim().length>0&&name.length<=80;
  const validDate=date=>date===null||(typeof date==='string'&&date.length<=64&&!Number.isNaN(Date.parse(date)));
  const seenFolderIds=new Set(),seenFolderNames=new Set();
  const incomingFolders=(raw.folders??[]).map((item,index)=>{
    if(!item||!validFolderId(item.id))throw Error('フォルダ'+(index+1)+'件目の形式が正しくありません。');
    const name=validateFolderName(item.name);
    const nameKey=name.toLocaleLowerCase('ja');
    if(seenFolderIds.has(item.id)||seenFolderNames.has(nameKey))throw Error('バックアップのフォルダ情報が重複しています。');
    seenFolderIds.add(item.id);seenFolderNames.add(nameKey);
    return {id:item.id,name};
  });
  const seenCodes=new Set();
  const products=raw.savedProducts.map((item,index)=>{
    if(!item||typeof item!=='object'||Array.isArray(item)||typeof item.code!=='string'||!codeInfo(item.code).ok
       ||!validName(item.name)||!validDate(item.createdAt)||!validDate(item.updatedAt)){
      throw Error('保存商品'+(index+1)+'件目の形式が正しくありません。');
    }
    const canonical=codeInfo(item.code).code;
    if(seenCodes.has(canonical))throw Error('バックアップに同じバーコード番号の商品が重複しています。');
    seenCodes.add(canonical);
    const folderId=item.folderId??null;
    if(folderId!==null&&(!validFolderId(folderId)||!seenFolderIds.has(folderId)))throw Error('バックアップの商品が存在しないフォルダを参照しています。');
    return {code:canonical,name:item.name,nameBreak:normalizeNameBreak(item.name,item.nameBreak),folderId,createdAt:item.createdAt,updatedAt:item.updatedAt};
  });
  const printItems=raw.printList.map((item,index)=>{
    if(!item||typeof item!=='object'||Array.isArray(item)||typeof item.code!=='string'||!codeInfo(item.code).ok
       ||!validName(item.name)||!Number.isInteger(item.qty)||item.qty<1||item.qty>99||typeof item.selected!=='boolean'){
      throw Error('印刷リスト'+(index+1)+'件目の形式が正しくありません。');
    }
    return {code:codeInfo(item.code).code,name:item.name,nameBreak:normalizeNameBreak(item.name,item.nameBreak),qty:item.qty,selected:item.selected};
  });
  return {folders:incomingFolders,products,printItems};
}
function mergeBackup(backup){
  const nextFolders=[...folders],folderMap=new Map();
  const normalizedName=value=>value.toLocaleLowerCase('ja');
  for(const imported of backup.folders??[]){
    const same=nextFolders.find(f=>normalizedName(f.name)===normalizedName(imported.name));
    if(same){folderMap.set(imported.id,same.id);continue;}
    if(nextFolders.length>=MAX_FOLDERS)throw Error('復元するとフォルダが50個を超えます。');
    const id=nextFolders.some(f=>f.id===imported.id)?makeId():imported.id;
    nextFolders.push({id,name:imported.name});
    folderMap.set(imported.id,id);
  }
  const catalogCodes=new Set(catalog.map(x=>x.code));
  const addProducts=[];
  for(const item of backup.products){
    if(catalogCodes.has(item.code))continue;
    catalogCodes.add(item.code);
    addProducts.push({id:makeId(),...item,folderId:item.folderId?folderMap.get(item.folderId)||null:null});
  }
  const nextRecords=cloneData(records);
  const printIdentity=item=>JSON.stringify([item.code,item.name,item.qty]);
  const existingPrint=new Map(nextRecords.map(x=>[printIdentity(x),x]));
  let updatedPrint=0;
  const addPrint=[];
  for(const item of backup.printItems){
    const identity=printIdentity(item),existing=existingPrint.get(identity);
    if(existing){
      if(existing.selected!==item.selected||existing.nameBreak!==item.nameBreak){
        existing.selected=item.selected;existing.nameBreak=item.nameBreak;updatedPrint++;
      }
      continue;
    }
    const entry={id:makeId(),...item};
    existingPrint.set(identity,entry);
    addPrint.push(entry);
  }
  if(catalog.length+addProducts.length>500||records.length+addPrint.length>200){
    throw Error('保存件数の上限を超えるため復元できません。不要な商品を整理してからお試しください。');
  }
  const createdFolders=nextFolders.length-folders.length;
  if(!addProducts.length&&!addPrint.length&&!createdFolders&&!updatedPrint)return {saved:0,print:0,updatedPrint:0,folders:0,skipped:backup.products.length};
  const nextCatalog=[...catalog,...addProducts];
  nextRecords.push(...addPrint);
  try{persistState(nextCatalog,nextRecords,nextFolders);}
  catch{throw Error('端末への保存に失敗しました。空き容量をご確認ください。');}
  folders=nextFolders;
  catalog=nextCatalog;
  records=nextRecords;
  renderCatalog();renderRecords();
  return {saved:addProducts.length,print:addPrint.length,updatedPrint,folders:createdFolders,skipped:backup.products.length-addProducts.length};
}
async function restoreBackup(file){
  if(!file)return;
  try{
    if(!file.name?.toLowerCase().endsWith('.json'))throw Error('JSONファイル（.json）を選択してください。');
    if(file.size>BACKUP_FILE_LIMIT)throw Error('ファイルが大きすぎます（上限2MB）。');
    let raw=JSON.parse((await file.text()).replace(/^\uFEFF/,''));
    if(raw?.format===ENCRYPTED_BACKUP_FORMAT){
      const password=$('#backup-password').value||window.prompt('バックアップの暗号化パスワードを入力してください。');
      if(password===null){backupStatus('復元をキャンセルしました。');return;}
      if(!password)throw Error('暗号化パスワードを入力してください。');
      raw=await decryptBackup(raw,password);
    }
    $('#backup-password').value='';
    const parsed=validateBackupDocument(raw);
    if(!parsed.products.length&&!parsed.printItems.length&&!parsed.folders.length){
      backupStatus('バックアップには商品情報が入っていません。',true);return;
    }
    const proposed=parsed.products.filter(x=>!catalog.some(current=>current.code===x.code)).length;
    const answer=window.confirm(
      `保存商品：${parsed.products.length}件（うち未登録 ${proposed}件）\nフォルダ：${parsed.folders.length}個\n印刷リスト：${parsed.printItems.length}件\n\n既存データを残して追加します。\n同じバーコード番号の商品は上書きしません。印刷リストで番号・商品名・枚数が同じ項目は、選択状態と改行位置を復元します。\n\n復元しますか？`
    );
    if(!answer){backupStatus('復元をキャンセルしました。');return;}
    const result=mergeBackup(parsed);
    backupStatus(`復元完了：新規フォルダ${result.folders}個、商品${result.saved}件、印刷リスト${result.print}件を追加し、印刷リスト${result.updatedPrint}件の選択・改行を復元しました。重複商品${result.skipped}件は変更していません。`);
    clearForm();
  }catch(error){
    backupStatus(error?.message||'バックアップを読み込めませんでした。',true);
  }finally{
    $('#backup-file').value='';
  }
}

function saveRecords(){
  try{persistState();return true;}
  catch{toast('印刷リストの保存に失敗しました。端末の空き容量やSafariの設定を確認してください。','error');return false;}
}
function cloneData(items){return items.map(item=>({...item}));}
function toast(message,type='ok'){
  const target=$('#toast');target.textContent=message;target.className='toast show'+(type==='error'?' error':'');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>target.classList.remove('show'),5600);
}
function formData(){
  const info=codeInfo($('#code').value);
  if(!info.ok)throw Error(info.error);
  const rawName=$('#name').value,name=rawName.trim();
  if(!name)throw Error('商品名を入力してください。');
  const lead=rawName.length-rawName.trimStart().length;
  const nameBreak=normalizeNameBreak(name,manualNameBreak===null?null:manualNameBreak-lead);
  if(tooManySpaceBreaks(name,nameBreak))throw Error('改行に使う全角スペースは1か所までにしてください。');
  const qty=Number($('#qty').value);
  if(!Number.isInteger(qty)||qty<1||qty>99)throw Error('印刷枚数は1～99で指定してください。');
  return {code:info.code,name,nameBreak,qty,folderId:$('#folder-select').value||null};
}
function updatePreview(){
  const info=codeInfo($('#code').value), target=$('#preview'), status=$('#code-status');
  target.replaceChildren();
  if(info.ok){
    status.textContent=`${info.type} ・ チェックデジット確認済み`;
    status.className='hint valid';
    const raw=$('#name').value,clean=raw.trim(),leading=raw.length-raw.trimStart().length;
    const position=normalizeNameBreak(clean,manualNameBreak===null?null:manualNameBreak-leading);
    target.append(createLabel({code:info.code,name:clean,nameBreak:position},labelHeightMm<=10));
    fitLabelName(target.querySelector('.name-cell'));
    $('#print-one').disabled=!$('#name').value.trim();
  }else{
    status.textContent=info.error==='番号を入力してください。'?'JAN-13（13桁）、JAN-8（8桁）、UPC-A（12桁）に対応':info.error;
    status.className='hint'+(info.error==='番号を入力してください。'?'':' invalid');
    const empty=document.createElement('div');empty.className='preview-empty';empty.textContent='正しい番号を入力すると、バーコードが表示されます。';
    target.append(empty);$('#print-one').disabled=true;
  }
}
function clearForm(){
  editingId=null;editingCatalogId=null;
  HTMLFormElement.prototype.reset.call($('#editor'));$('#qty').value='1';$('#folder-select').value='';
  setNameBreakState(null);
  $('#save').textContent='保存して印刷リストに追加';updatePreview();
}
function renderRecords(){
  $('#item-count').textContent=records.length+'件';
  const target=$('#items');target.replaceChildren();
  if(!records.length){const empty=document.createElement('div');empty.className='empty-list';empty.textContent='印刷リストは空です。保存した商品からも追加できます。';target.append(empty);}
  for(const rec of records){
    const wrapper=document.createElement('div');wrapper.className='item';
    const check=document.createElement('input');check.type='checkbox';check.className='item-check';check.checked=rec.selected;
    check.setAttribute('aria-label',`${rec.name}を印刷する`);check.addEventListener('change',()=>{
      const before=rec.selected;rec.selected=check.checked;
      if(!saveRecords()){rec.selected=before;check.checked=before;}
    });
    const detail=document.createElement('div');detail.className='item-details';
    const nm=document.createElement('div');nm.className='item-name';nm.textContent=rec.name;
    const sub=document.createElement('div');sub.className='item-sub';sub.textContent=`${rec.code} / ${rec.qty}枚`;
    detail.append(nm,sub);
    const actions=document.createElement('div');actions.className='item-actions';
    const edit=document.createElement('button');edit.type='button';edit.textContent='編集';
    edit.addEventListener('click',()=>{editingCatalogId=null;editingId=rec.id;$('#code').value=rec.code;$('#name').value=rec.name;$('#qty').value=rec.qty;$('#folder-select').value=resolveFolderId(catalog.find(x=>x.code===rec.code)?.folderId)||'';$('#save').textContent='変更を保存';setNameBreakState(rec.nameBreak??catalog.find(x=>x.code===rec.code)?.nameBreak??null);updatePreview();window.scrollTo({top:0,behavior:'smooth'});});
    const del=document.createElement('button');del.type='button';del.textContent='削除';
    del.addEventListener('click',()=>{
      const before=records;records=records.filter(x=>x.id!==rec.id);
      if(!saveRecords())records=before;
      else toast('リストから削除しました。');
      renderRecords();
    });
    actions.append(edit,del);wrapper.append(check,detail,actions);target.append(wrapper);
  }
}
function isIOSHomeScreenApp(){
  const ios=/iPhone|iPad|iPod/.test(navigator.userAgent)
    ||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  const installed=window.matchMedia?.('(display-mode: standalone)')?.matches||navigator.standalone===true;
  return ios&&installed;
}
async function exportPrintTransfer(){
  const status=$('#print-transfer-status');
  if(!stagedPrintItems.length){status.textContent='印刷対象がありません。';return;}
  const exported={
    format:BACKUP_FORMAT,version:BACKUP_VERSION,exportedAt:new Date().toISOString(),
    folders:[],savedProducts:[],
    printList:stagedPrintItems.map(item=>({
      code:item.code,name:item.name,nameBreak:item.nameBreak??null,
      qty:item.qty,selected:true
    }))
  };
  const blob=new Blob([JSON.stringify(exported,null,2)],{type:'application/json'});
  const filename='barcode-label-print-transfer.json';
  try{
    if(typeof File!=='undefined'&&navigator.canShare&&navigator.share){
      const file=new File([blob],filename,{type:'application/json'});
      if(navigator.canShare({files:[file]})){
        try{
          await navigator.share({files:[file],title:'バーコードラベル 印刷データ'});
          status.textContent='共有操作が終了しました。保存先の「ファイル」を確認してください。';
          return;
        }catch(error){
          if(error?.name==='AbortError'){status.textContent='保存をキャンセルしました。';return;}
        }
      }
    }
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');
    link.href=url;link.download=filename;
    document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
    status.textContent='ファイルの保存を開始しました。ダウンロード先を確認してください。';
  }catch{
    status.textContent='保存できませんでした。Safariで直接開いてから印刷をお試しください。';
  }
}
function printFeedback(message){
  const box=$('#print-feedback');
  box.textContent=message;
  box.hidden=!message;
  if(message)box.scrollIntoView({behavior:'smooth',block:'nearest'});
}
function validLabelLayout(value){return value==='horizontal'||value==='vertical';}
function readLabelLayout(){
  try{
    const value=localStorage.getItem(LABEL_LAYOUT_KEY);
    return validLabelLayout(value)?value:'horizontal';
  }catch{return 'horizontal';}
}
function setLabelLayout(value){
  if(!validLabelLayout(value))return;
  labelLayout=value;
  $('#label-layout').value=value;
  $('#preview-label-layout').value=value;
  try{localStorage.setItem(LABEL_LAYOUT_KEY,value);}
  catch{toast('配置を記憶できませんでした。今回の印刷には反映されます。','error');}
  updatePreview();
  if(!$('#print-preview-overlay').hidden&&stagedPrintItems.length)buildPrintSheets();
}
function validLabelHeight(value){
  const mm=Number(value);
  return Number.isInteger(mm)&&mm>=5&&mm<=50&&mm%5===0;
}
function readLabelHeight(){
  try{
    const raw=localStorage.getItem(LABEL_HEIGHT_KEY);
    return raw!==null&&validLabelHeight(raw)?Number(raw):20;
  }catch{return 20;}
}
function setLabelHeight(value){
  if(!validLabelHeight(value))return;
  labelHeightMm=Number(value);
  $('#label-height').value=String(labelHeightMm);
  $('#preview-label-height').value=String(labelHeightMm);
  try{localStorage.setItem(LABEL_HEIGHT_KEY,String(labelHeightMm));}
  catch{toast('ラベルの高さを記憶できませんでした。今回の印刷には反映されます。','error');}
  updateNameBreakStatus();
  updatePreview();
  if(!$('#print-preview-overlay').hidden&&stagedPrintItems.length)buildPrintSheets();
}
async function printLabels(items){
  const total=items.reduce((sum,item)=>sum+item.qty,0);
  if(!total){printFeedback('印刷する商品がありません。「リストに追加」を押して保存し、印刷する商品にチェックを入れてください。');return;}
  if(total>200){printFeedback('一度に印刷できるのは200枚までです。枚数を減らしてください。');return;}
  if(printBusy)return;
  printBusy=true;printFeedback('');
  try{
    stagedPrintItems=items.map(item=>({...item}));
    buildPrintSheets();
    $('#print-preview-overlay').hidden=false;
    document.body.classList.add('print-preview-open');
    scalePreviewPages();
    $('#close-print-preview').focus();
  }catch{
    printFeedback('印刷プレビューを作成できませんでした。');
  }finally{printBusy=false;}
}
function printPagination(paper,height,layout){
  const isB5=paper==='B5',columns=layout==='vertical'?3:2;
  // Preserve paper margins, label heights and 3mm row gaps. Allow just one
  // additional row where the physical sheet still fits it (15-25mm labels).
  const paperHeight=isB5?257:297,pagePadding=isB5?7:8,gap=3;
  const fitRows=Math.floor((paperHeight-2*pagePadding+gap)/(height+gap));
  const rows=Math.max(1,height<15?fitRows:Math.min(isB5?8:9,fitRows));
  return {columns,perPage:columns*rows};
}
function buildPrintSheets(){
  const paper=$('#paper').value;
  const isB5=paper==='B5';
  const flat=[];
  for(const item of stagedPrintItems)for(let i=0;i<item.qty;i++)flat.push(item);

  // Both views use the same page and label nodes. Preview only scales a clone.
  const target=$('#print-sheet');
  target.replaceChildren();
  target.className='print-sheet '+(isB5?'b5':'a4');
  const preview=$('#print-preview-pages');
  preview.replaceChildren();
  const {columns,perPage}=printPagination(paper,labelHeightMm,labelLayout);
  for(let offset=0;offset<flat.length;offset+=perPage){
    const page=document.createElement('div');
    page.className='paper-page'+(isB5?' b5':'');
    page.style.setProperty('--label-height',labelHeightMm+'mm');
    page.style.setProperty('--label-columns',String(columns));
    page.dataset.labelHeight=String(labelHeightMm);
    const grid=document.createElement('div');
    grid.className='paper-label-grid';
    for(const item of flat.slice(offset,offset+perPage))grid.append(createLabel(item,labelHeightMm<=10));
    page.append(grid);
    target.append(page);

    const viewport=document.createElement('div');
    viewport.className='preview-page-viewport';
    viewport.append(page.cloneNode(true));
    preview.append(viewport);
  }
  $('#preview-paper').value=paper;
  $('#preview-label-height').value=String(labelHeightMm);
  $('#preview-label-layout').value=labelLayout;
  const standalone=window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone===true;
  $('#print-ios-fallback').hidden=!isIOSHomeScreenApp();
  $('#print-transfer-status').textContent='';
  $('#print-guidance').textContent=standalone
    ? 'ホーム画面のアプリから印刷画面が開かない場合は、SafariでこのサイトのURLを直接開いてください。プリンターの用紙サイズはアプリと一致させてください。'
    : '「印刷画面を開く」の後、プリンターの用紙サイズを上で選んだサイズに合わせ、倍率を100%にしてください。';
  if(labelHeightMm<=10){
    $('#print-guidance').textContent=labelHeightMm+'mmはバーコード下の数字を省略しています。商品名が読みにくくなる、またはバーコードがスキャンできない可能性があります。必ず実寸で試し刷りし、レジで読み取れることをご確認ください。 '+$('#print-guidance').textContent;
  }else if(labelHeightMm===15){
    $('#print-guidance').textContent='15mmではバーコードが小さくなり、読み取りにくい場合があります。試し刷りしてご確認ください。 '+$('#print-guidance').textContent;
  }
  if(labelLayout==='vertical'&&labelHeightMm<=25){
    $('#print-guidance').textContent='縦並びの小さいラベルはバーコードの高さが低くなります。実際に使う発注端末で試し読みしてください。 '+$('#print-guidance').textContent;
  }
  if(flat.length>perPage){
    $('#print-guidance').textContent=`印刷枚数の合計が${flat.length}枚のため${Math.ceil(flat.length/perPage)}ページになります。1ページに収めたい場合は、各商品の「印刷枚数」を減らしてください。`+' '+$('#print-guidance').textContent;
  }
  scalePreviewPages();
}
function scalePreviewPages(){
  fitPrintNames();
  for(const viewport of document.querySelectorAll('.preview-page-viewport')){
    const page=viewport.firstElementChild;
    if(!page)continue;
    // Keep true mm dimensions. Only shrink the page visually inside the modal.
    const pageWidth=page.offsetWidth, pageHeight=page.offsetHeight;
    const available=viewport.clientWidth;
    if(!pageWidth||!pageHeight||!available)continue;
    const scale=Math.min(1,available/pageWidth);
    page.style.transform=`scale(${scale})`;
    page.style.left=`${Math.max(0,(available-pageWidth*scale)/2)}px`;
    viewport.style.height=`${Math.ceil(pageHeight*scale)}px`;
  }
}
function closePrintPreview(){
  $('#print-preview-overlay').hidden=true;
  document.body.classList.remove('print-preview-open');
  $('#print-all').focus();
}
function confirmPrint(){
  if(!stagedPrintItems.length)return;
  // Keep print inside a direct user click; delayed callbacks can be blocked by Safari.
  try{
    fitPrintNames();
    void $('#print-sheet').offsetHeight;
    window.print();
  }catch(err){
    $('#print-guidance').textContent='印刷画面を開けませんでした。Safariで開いて再度お試しください。下の方法で印刷対象のデータを移せます。';
    $('#print-ios-fallback').hidden=false;
  }
}
function handleScanValue(raw,format){
  if(!isSupportedScanFormat(format)){
    toast('JAN-13・JAN-8・UPC-Aのバーコードを読み取ってください。','error');return false;
  }
  const info=codeInfo(raw);
  if(!info.ok){toast('読み取りましたが、対応外または番号が不正なバーコードです。','error');return false;}
  $('#code').value=info.code;updatePreview();stopCamera();$('#name').focus();
  toast(`${info.type}：${info.code} を読み取りました。商品名を入力してください。`);
  return true;
}
function isSupportedScanFormat(format){
  const formats=window.ZXingBrowser?.BarcodeFormat;
  return !!formats&&[formats.EAN_13,formats.EAN_8,formats.UPC_A].includes(format);
}
function loadDecoder(){
  if(window.ZXingBrowser?.BrowserMultiFormatReader)return Promise.resolve();
  if(decoderLoading)return decoderLoading;
  decoderLoading=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src=SCAN_LIBRARY_URL;script.async=true;
    script.crossOrigin='anonymous';script.referrerPolicy='no-referrer';
    // Verified against the published @zxing/browser@0.2.1 npm UMD artifact.
    // A modified CDN response is blocked by the browser before execution.
    script.integrity='sha384-HRtzk9lZgkbSgvUyQrnfC/GxiXZgwaNyD7hC9wcXlsBpDhkS80ISl73juef2FRuf';
    script.onload=()=>window.ZXingBrowser?.BrowserMultiFormatReader?resolve():reject(new Error('読み取り機能の初期化に失敗しました。'));
    script.onerror=()=>reject(new Error('読み取り機能を読み込めません。初回はインターネット接続が必要です。'));
    document.head.append(script);
  }).catch(err=>{decoderLoading=null;throw err;});
  return decoderLoading;
}
async function startCamera(){
  if(!navigator.mediaDevices?.getUserMedia){toast('この環境ではカメラを起動できません。HTTPSのURLで開いてください。','error');return;}
  const button=$('#start-camera'),session=++scanSession;button.disabled=true;
  try{
    await loadDecoder();
    if(session!==scanSession)return;
    $('#scanner').hidden=false;$('#camera-status').textContent='バーコード全体を枠内に合わせてください';
    reader=new window.ZXingBrowser.BrowserMultiFormatReader();
    const formats=window.ZXingBrowser.BarcodeFormat;
    if(!formats)throw Error('読み取り形式の初期化に失敗しました。');
    reader.possibleFormats=[formats.EAN_13,formats.EAN_8,formats.UPC_A];
    const controls=await reader.decodeFromConstraints({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}},$('#camera'),(result,error,control)=>{
      if(session!==scanSession){control?.stop();return;}
      if(result){const raw=result.getText();if(handleScanValue(raw,result.getBarcodeFormat()))control?.stop();}
    });
    if(session!==scanSession){
      try{controls?.stop();}catch{}
      return;
    }
    scanControls=controls;
  }catch(error){
    if(session===scanSession){stopCamera();toast('カメラを起動できません：'+(error?.message||'カメラの使用を許可してください。'),'error');}
  }finally{if(session===scanSession)button.disabled=false;}
}
function stopCamera(){
  scanSession++;
  $('#start-camera').disabled=false;
  try{scanControls?.stop();}catch{}
  scanControls=null;
  const video=$('#camera');
  try{video.srcObject?.getTracks().forEach(track=>track.stop());}catch{}
  video.srcObject=null;
  $('#scanner').hidden=true;
}
$('#editor').addEventListener('submit',async e=>{
  e.preventDefault();
  if(productSaving)return;
  productSaving=true;$('#save').disabled=true;
  let beforeCatalog=null,beforeRecords=null,committed=false;
  try{
    const data=formData();
    beforeCatalog=cloneData(catalog);beforeRecords=cloneData(records);
    let product;
    let message='商品とバーコードを保存し、印刷リストに追加しました。';
    if(editingCatalogId){
      const previous=catalog.find(x=>x.id===editingCatalogId);
      if(!previous)throw Error('編集対象が見つかりません。');
      product=upsertCatalog(data,previous.code,false);
      for(const rec of records)if(rec.code===previous.code){rec.code=data.code;rec.name=data.name;rec.nameBreak=data.nameBreak;}
      message='商品情報を更新しました。登録日は変更されません。';
    }else if(editingId){
      const existing=records.find(x=>x.id===editingId);
      if(!existing)throw Error('編集対象が見つかりません。');
      product=upsertCatalog(data,existing.code,false);
      Object.assign(existing,{code:data.code,name:data.name,nameBreak:data.nameBreak,qty:data.qty});
      for(const rec of records)if(rec.code===data.code){rec.name=data.name;rec.nameBreak=data.nameBreak;}
      message='印刷リストと保存商品を更新しました。';
    }else{
      if(records.length>=200)throw Error('印刷リストは200件までです。');
      product=upsertCatalog(data,null,false);
      records.unshift({id:makeId(),code:data.code,name:data.name,nameBreak:data.nameBreak,qty:data.qty,selected:true});
    }
    persistState();
    committed=true;
    renderRecords();renderCatalog();clearForm();toast(message);
  }catch(err){
    if(beforeCatalog!==null&&!committed){
      catalog=beforeCatalog;records=beforeRecords;
      renderRecords();renderCatalog();
    }
    toast(err.message,'error');
  }
  finally{productSaving=false;$('#save').disabled=false;}
});
$('#code').addEventListener('input',updatePreview);
$('#name').addEventListener('input',()=>{
  const field=$('#name'),current=field.value;
  const next=insertedFullwidthSpace(previousNameValue,current);
  manualNameBreak=next===null
    ?keepBreakWhenEditing(previousNameValue,current,manualNameBreak)
    :next;
  previousNameValue=current;
  updateNameBreakStatus();
  updatePreview();
});
$('#reset').addEventListener('click',clearForm);
$('#minus').addEventListener('click',()=>{$('#qty').value=Math.max(1,Number($('#qty').value||1)-1);});
$('#plus').addEventListener('click',()=>{$('#qty').value=Math.min(99,Number($('#qty').value||1)+1);});
$('#print-one').addEventListener('click',()=>{
  try{printLabels([formData()]);}catch(err){toast(err.message,'error');}
});
$('#print-all').addEventListener('click',()=>printLabels(records.filter(r=>r.selected)));
$('#close-print-preview').addEventListener('click',closePrintPreview);
$('#confirm-print').addEventListener('click',confirmPrint);
$('#export-print-transfer').addEventListener('click',exportPrintTransfer);
$('#preview-paper').addEventListener('change',e=>{$('#paper').value=e.target.value;buildPrintSheets();});
$('#label-layout').addEventListener('change',e=>setLabelLayout(e.target.value));
$('#preview-label-layout').addEventListener('change',e=>setLabelLayout(e.target.value));
$('#label-height').addEventListener('change',e=>setLabelHeight(e.target.value));
$('#preview-label-height').addEventListener('change',e=>setLabelHeight(e.target.value));
window.addEventListener('resize',()=>{fitLabelName($('#preview .name-cell'));scalePreviewPages();});
$('#print-preview-overlay').addEventListener('click',e=>{if(e.target.id==='print-preview-overlay')closePrintPreview();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#print-preview-overlay').hidden)closePrintPreview();});
installFolderReordering();
installProductReordering();
$('#catalog-search').addEventListener('input',()=>{selectedCatalogIds.clear();renderCatalog();});
$('#catalog-sort').addEventListener('change',renderCatalog);
$('#folder-add-trigger').addEventListener('click',()=>{
  const form=$('#folder-create-form');
  form.hidden=!form.hidden;
  if(!form.hidden)$('#folder-name').focus();
});
$('#folder-add-cancel').addEventListener('click',()=>{
  $('#folder-create-form').hidden=true;
  $('#folder-name').value='';
});
$('#folder-create-form').addEventListener('submit',event=>{
  event.preventDefault();
  try{
    const folder=addFolder($('#folder-name').value);
    $('#folder-name').value='';
    $('#folder-create-form').hidden=true;
    openCatalogFolder(folder.id);
    toast('フォルダを作成しました。');
  }catch(error){toast(error.message,'error');}
});
$('#catalog-back').addEventListener('click',()=>{
  catalogFolderOpened=false;
  catalogSelectionMode=false;
  selectedCatalogIds.clear();
  renderCatalog();
  window.scrollTo({top:0,behavior:'auto'});
});
function closeFolderMenu(restoreFocus=false){
  const menu=$('#folder-page-actions');
  menu.open=false;
  if(restoreFocus&&!menu.hidden)$('#folder-page-menu-toggle').focus();
}
document.addEventListener('click',event=>{
  if(!$('#folder-page-actions').contains(event.target))closeFolderMenu();
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&$('#folder-page-actions').open){
    event.preventDefault();closeFolderMenu(true);
  }
});
$('#folder-page-edit').addEventListener('click',()=>{
  closeFolderMenu(true);
  const folder=catalogFolderOpened?folders.find(f=>f.id===activeFolder):null;
  if(!folder)return;
  const next=window.prompt('フォルダ名を編集',folder.name);
  if(next===null)return;
  try{
    renameFolder(folder.id,next);
    toast('フォルダ名を変更しました。');
  }catch(error){toast(error.message,'error');}
});
$('#folder-page-delete').addEventListener('click',()=>{
  closeFolderMenu(true);
  const folder=catalogFolderOpened?folders.find(f=>f.id===activeFolder):null;
  if(!folder)return;
  try{
    if(deleteFolder(folder.id)){
      catalogSelectionMode=false;
      selectedCatalogIds.clear();
      renderCatalog();
      toast('フォルダを削除しました。中の商品は未分類に移動しました。');
      $('#folder-add-trigger').focus();
    }
  }catch(error){toast(error.message,'error');}
});
$('#catalog-select-mode').addEventListener('click',()=>{
  catalogSelectionMode=!catalogSelectionMode;
  selectedCatalogIds.clear();
  renderCatalog();
});
$('#bulk-select-visible').addEventListener('click',()=>{for(const id of visibleCatalogIds)selectedCatalogIds.add(id);renderCatalog();});
$('#bulk-clear').addEventListener('click',()=>{selectedCatalogIds.clear();renderCatalog();});
$('#bulk-move').addEventListener('click',()=>{
  try{
    const count=changeProductFolders([...selectedCatalogIds],$('#bulk-folder-target').value||null);
    selectedCatalogIds.clear();
    catalogSelectionMode=false;
    renderCatalog();
    toast(count+'商品を移動しました。');
  }catch(error){toast(error.message,'error');}
});
$('#backup-export').addEventListener('click',exportBackup);
$('#backup-file').addEventListener('change',e=>restoreBackup(e.target.files?.[0]));
window.addEventListener('hashchange',()=>showPage(window.location.hash==='#saved'?'saved':'create'));
$('#clear-all').addEventListener('click',()=>{
  if(!records.length)return;
  if(window.confirm(`印刷リストの${records.length}件をすべて削除しますか？保存した商品は残ります。`)){
    const before=records;records=[];
    if(!saveRecords())records=before;
    else{clearForm();toast('印刷リストを削除しました。');}
    renderRecords();
  }
});
$('#start-camera').addEventListener('click',startCamera);
$('#stop-camera').addEventListener('click',stopCamera);
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopCamera();});
window.addEventListener('pagehide',stopCamera);
if('serviceWorker' in navigator && (location.protocol==='https:' || location.hostname==='localhost'))navigator.serviceWorker.register('./sw.js').catch(()=>{});
$('#label-height').value=String(labelHeightMm);
$('#preview-label-height').value=String(labelHeightMm);
$('#label-layout').value=labelLayout;
$('#preview-label-layout').value=labelLayout;
if(storageReadError)toast('保存データを読み取れません。元のデータは変更せず保護しています。','error');
migrateOldProducts();renderRecords();renderCatalog();updatePreview();showPage(window.location.hash==='#saved'?'saved':'create');