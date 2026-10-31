'use strict';
// JAN/EAN printing is generated locally. Scanning loads a pinned ZXing decoder only when requested.
const STORE_KEY = 'barcode-label-local-v1';
const SCAN_LIBRARY_URL = 'https://unpkg.com/@zxing/browser@0.2.1/umd/zxing-browser.min.js';
const L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const R = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
const PARITY = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];
const $ = selector => document.querySelector(selector);
let records = readRecords();
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
  const svg=svgElem('svg',{xmlns:'http://www.w3.org/2000/svg',viewBox:`0 0 ${modules} 79`,width:`${(modules*.33).toFixed(2)}mm`,height:'25.93mm',role:'img','aria-label':`バーコード ${code}`});
  svg.append(svgElem('rect',{x:0,y:0,width:modules,height:79,fill:'#ffffff'}));
  let i=0;
  while(i<bits.length){
    if(bits[i]==='0'){i++;continue;}
    const start=i;
    while(i<bits.length && bits[i]==='1')i++;
    const guard=(start<3)||(start>=bits.length-3)||(start>=((bits.length-5)/2)&&start<((bits.length+5)/2));
    svg.append(svgElem('rect',{x:qleft+start,y:0,width:i-start,height:guard?70:66,fill:'#000000'}));
  }
  const text=svgElem('text',{x:modules/2,y:77.1,'text-anchor':'middle','font-size':'8.3','font-family':'Arial, sans-serif','font-weight':'500',fill:'#000000','letter-spacing':'.45'});
  text.textContent=code;
  svg.append(text);
  return svg;
}
function createLabel({code,name}){
  const container=document.createElement('div');container.className='product-label';
  const head=document.createElement('div');head.className='label-head';
  const headName=document.createElement('div');headName.textContent='商品名';
  const headCode=document.createElement('div');headCode.textContent='バーコード';
  head.append(headName,headCode);

  const body=document.createElement('div');body.className='label-body';
  const nameCell=document.createElement('div');nameCell.className='name-cell';nameCell.textContent=name||'商品名';
  const barcodeCell=document.createElement('div');barcodeCell.className='barcode-cell';
  barcodeCell.append(createBarcodeSvg(code));
  body.append(nameCell,barcodeCell);

  container.append(head,body);
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
  return {code:info.code,name,qty};
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
  editingId=null;HTMLFormElement.prototype.reset.call($('#editor'));$('#qty').value='1';$('#save').textContent='リストに追加';updatePreview();
}
function renderRecords(){
  $('#item-count').textContent=records.length+'件';
  const target=$('#items');target.replaceChildren();
  if(!records.length){const empty=document.createElement('div');empty.className='empty-list';empty.textContent='保存した商品がここに並びます。';target.append(empty);}
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
    edit.addEventListener('click',()=>{editingId=rec.id;$('#code').value=rec.code;$('#name').value=rec.name;$('#qty').value=rec.qty;$('#save').textContent='変更を保存';updatePreview();window.scrollTo({top:0,behavior:'smooth'});});
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
  $('#close-print-preview').focus();
}
function buildPrintSheets(){
  const paper=$('#paper').value;
  const isB5=paper==='B5';
  const flat=[];
  for(const item of stagedPrintItems)for(let i=0;i<item.qty;i++)flat.push(item);
  const target=$('#print-sheet');target.replaceChildren();
  target.className='print-sheet'+(isB5?' b5':'');
  for(const item of flat)target.append(createLabel(item));
  const pages=$('#print-preview-pages');pages.replaceChildren();
  const perPage=10;
  for(let offset=0;offset<flat.length;offset+=perPage){
    const page=document.createElement('div');page.className='print-preview-page'+(isB5?' b5':'');
    const grid=document.createElement('div');grid.className='print-preview-grid';
    for(const item of flat.slice(offset,offset+perPage))grid.append(createLabel(item));
    page.append(grid);pages.append(page);
  }
  $('#preview-paper').value=paper;
  $('#print-preview-meta').textContent=`${paper}・縦向き・2列 / ${flat.length}枚・${Math.ceil(flat.length/perPage)}ページ`;
  const standalone=window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone===true;
  $('#print-guidance').textContent=standalone
    ? 'ホーム画面のアプリから印刷画面が開かない場合は、SafariでこのサイトのURLを直接開いて印刷してください。'
    : '次の「印刷画面を開く」を押すと、Safariの印刷設定が表示されます。用紙サイズも印刷設定で同じサイズにしてください。';
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
    if(editingId){
      const existing=records.find(x=>x.id===editingId);if(!existing)throw Error('編集対象が見つかりません。');
      Object.assign(existing,data);toast('変更を保存しました。');
    }else{
      if(records.length>=200)throw Error('保存できるのは200商品までです。');
      records.unshift({id:String(Date.now())+'-'+Math.random().toString(36).slice(2),...data,selected:true});
      toast(`${data.name}を印刷リストに追加しました。`);
    }
    saveRecords();renderRecords();clearForm();
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
$('#preview-paper').addEventListener('change',e=>{$('#paper').value=e.target.value;$('#sheet-hint').textContent=e.target.value+'：2列';buildPrintSheets();});
$('#print-preview-overlay').addEventListener('click',e=>{if(e.target.id==='print-preview-overlay')closePrintPreview();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#print-preview-overlay').hidden)closePrintPreview();});
$('#paper').addEventListener('change',()=>{$('#sheet-hint').textContent=$('#paper').value+'：2列';});
$('#clear-all').addEventListener('click',()=>{
  if(!records.length)return;
  if(window.confirm(`保存された${records.length}件の商品をすべて削除しますか？`)){
    records=[];saveRecords();renderRecords();clearForm();toast('印刷リストを削除しました。');
  }
});
$('#start-camera').addEventListener('click',startCamera);
$('#stop-camera').addEventListener('click',stopCamera);
$('#photo-input').addEventListener('change',e=>scanPhoto(e.target.files?.[0]));
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopCamera();});
window.addEventListener('pagehide',stopCamera);
if('serviceWorker' in navigator && (location.protocol==='https:' || location.hostname==='localhost'))navigator.serviceWorker.register('./sw.js').catch(()=>{});
renderRecords();updatePreview();