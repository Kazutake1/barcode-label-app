'use strict';
// JAN/EAN printing is generated locally. Scanning loads a pinned ZXing decoder only when requested.
const STORE_KEY = 'barcode-label-local-v1';
const CATALOG_KEY = 'barcode-label-catalog-v1';
const FOLDERS_KEY = 'barcode-label-folders-v1';
const MAX_FOLDERS = 50;
const MAX_FOLDER_NAME = 30;
const MAX_PRODUCT_TAGS=8;
const MAX_TAG_LENGTH=20;
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
let selectedCatalogIds = new Set();
let visibleCatalogIds = [];
let editingCatalogId = null;
let editingId = null;
let scanControls = null;
let reader = null;
let decoderLoading = null;
let toastTimer = null;
let stagedPrintItems = [];

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
function createBarcodeSvg(code) {
  const bits=barcodeBits(code), isSmall=code.length===8;
  const qleft=isSmall?7:11, qright=7;
  const modules=qleft+bits.length+qright;
  const svg=svgElem('svg',{xmlns:'http://www.w3.org/2000/svg',viewBox:`0 0 ${modules} 54`,width:`${(modules*.33).toFixed(2)}mm`,height:'17.82mm',role:'img','aria-label':`バーコード ${code}`});
  svg.append(svgElem('rect',{x:0,y:0,width:modules,height:54,fill:'#ffffff'}));
  let i=0;
  while(i<bits.length){
    if(bits[i]==='0'){i++;continue;}
    const start=i;
    while(i<bits.length && bits[i]==='1')i++;
    const guard=(start<3)||(start>=bits.length-3)||(start>=((bits.length-5)/2)&&start<((bits.length+5)/2));
    svg.append(svgElem('rect',{x:qleft+start,y:0,width:i-start,height:guard?44:40,fill:'#000000'}));
  }
  const text=svgElem('text',{x:modules/2,y:52.1,'text-anchor':'middle','font-size':'8.3','font-family':'Arial, sans-serif','font-weight':'500',fill:'#000000','letter-spacing':'.45'});
  text.textContent=code;
  svg.append(text);
  return svg;
}
function createLabel({code,name}){
  const container=document.createElement('div');container.className='product-label';
  const body=document.createElement('div');body.className='label-body';
  const nameCell=document.createElement('div');nameCell.className='name-cell';nameCell.textContent=name||'商品名';
  const barcodeCell=document.createElement('div');barcodeCell.className='barcode-cell';
  barcodeCell.append(createBarcodeSvg(code));
  body.append(nameCell,barcodeCell);

  container.append(body);
  return container;
}
function readRecords(){
  try{
    const data=JSON.parse(localStorage.getItem(STORE_KEY)||'[]');
    if(!Array.isArray(data))return [];
    return data.filter(x=>x&&typeof x.name==='string'&&x.name.length<=80&&codeInfo(x.code).ok).slice(0,200)
      .map(x=>({id:String(x.id||''),code:String(x.code),name:x.name,qty:Math.max(1,Math.min(99,Number(x.qty)||1)),selected:x.selected!==false}));
  }catch{return []}
}


function normalizeTags(value,strict=false){
  if(value===undefined||value===null||value==='')return [];
  const parts=typeof value==='string'?value.split(/[,、，]/):Array.isArray(value)?value:null;
  if(!parts){if(strict)throw Error('タグの形式が正しくありません。');return [];}
  const result=[],seen=new Set();
  for(const raw of parts){
    if(typeof raw!=='string'){
      if(strict)throw Error('タグは文字で指定してください。');
      continue;
    }
    const tag=raw.trim();
    if(!tag)continue;
    if(tag.length>MAX_TAG_LENGTH||/[\x00-\x1f\x7f]/.test(tag)){
      if(strict)throw Error('タグは1つ20文字以内にしてください。');
      continue;
    }
    const key=tag.toLocaleLowerCase('ja');
    if(seen.has(key))continue;
    seen.add(key);result.push(tag);
    if(result.length>MAX_PRODUCT_TAGS){
      if(strict)throw Error('1商品につけられるタグは8個までです。');
      return result.slice(0,MAX_PRODUCT_TAGS);
    }
  }
  return result;
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
    const raw=JSON.parse(localStorage.getItem(FOLDERS_KEY)||'[]');
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
  const oldFolders=localStorage.getItem(FOLDERS_KEY);
  const oldCatalog=nextCatalog===null?null:localStorage.getItem(CATALOG_KEY);
  try{
    if(nextCatalog!==null)localStorage.setItem(CATALOG_KEY,JSON.stringify(nextCatalog));
    localStorage.setItem(FOLDERS_KEY,JSON.stringify(nextFolders));
  }catch{
    try{
      if(nextCatalog!==null){
        if(oldCatalog===null)localStorage.removeItem(CATALOG_KEY);
        else localStorage.setItem(CATALOG_KEY,oldCatalog);
      }
      if(oldFolders===null)localStorage.removeItem(FOLDERS_KEY);
      else localStorage.setItem(FOLDERS_KEY,oldFolders);
    }catch{}
    throw Error('フォルダの保存に失敗しました。端末の空き容量をご確認ください。');
  }
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
  if(activeFolder===id)activeFolder='none';
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
function renderFolders(){
  const list=$('#folder-grid');list.replaceChildren();
  const allCount=catalog.length,noneCount=catalog.filter(p=>!resolveFolderId(p.folderId)).length;
  const items=[{id:'all',name:'すべての商品',count:allCount},
    {id:'none',name:'未分類',count:noneCount},
    ...folders.map(f=>({...f,count:catalog.filter(p=>p.folderId===f.id).length}))];
  for(const folder of items){
    const item=document.createElement('div');item.className='folder-card';
    const view=document.createElement('button');view.type='button';view.className='folder-open';
    view.setAttribute('aria-pressed',String(activeFolder===folder.id));
    const name=document.createElement('span');name.className='folder-name';name.textContent=folder.name;
    const qty=document.createElement('span');qty.className='folder-count';qty.textContent=folder.count+'商品';
    view.append(name,qty);view.addEventListener('click',()=>{activeFolder=folder.id;selectedCatalogIds.clear();renderCatalog();});
    item.append(view);
    if(folder.id!=='all'&&folder.id!=='none'){
      const actions=document.createElement('div');actions.className='folder-actions';
      const rename=document.createElement('button');rename.type='button';rename.textContent='名前変更';
      rename.setAttribute('aria-label',folder.name+'の名前を変更');
      rename.addEventListener('click',()=>{
        const newName=window.prompt('フォルダ名を変更',folder.name);
        if(newName===null)return;
        try{renameFolder(folder.id,newName);}catch(error){toast(error.message,'error');}
      });
      const del=document.createElement('button');del.type='button';del.textContent='削除';del.className='folder-delete';
      del.setAttribute('aria-label',folder.name+'を削除');
      del.addEventListener('click',()=>{try{deleteFolder(folder.id);}catch(error){toast(error.message,'error');}});
      actions.append(rename,del);item.append(actions);
    }
    list.append(item);
  }
  $('#folder-count').textContent=folders.length+'フォルダ';
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
    const items=JSON.parse(localStorage.getItem(CATALOG_KEY)||'[]');
    if(!Array.isArray(items))return [];
    const seen=new Set();
    return items.filter(x=>{
      if(!x||typeof x.name!=='string'||!x.name.trim()||x.name.length>80||!codeInfo(x.code).ok||seen.has(x.code))return false;
      seen.add(x.code);return true;
    }).slice(0,500).map(x=>({
      id:String(x.id||makeId()),code:x.code,name:x.name,tags:normalizeTags(x.tags),folderId:resolveFolderId(x.folderId),
      createdAt:typeof x.createdAt==='string'&&!Number.isNaN(Date.parse(x.createdAt))?x.createdAt:null,
      updatedAt:typeof x.updatedAt==='string'&&!Number.isNaN(Date.parse(x.updatedAt))?x.updatedAt:null
    }));
  }catch{return [];}
}
function makeId(){return globalThis.crypto?.randomUUID?.()||String(Date.now())+'-'+Math.random().toString(36).slice(2);}
function saveCatalog(){
  try{localStorage.setItem(CATALOG_KEY,JSON.stringify(catalog));return true;}
  catch{toast('保存に失敗しました。端末の空き容量やSafariの設定を確認してください。','error');return false;}
}
function migrateOldProducts(){
  try{if(localStorage.getItem(CATALOG_KEY)!==null)return;}catch{return;}
  const unique=new Map();
  for(const rec of records)if(!unique.has(rec.code))unique.set(rec.code,{
    id:makeId(),code:rec.code,name:rec.name,folderId:null,createdAt:null,updatedAt:null
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
function upsertCatalog(data,originalCode=null){
  let original=originalCode?catalog.find(x=>x.code===originalCode):catalog.find(x=>x.code===data.code);
  const duplicate=catalog.find(x=>x.code===data.code);
  if(original&&duplicate&&original.id!==duplicate.id)throw Error('このバーコード番号は別の商品として登録済みです。');
  if(!original)original=duplicate;
  if(!original&&catalog.length>=500)throw Error('保存できる商品は500件までです。');
  if(data.folderId!==undefined&&data.folderId!==null&&!folders.some(f=>f.id===data.folderId))throw Error('指定したフォルダが見つかりません。');
  const now=new Date().toISOString();
  const entry=original
    ?{...original,code:data.code,name:data.name,tags:data.tags??original.tags??[],folderId:data.folderId===undefined?(original.folderId??null):data.folderId,updatedAt:now}
    :{id:makeId(),code:data.code,name:data.name,tags:data.tags??[],folderId:data.folderId??null,createdAt:now,updatedAt:now};
  const previous=catalog;
  catalog=original
    ?catalog.map(x=>x.id===original.id?entry:x)
    :[entry,...catalog];
  if(!saveCatalog()){catalog=previous;throw Error('商品データを保存できませんでした。');}
  return entry;
}
function showPage(page){
  const saved=page==='saved';
  $('#create-page').hidden=saved;
  $('#catalog-page').hidden=!saved;
  $('#nav-create').setAttribute('aria-current',saved?'false':'page');
  $('#nav-saved').setAttribute('aria-current',saved?'page':'false');
  if(saved)stopCamera();
  window.scrollTo({top:0,behavior:'auto'});
}
function openCreatePage(){
  showPage('create');
  if(window.location.hash!=='#create')window.location.hash='#create';
}

function renderCatalog(){
  $('#catalog-count').textContent=catalog.length+'件';
  const filter=$('#catalog-tag-filter');
  const previous=filter.value;
  const distinct=[...new Set(catalog.flatMap(x=>x.tags??[]))].sort((a,b)=>a.localeCompare(b,'ja'));
  filter.replaceChildren();
  const all=document.createElement('option');all.value='all';all.textContent='すべてのタグ';filter.append(all);
  const none=document.createElement('option');none.value='none';none.textContent='タグなし';filter.append(none);
  for(const tag of distinct){const option=document.createElement('option');option.value='tag:'+tag;option.textContent=tag;filter.append(option);}
  filter.value=[...filter.options].some(x=>x.value===previous)?previous:'all';
  const term=$('#catalog-search').value.trim().toLocaleLowerCase();
  const selectedTag=filter.value;
  const filtered=catalog.filter(x=>
    (activeFolder==='all'||(activeFolder==='none'&&!resolveFolderId(x.folderId))||x.folderId===activeFolder)
    &&(x.name.toLocaleLowerCase().includes(term)||x.code.includes(term)||(x.tags??[]).some(t=>t.toLocaleLowerCase().includes(term)))
    &&(selectedTag==='all'||(selectedTag==='none'&&!(x.tags??[]).length)||(selectedTag.startsWith('tag:')&&(x.tags??[]).includes(selectedTag.slice(4))))
  );
  const order=$('#catalog-sort').value;
  const compare=(a,b)=>a.localeCompare(b,'ja',{numeric:true});
  filtered.sort((a,b)=>{
    if(order==='name')return compare(a.name,b.name)||compare(a.code,b.code);
    if(order==='code')return compare(a.code,b.code);
    const da=a.createdAt?new Date(a.createdAt).getTime():0, db=b.createdAt?new Date(b.createdAt).getTime():0;
    return (order==='oldest'?da-db:db-da)||compare(a.name,b.name);
  });
  visibleCatalogIds=filtered.map(p=>p.id);
  $('#catalog-results').textContent='表示 '+filtered.length+'件 / 全'+catalog.length+'件'+' · '+(activeFolder==='all'?'すべての商品':activeFolder==='none'?'未分類':folderName(activeFolder));
  renderFolders();
  updateBulkSelection();
  const target=$('#catalog-items');target.replaceChildren();
  if(!filtered.length){
    const empty=document.createElement('div');empty.className='empty-list';
    empty.textContent=catalog.length?'条件に合う商品がありません。':'商品を登録すると、ここに保存されます。';
    target.append(empty);return;
  }
  for(const product of filtered){
    const row=document.createElement('div');row.className='catalog-item';
    const selectRow=document.createElement('div');selectRow.className='catalog-row';
    const check=document.createElement('input');check.type='checkbox';check.className='catalog-select';
    check.checked=selectedCatalogIds.has(product.id);
    check.setAttribute('aria-label',product.name+'を一括移動の対象にする');
    check.addEventListener('change',()=>{if(check.checked)selectedCatalogIds.add(product.id);else selectedCatalogIds.delete(product.id);updateBulkSelection();});
    selectRow.append(check);
    const data=document.createElement('div');data.className='catalog-details';
    const name=document.createElement('div');name.className='catalog-name';name.textContent=product.name;
    const code=document.createElement('div');code.className='catalog-code';code.textContent=product.code;
    const date=document.createElement('div');date.className='catalog-date';date.textContent=registrationLabel(product.createdAt);
    data.append(name,code);
    if(product.tags?.length){
      const tags=document.createElement('div');tags.className='catalog-tags';
      for(const value of product.tags){
        const chip=document.createElement('button');chip.type='button';chip.className='catalog-tag';chip.textContent=value;
        chip.setAttribute('aria-label',value+'で絞り込み');
        chip.addEventListener('click',()=>{$('#catalog-tag-filter').value='tag:'+value;renderCatalog();});
        tags.append(chip);
      }
      data.append(tags);
    }
    const summary=document.createElement('div');summary.className='catalog-summary';
    summary.append(data,date);selectRow.append(summary);
    const moveRow=document.createElement('div');moveRow.className='catalog-move-row';
    const moveLabel=document.createElement('label');moveLabel.textContent='所属フォルダ';
    const moveSelect=document.createElement('select');moveSelect.className='catalog-folder-move';
    const unclassifiedOption=document.createElement('option');unclassifiedOption.value='';unclassifiedOption.textContent='未分類';moveSelect.append(unclassifiedOption);
    for(const folder of folders){const option=document.createElement('option');option.value=folder.id;option.textContent=folder.name;moveSelect.append(option);}
    moveSelect.value=resolveFolderId(product.folderId)||'';
    moveLabel.append(moveSelect);
    moveSelect.addEventListener('change',()=>{
      try{
        const changed=changeProductFolders([product.id],moveSelect.value||null);
        if(changed)toast('所属フォルダを変更しました。');
      }catch(error){toast(error.message,'error');renderCatalog();}
    });
    moveRow.append(moveLabel);
    const actions=document.createElement('div');actions.className='catalog-actions';
    const add=document.createElement('button');add.type='button';add.className='catalog-add';add.textContent='印刷リストに追加';
    add.addEventListener('click',()=>{
      const existing=records.find(x=>x.code===product.code);
      if(existing){existing.name=product.name;existing.selected=true;toast('印刷リストの既存商品を選択しました。');}
      else{
        if(records.length>=200){toast('印刷リストは200件までです。不要な商品をリストから削除してください。','error');return;}
        records.unshift({id:makeId(),code:product.code,name:product.name,qty:1,selected:true});
        toast('印刷リストに追加しました。');
      }
      saveRecords();renderRecords();
    });
    const edit=document.createElement('button');edit.type='button';edit.textContent='編集';
    edit.addEventListener('click',()=>{
      editingId=null;editingCatalogId=product.id;
      $('#code').value=product.code;$('#name').value=product.name;$('#qty').value='1';$('#tags').value=(product.tags??[]).join('、');
      $('#folder-select').value=resolveFolderId(product.folderId)||'';
      $('#save').textContent='商品情報を更新';
      updatePreview();openCreatePage();$('#name').focus();
    });
    const del=document.createElement('button');del.type='button';del.className='catalog-delete';del.textContent='削除';
    del.addEventListener('click',()=>{
      if(!window.confirm('「'+product.name+'」を保存商品から削除しますか？\\n印刷リストの内容は残ります。'))return;
      const old=catalog;catalog=catalog.filter(x=>x.id!==product.id);
      if(!saveCatalog()){catalog=old;return;}
      if(editingCatalogId===product.id)clearForm();
      selectedCatalogIds.delete(product.id);renderCatalog();toast('保存商品から削除しました。');
    });
    actions.append(add,edit,del);row.append(selectRow,moveRow,actions);target.append(row);
  }
}


const BACKUP_FORMAT = 'barcode-label-app-backup';
const BACKUP_VERSION = 1;
const BACKUP_FILE_LIMIT = 2 * 1024 * 1024;

function backupStatus(message,isError=false){
  const target=$('#backup-status');
  target.textContent=message;
  target.hidden=!message;
  target.className=isError?'backup-status error':'backup-status';
}
function makeBackupDocument(){
  return {
    format:BACKUP_FORMAT,
    version:BACKUP_VERSION,
    exportedAt:new Date().toISOString(),
    folders:folders.map(f=>({id:f.id,name:f.name})),
    savedProducts:catalog.map(x=>({
      id:x.id,code:x.code,name:x.name,tags:x.tags??[],folderId:resolveFolderId(x.folderId),
      createdAt:x.createdAt,updatedAt:x.updatedAt
    })),
    printList:records.map(x=>({
      id:x.id,code:x.code,name:x.name,qty:x.qty,selected:x.selected
    }))
  };
}
async function exportBackup(){
  if(!catalog.length&&!records.length&&!folders.length){
    backupStatus('保存されている商品・印刷リストがありません。',true);return;
  }
  const documentData=makeBackupDocument();
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
        }catch(error){
          if(error?.name==='AbortError'){backupStatus('バックアップの保存をキャンセルしました。');return;}
          throw error;
        }
        return;
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
    if(seenCodes.has(item.code))throw Error('バックアップに同じバーコード番号の商品が重複しています。');
    seenCodes.add(item.code);
    const tags=normalizeTags(item.tags,true);
    const folderId=item.folderId??null;
    if(folderId!==null&&(!validFolderId(folderId)||!seenFolderIds.has(folderId)))throw Error('バックアップの商品が存在しないフォルダを参照しています。');
    return {code:item.code,name:item.name,tags,folderId,createdAt:item.createdAt,updatedAt:item.updatedAt};
  });
  const printItems=raw.printList.map((item,index)=>{
    if(!item||typeof item!=='object'||Array.isArray(item)||typeof item.code!=='string'||!codeInfo(item.code).ok
       ||!validName(item.name)||!Number.isInteger(item.qty)||item.qty<1||item.qty>99||typeof item.selected!=='boolean'){
      throw Error('印刷リスト'+(index+1)+'件目の形式が正しくありません。');
    }
    return {code:item.code,name:item.name,qty:item.qty,selected:item.selected};
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
  const existingPrint=new Set(records.map(x=>JSON.stringify([x.code,x.name,x.qty])));
  const addPrint=[];
  for(const item of backup.printItems){
    const identity=JSON.stringify([item.code,item.name,item.qty]);
    if(existingPrint.has(identity))continue;
    existingPrint.add(identity);
    addPrint.push({id:makeId(),...item});
  }
  if(catalog.length+addProducts.length>500||records.length+addPrint.length>200){
    throw Error('保存件数の上限を超えるため復元できません。不要な商品を整理してからお試しください。');
  }
  const createdFolders=nextFolders.length-folders.length;
  if(!addProducts.length&&!addPrint.length&&!createdFolders)return {saved:0,print:0,folders:0,skipped:backup.products.length};
  const nextCatalog=[...catalog,...addProducts];
  const nextRecords=[...records,...addPrint];
  const originalCatalog=localStorage.getItem(CATALOG_KEY);
  const originalRecords=localStorage.getItem(STORE_KEY);
  const originalFolders=localStorage.getItem(FOLDERS_KEY);
  try{
    localStorage.setItem(CATALOG_KEY,JSON.stringify(nextCatalog));
    localStorage.setItem(STORE_KEY,JSON.stringify(nextRecords));
    localStorage.setItem(FOLDERS_KEY,JSON.stringify(nextFolders));
  }catch(error){
    // Roll back both keys to avoid a half-restored backup.
    try{
      if(originalCatalog===null)localStorage.removeItem(CATALOG_KEY);
      else localStorage.setItem(CATALOG_KEY,originalCatalog);
      if(originalRecords===null)localStorage.removeItem(STORE_KEY);
      else localStorage.setItem(STORE_KEY,originalRecords);
      if(originalFolders===null)localStorage.removeItem(FOLDERS_KEY);
      else localStorage.setItem(FOLDERS_KEY,originalFolders);
    }catch{}
    throw Error('端末への保存に失敗しました。空き容量をご確認ください。');
  }
  folders=nextFolders;
  catalog=nextCatalog;
  records=nextRecords;
  renderCatalog();renderRecords();
  return {saved:addProducts.length,print:addPrint.length,folders:createdFolders,skipped:backup.products.length-addProducts.length};
}
async function restoreBackup(file){
  if(!file)return;
  try{
    if(!file.name?.toLowerCase().endsWith('.json'))throw Error('JSONファイル（.json）を選択してください。');
    if(file.size>BACKUP_FILE_LIMIT)throw Error('ファイルが大きすぎます（上限2MB）。');
    const raw=JSON.parse((await file.text()).replace(/^\uFEFF/,''));
    const parsed=validateBackupDocument(raw);
    if(!parsed.products.length&&!parsed.printItems.length&&!parsed.folders.length){
      backupStatus('バックアップには商品情報が入っていません。',true);return;
    }
    const proposed=parsed.products.filter(x=>!catalog.some(current=>current.code===x.code)).length;
    const answer=window.confirm(
      `保存商品：${parsed.products.length}件（うち未登録 ${proposed}件）\nフォルダ：${parsed.folders.length}個\n印刷リスト：${parsed.printItems.length}件\n\n既存データを残して追加します。\n同じバーコード番号の商品は上書きしません。\n\n復元しますか？`
    );
    if(!answer){backupStatus('復元をキャンセルしました。');return;}
    const result=mergeBackup(parsed);
    backupStatus(`復元完了：新規フォルダ${result.folders}個、商品${result.saved}件、印刷リスト${result.print}件を追加しました。重複商品${result.skipped}件は変更していません。`);
    clearForm();
  }catch(error){
    backupStatus(error?.message||'バックアップを読み込めませんでした。',true);
  }finally{
    $('#backup-file').value='';
  }
}

function saveRecords(){try{localStorage.setItem(STORE_KEY,JSON.stringify(records));}catch{toast('端末の保存領域に空きがありません。','error');}}
function toast(message,type='ok'){
  const target=$('#toast');target.textContent=message;target.className='toast show'+(type==='error'?' error':'');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>target.classList.remove('show'),5600);
}
function formData(){
  const info=codeInfo($('#code').value);
  if(!info.ok)throw Error(info.error);
  const name=$('#name').value.trim();if(!name)throw Error('商品名を入力してください。');
  const qty=Number($('#qty').value);
  if(!Number.isInteger(qty)||qty<1||qty>99)throw Error('印刷枚数は1～99で指定してください。');
  const tags=normalizeTags($('#tags').value,true);
  return {code:info.code,name,qty,tags,folderId:$('#folder-select').value||null};
}
function updatePreview(){
  const info=codeInfo($('#code').value), target=$('#preview'), status=$('#code-status');
  target.replaceChildren();
  if(info.ok){
    status.textContent=`${info.type} ・ チェックデジット確認済み`;
    status.className='hint valid';
    target.append(createLabel({code:info.code,name:$('#name').value.trim()}));
    $('#print-one').disabled=!$('#name').value.trim();
  }else{
    status.textContent=info.error==='番号を入力してください。'?'JAN-13（13桁）、JAN-8（8桁）、UPC-A（12桁）に対応':info.error;
    status.className='hint'+(info.error==='番号を入力してください。'?'':' invalid');
    const empty=document.createElement('div');empty.className='preview-empty';empty.textContent='正しい番号を入力すると、バーコードが表示されます。';
    target.append(empty);$('#print-one').disabled=true;
  }
}
function clearForm(){
  editingId=null;editingCatalogId=null;HTMLFormElement.prototype.reset.call($('#editor'));$('#qty').value='1';$('#folder-select').value='';$('#save').textContent='保存して印刷リストに追加';updatePreview();
}
function renderRecords(){
  $('#item-count').textContent=records.length+'件';
  const target=$('#items');target.replaceChildren();
  if(!records.length){const empty=document.createElement('div');empty.className='empty-list';empty.textContent='印刷リストは空です。保存した商品からも追加できます。';target.append(empty);}
  for(const rec of records){
    const wrapper=document.createElement('div');wrapper.className='item';
    const check=document.createElement('input');check.type='checkbox';check.className='item-check';check.checked=rec.selected;
    check.setAttribute('aria-label',`${rec.name}を印刷する`);check.addEventListener('change',()=>{rec.selected=check.checked;saveRecords();});
    const detail=document.createElement('div');detail.className='item-details';
    const nm=document.createElement('div');nm.className='item-name';nm.textContent=rec.name;
    const sub=document.createElement('div');sub.className='item-sub';sub.textContent=`${rec.code} / ${rec.qty}枚`;
    detail.append(nm,sub);
    const actions=document.createElement('div');actions.className='item-actions';
    const edit=document.createElement('button');edit.type='button';edit.textContent='編集';
    edit.addEventListener('click',()=>{editingCatalogId=null;editingId=rec.id;$('#code').value=rec.code;$('#name').value=rec.name;$('#qty').value=rec.qty;$('#tags').value=(catalog.find(x=>x.code===rec.code)?.tags??[]).join('、');$('#folder-select').value=resolveFolderId(catalog.find(x=>x.code===rec.code)?.folderId)||'';$('#save').textContent='変更を保存';updatePreview();window.scrollTo({top:0,behavior:'smooth'});});
    const del=document.createElement('button');del.type='button';del.textContent='削除';
    del.addEventListener('click',()=>{records=records.filter(x=>x.id!==rec.id);saveRecords();renderRecords();toast('リストから削除しました。');});
    actions.append(edit,del);wrapper.append(check,detail,actions);target.append(wrapper);
  }
}
function printFeedback(message){
  const box=$('#print-feedback');
  box.textContent=message;
  box.hidden=!message;
  if(message)box.scrollIntoView({behavior:'smooth',block:'nearest'});
}
function printLabels(items){
  const total=items.reduce((sum,item)=>sum+item.qty,0);
  if(!total){printFeedback('印刷する商品がありません。「リストに追加」を押して保存し、印刷する商品にチェックを入れてください。');return;}
  if(total>200){printFeedback('一度に印刷できるのは200枚までです。枚数を減らしてください。');return;}
  printFeedback('');
  stagedPrintItems=items.map(item=>({...item}));
  buildPrintSheets();
  $('#print-preview-overlay').hidden=false;
  document.body.classList.add('print-preview-open');
  scalePreviewPages();
  $('#close-print-preview').focus();
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
  const perPage=isB5?14:16;
  for(let offset=0;offset<flat.length;offset+=perPage){
    const page=document.createElement('div');
    page.className='paper-page'+(isB5?' b5':'');
    const grid=document.createElement('div');
    grid.className='paper-label-grid';
    for(const item of flat.slice(offset,offset+perPage))grid.append(createLabel(item));
    page.append(grid);
    target.append(page);

    const viewport=document.createElement('div');
    viewport.className='preview-page-viewport';
    viewport.append(page.cloneNode(true));
    preview.append(viewport);
  }
  $('#preview-paper').value=paper;
  $('#print-preview-meta').textContent=`${paper}・縦向き・2列 / ${stagedPrintItems.length}商品・合計${flat.length}枚・${Math.ceil(flat.length/perPage)}ページ`;
  const standalone=window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone===true;
  $('#print-guidance').textContent=standalone
    ? 'ホーム画面のアプリから印刷画面が開かない場合は、SafariでこのサイトのURLを直接開いてください。プリンターの用紙サイズはアプリと一致させてください。'
    : '「印刷画面を開く」の後、プリンターの用紙サイズを上で選んだサイズに合わせ、倍率を100%にしてください。';
  if(flat.length>perPage){
    $('#print-guidance').textContent=`印刷枚数の合計が${flat.length}枚のため${Math.ceil(flat.length/perPage)}ページになります。1ページに収めたい場合は、各商品の「印刷枚数」を減らしてください。`+' '+$('#print-guidance').textContent;
  }
  scalePreviewPages();
}
function scalePreviewPages(){
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
    void $('#print-sheet').offsetHeight;
    window.print();
  }catch(err){
    $('#print-guidance').textContent='印刷画面を開けませんでした。Safariでこのページを直接開き、再度お試しください。';
  }
}
function handleScanValue(raw){
  const info=codeInfo(raw);
  if(!info.ok){toast('読み取りましたが、対応外または番号が不正なバーコードです。','error');return false;}
  $('#code').value=info.code;updatePreview();stopCamera();$('#name').focus();
  toast(`${info.type}：${info.code} を読み取りました。商品名を入力してください。`);
  return true;
}
function loadDecoder(){
  if(window.ZXingBrowser?.BrowserMultiFormatReader)return Promise.resolve();
  if(decoderLoading)return decoderLoading;
  decoderLoading=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src=SCAN_LIBRARY_URL;script.async=true;
    script.onload=()=>window.ZXingBrowser?.BrowserMultiFormatReader?resolve():reject(new Error('読み取り機能の初期化に失敗しました。'));
    script.onerror=()=>reject(new Error('読み取り機能を読み込めません。初回はインターネット接続が必要です。'));
    document.head.append(script);
  }).catch(err=>{decoderLoading=null;throw err;});
  return decoderLoading;
}
async function startCamera(){
  if(!navigator.mediaDevices?.getUserMedia){toast('この環境ではカメラを起動できません。HTTPSのURLで開いてください。','error');return;}
  const button=$('#start-camera');button.disabled=true;
  try{
    await loadDecoder();
    $('#scanner').hidden=false;$('#camera-status').textContent='バーコード全体を枠内に合わせてください';
    reader=new window.ZXingBrowser.BrowserMultiFormatReader();
    const controls=await reader.decodeFromConstraints({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}},$('#camera'),(result,error,control)=>{
      if(result){const raw=result.getText();if(handleScanValue(raw))control?.stop();}
    });
    scanControls=controls;
  }catch(error){stopCamera();toast('カメラを起動できません：'+(error?.message||'カメラの使用を許可してください。'),'error');}
  finally{button.disabled=false;}
}
function stopCamera(){
  try{scanControls?.stop();}catch{}
  scanControls=null;
  const video=$('#camera');
  try{video.srcObject?.getTracks().forEach(track=>track.stop());}catch{}
  video.srcObject=null;
  $('#scanner').hidden=true;
}
async function scanPhoto(file){
  if(!file)return;
  if(!file.type.startsWith('image/')){toast('画像ファイルを選択してください。','error');return;}
  if(file.size>18*1024*1024){toast('18MB以下の画像を選んでください。','error');return;}
  let url=null;
  try{
    toast('画像のバーコードを確認しています。');
    await loadDecoder();
    url=URL.createObjectURL(file);
    const imageReader=new window.ZXingBrowser.BrowserMultiFormatReader();
    const result=await imageReader.decodeFromImageUrl(url);
    handleScanValue(result.getText());
  }catch(error){toast('画像から読み取れませんでした。明るく、バーコード全体が写った写真を使うか、番号を入力してください。','error');}
  finally{if(url)URL.revokeObjectURL(url);$('#photo-input').value='';}
}
$('#editor').addEventListener('submit',e=>{
  e.preventDefault();
  try{
    const data=formData();
    if(editingCatalogId){
      const product=catalog.find(x=>x.id===editingCatalogId);
      if(!product)throw Error('編集対象が見つかりません。');
      const previousCode=product.code;
      upsertCatalog(data,previousCode);
      for(const rec of records)if(rec.code===previousCode){rec.code=data.code;rec.name=data.name;}
      saveRecords();renderRecords();renderCatalog();
      clearForm();toast('商品情報を更新しました。登録日は変更されません。');
      return;
    }
    if(editingId){
      const existing=records.find(x=>x.id===editingId);
      if(!existing)throw Error('編集対象が見つかりません。');
      const previousCode=existing.code;
      upsertCatalog(data,previousCode);
      Object.assign(existing,{code:data.code,name:data.name,qty:data.qty});
      for(const rec of records)if(rec.code===data.code)rec.name=data.name;
      toast('印刷リストと保存商品を更新しました。');
    }else{
      if(records.length>=200)throw Error('印刷リストは200件までです。');
      upsertCatalog(data);
      records.unshift({id:makeId(),code:data.code,name:data.name,qty:data.qty,selected:true});
      toast('商品とバーコードを保存し、印刷リストに追加しました。');
    }
    saveRecords();renderRecords();renderCatalog();clearForm();
  }catch(err){toast(err.message,'error');}
});
$('#code').addEventListener('input',updatePreview);
$('#name').addEventListener('input',updatePreview);
$('#reset').addEventListener('click',clearForm);
$('#minus').addEventListener('click',()=>{$('#qty').value=Math.max(1,Number($('#qty').value||1)-1);});
$('#plus').addEventListener('click',()=>{$('#qty').value=Math.min(99,Number($('#qty').value||1)+1);});
$('#print-one').addEventListener('click',()=>{try{printLabels([formData()]);}catch(err){toast(err.message,'error');}});
$('#print-all').addEventListener('click',()=>printLabels(records.filter(r=>r.selected)));
$('#close-print-preview').addEventListener('click',closePrintPreview);
$('#confirm-print').addEventListener('click',confirmPrint);
$('#preview-paper').addEventListener('change',e=>{$('#paper').value=e.target.value;buildPrintSheets();});
window.addEventListener('resize',scalePreviewPages);
$('#print-preview-overlay').addEventListener('click',e=>{if(e.target.id==='print-preview-overlay')closePrintPreview();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#print-preview-overlay').hidden)closePrintPreview();});
$('#catalog-search').addEventListener('input',renderCatalog);
$('#catalog-tag-filter').addEventListener('change',renderCatalog);
$('#catalog-sort').addEventListener('change',renderCatalog);
$('#folder-create-form').addEventListener('submit',event=>{
  event.preventDefault();
  try{
    const folder=addFolder($('#folder-name').value);
    $('#folder-name').value='';
    activeFolder=folder.id;renderCatalog();
    toast('フォルダを作成しました。');
  }catch(error){toast(error.message,'error');}
});
$('#bulk-select-visible').addEventListener('click',()=>{for(const id of visibleCatalogIds)selectedCatalogIds.add(id);renderCatalog();});
$('#bulk-clear').addEventListener('click',()=>{selectedCatalogIds.clear();renderCatalog();});
$('#bulk-move').addEventListener('click',()=>{
  try{
    const count=changeProductFolders([...selectedCatalogIds],$('#bulk-folder-target').value||null);
    selectedCatalogIds.clear();renderCatalog();
    toast(count+'商品を移動しました。');
  }catch(error){toast(error.message,'error');}
});
$('#backup-export').addEventListener('click',exportBackup);
$('#backup-file').addEventListener('change',e=>restoreBackup(e.target.files?.[0]));
window.addEventListener('hashchange',()=>showPage(window.location.hash==='#saved'?'saved':'create'));
$('#clear-all').addEventListener('click',()=>{
  if(!records.length)return;
  if(window.confirm(`印刷リストの${records.length}件をすべて削除しますか？保存した商品は残ります。`)){
    records=[];saveRecords();renderRecords();clearForm();toast('印刷リストを削除しました。');
  }
});
$('#start-camera').addEventListener('click',startCamera);
$('#stop-camera').addEventListener('click',stopCamera);
$('#photo-input').addEventListener('change',e=>scanPhoto(e.target.files?.[0]));
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopCamera();});
window.addEventListener('pagehide',stopCamera);
if('serviceWorker' in navigator && (location.protocol==='https:' || location.hostname==='localhost'))navigator.serviceWorker.register('./sw.js').catch(()=>{});
migrateOldProducts();renderRecords();renderCatalog();updatePreview();showPage(window.location.hash==='#saved'?'saved':'create');