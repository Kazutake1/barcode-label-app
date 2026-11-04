import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto,createHash} from 'node:crypto';
import vm from 'node:vm';

const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
const sw=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
function segment(a,b){
 const first=app.indexOf(a),last=app.indexOf(b,first+a.length);
 assert.ok(first>=0&&last>first,a);
 return app.slice(first,last);
}
function compile(body,names,env={}){
 const params=Object.keys(env);
 return new Function(...params,body+'\nreturn {'+names+'};')(...params.map(p=>env[p]));
}
const table=segment('const L = ','const $ = ');
const barcodePart=segment('function normalizeCode(','function normalizeNameBreak(');
const doc={createElementNS(ns,tag){
 return {tag,attributes:{},children:[],setAttribute(k,v){this.attributes[k]=String(v);},
  append(...items){this.children.push(...items);},textContent:''};
}};
const barcode=compile(table+barcodePart,'checkDigit,codeInfo,barcodeBits,createBarcodeSvg,printBarcodeMagnification',{document:doc});
const backup=compile(
 'const MAX_FOLDER_NAME=30; const MAX_FOLDERS=50;'+
 "const BACKUP_FORMAT='barcode-label-app-backup'; const BACKUP_VERSION=1;"+
 segment('function normalizeNameBreak(','function createLabel(')+
 segment('function validateFolderName(','function readFolders(')+
 segment('function validateBackupDocument(raw){','function mergeBackup('),
 'validateBackupDocument',{codeInfo:barcode.codeInfo});
function backupSample(code){
 return {format:'barcode-label-app-backup',version:1,folders:[],
 savedProducts:[{id:'p1',code,name:'商品名',folderId:null,createdAt:null,updatedAt:null}],
 printList:[{id:'r1',code,name:'商品名',qty:1,selected:true}]};
}
test('200 canonical JAN-13, JAN-8, UPC-A patterns',()=>{
 for(let n=0;n<200;n++){
  const length=[13,8,12][n%3],body=Array.from({length:length-1},(_,i)=>String((7*n+3*i)%10)).join('');
  const code=body+barcode.checkDigit(body);
  assert.ok(barcode.codeInfo(code).ok);
  const bits=barcode.barcodeBits(code);
  assert.equal(bits.length,length===8?67:95);
  assert.ok(bits.startsWith('101')&&bits.endsWith('101'));
 }
});
test('printed barcode magnification is proportional and stays within 20/30mm labels',()=>{
  const code='4901234567894';
  for(const height of [5,10,15])assert.equal(barcode.printBarcodeMagnification(height,height<=10),1);
  for(const height of [20,25])assert.equal(barcode.printBarcodeMagnification(height,false),1.07);
  for(const height of [30,35,40,45,50])assert.equal(barcode.printBarcodeMagnification(height,false),12/11);
  const original=barcode.createBarcodeSvg(code,false,true);
  const medium=barcode.createBarcodeSvg(code,false,true,barcode.printBarcodeMagnification(20,false));
  const tall=barcode.createBarcodeSvg(code,false,false,barcode.printBarcodeMagnification(30,false));
  assert.equal(original.attributes.width,'37.29mm');
  assert.equal(original.attributes.height,'17.82mm');
  assert.equal(medium.attributes.width,'39.90mm');
  assert.equal(medium.attributes.height,'19.07mm');
  assert.equal(tall.attributes.width,'40.68mm');
  assert.equal(tall.attributes.height,'29.16mm');
  // B5's narrowest two-column label still contains the full quiet zones.
  const b5BarcodeCellMm=((182-14-3)/2)*.54-2*1.3;
  assert.ok(parseFloat(tall.attributes.width)<b5BarcodeCellMm);
  assert.ok(parseFloat(tall.attributes.height)+.8<30);
  assert.ok(parseFloat(medium.attributes.height)+.8<20);
  assert.equal(barcode.createBarcodeSvg(code).attributes.width,'37.29mm');
  assert.equal(barcode.createBarcodeSvg(code).attributes.height,'26.73mm');
  assert.equal(medium.attributes.viewBox,original.attributes.viewBox);
  assert.equal(medium.children[1].attributes.x,original.children[1].attributes.x);
  assert.ok(css.includes('height:var(--symbol-height,26.73mm)!important'));
  assert.ok(css.includes('height:var(--symbol-height,17.82mm)!important'));
  assert.ok(app.includes('printBarcodeMagnification(labelHeightMm,compact)'));
});
test('barcode SVG and legacy backup codes normalize Unicode digits, spaces, hyphens',()=>{
 const code='4901234567894',svg=barcode.createBarcodeSvg(code);
 for(const candidate of ['4901234 567894','4901234-567894','４９０１２３４５６７８９４']){
  const data=backup.validateBackupDocument(backupSample(candidate));
  assert.equal(data.products[0].code,code);
  assert.equal(data.printItems[0].code,code);
  assert.equal(JSON.stringify(barcode.createBarcodeSvg(candidate)),JSON.stringify(svg));
 }
});
test('bad checksums and duplicate canonical codes are blocked',()=>{
 assert.equal(barcode.codeInfo('4901234567890').ok,false);
 const data=backupSample('4901234567894');
 data.savedProducts.push({...data.savedProducts[0],code:'4901234-567894'});
 assert.throws(()=>backup.validateBackupDocument(data),/重複/);
});
test('old backup files with tag data stay compatible',()=>{
 const b=backupSample('4901234567894');b.savedProducts[0].tags=['飲料'];
 const result=backup.validateBackupDocument(b);
 assert.equal(result.products[0].name,'商品名');
 assert.ok(!Object.hasOwn(result.products[0],'tags'));
});
test('quota exceeded is reported as a failed save',()=>{
 const f=compile(segment('function saveRecords(){','function toast('),'saveRecords',{
  records:[],STORE_KEY:'test',toast:()=>{},persistState(){throw Error('quota');}
 });
 assert.equal(f.saveRecords(),false);
});
test('late camera initialization cannot reactivate after stop',async()=>{
 let finish,stops=0,decoding=false;
 const pending=new Promise(resolve=>{finish=resolve;});
 const elements={'#start-camera':{disabled:false},'#scanner':{hidden:true},
 '#camera-status':{textContent:''},'#camera':{srcObject:null}};
 const deps={$:id=>elements[id],loadDecoder:()=>Promise.resolve(),toast:()=>{},
  handleScanValue:()=>true,navigator:{mediaDevices:{getUserMedia(){}}},
  window:{ZXingBrowser:{BarcodeFormat:{EAN_13:7,EAN_8:6,UPC_A:14},BrowserMultiFormatReader:class{decodeFromConstraints(){decoding=true;return pending;}}}}};
 const cam=new Function('env',
 'const {$,loadDecoder,toast,handleScanValue,navigator,window}=env;'+
 'let scanControls=null,reader=null,scanSession=0;'+
 segment('async function startCamera(){',"$('#editor').addEventListener('submit'")+
 'return {startCamera,stopCamera,current:()=>scanControls};')(deps);
 const starting=cam.startCamera();
 for(let i=0;i<8&&!decoding;i++)await Promise.resolve();
 assert.equal(decoding,true);
 cam.stopCamera();
 finish({stop(){stops++;}});
 await starting;
 assert.equal(stops,1);
 assert.equal(cam.current(),null);
 assert.equal(elements['#start-camera'].disabled,false);
});
test('AES-GCM backup round-trip and incorrect password rejection',async()=>{
 const encryption=compile(segment('function toBase64(bytes){','async function exportBackup(){'),
 'encryptBackup,decryptBackup',{
  crypto:webcrypto,globalThis:{crypto:webcrypto},TextEncoder,TextDecoder,btoa,atob,
  BACKUP_FILE_LIMIT:2*1024*1024,BACKUP_KDF_ITERATIONS:250000,
  ENCRYPTED_BACKUP_FORMAT:'barcode-label-app-backup-encrypted'
 });
 const original=backupSample('4901234567894');
 const encrypted=await encryption.encryptBackup(original,'strong-password-123');
 assert.ok(!JSON.stringify(encrypted).includes('商品名'));
 assert.deepEqual(await encryption.decryptBackup(encrypted,'strong-password-123'),original);
 await assert.rejects(encryption.decryptBackup(encrypted,'wrong-password'),/パスワード/);
});
test('DOM IDs and JavaScript selectors are consistent',()=>{
 const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);
 assert.equal(ids.length,new Set(ids).size);
 for(const m of app.matchAll(/\$\('#([^']+)'\)/g)){
  if(!m[1].includes(' '))assert.ok(ids.includes(m[1]),'Missing ID '+m[1]);
 }
});
test('unsafe HTML sinks are absent and the decoder CSP is restricted',()=>{
 assert.ok(!/\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/.test(app));
 assert.ok(!/\beval\s*\(/.test(app));
 assert.ok(html.includes("script-src 'self' https://unpkg.com/@zxing/browser@0.2.1/umd/zxing-browser.min.js"));
 assert.ok(app.includes("script.referrerPolicy='no-referrer'"));
 assert.ok(app.includes("script.integrity='sha384-HRtzk9lZgkbSgvUyQrnfC/GxiXZgwaNyD7hC9wcXlsBpDhkS80ISl73juef2FRuf'"));
});
test('mobile printing dimensions and excess-space regression',()=>{
 assert.ok(css.includes('.print-toolbar .print-settings{flex:0 0 auto;width:100%}'));
 assert.ok(css.includes('.print-settings{display:grid;'));
 assert.ok(css.includes('.print-preview-settings{display:grid;'));
 assert.ok(css.includes('.paper-page.b5{width:182mm;height:257mm'));
});
test('large JSON is bounded and product barcodes are lazily drawn',()=>{
 assert.ok(app.includes('BACKUP_FILE_LIMIT = 2 * 1024 * 1024'));
 assert.ok(app.includes('catalogBarcodeObserver?.disconnect();target.replaceChildren();'));
 assert.ok(app.includes('if(catalogBarcodeObserver)catalogBarcodeObserver.observe(barcode)'));
});
test('service worker caches a complete verified release without forcing activation',()=>{
 assert.ok(sw.includes("CACHE_PREFIX+'v70'"));
 assert.ok(sw.includes("new URL(req.url).origin!==self.location.origin"));
 assert.ok(!/self\.(skipWaiting|clients\.claim)\(/.test(sw));
 assert.ok(sw.includes("crypto.subtle.digest('SHA-256'"));
});

const snapshotPart=segment('function readSnapshot(){','function readRecords(){');
const mergePart=segment('function mergeBackup(','async function restoreBackup(');
function storageHarness({initial=null,legacy={},fail=false}={}){
 const disk=new Map(Object.entries(legacy));
 if(initial!==null)disk.set('snapshot',typeof initial==='string'?initial:JSON.stringify(initial));
 let writes=0,broken=fail;
 const localStorage={getItem:k=>disk.get(k)??null,
  setItem(k,v){writes++;if(broken)throw Error('quota');disk.set(k,v);},
  removeItem(k){throw Error('unexpected delete '+k);}};
 const f=compile(`const DATA_KEY='snapshot',CATALOG_KEY='c',STORE_KEY='r',FOLDERS_KEY='f',MAX_FOLDERS=50;
 let storageReadError=false,storedSnapshot=readSnapshot();
 let catalog=storedSnapshot?.catalog??[],records=storedSnapshot?.records??[],folders=storedSnapshot?.folders??[];
 `+snapshotPart+mergePart,
 'persistState,readStoredData,mergeBackup,state:()=>({catalog,records,folders}),blocked:()=>storageReadError',
 {localStorage,cloneData:items=>items.map(x=>({...x})),makeId:()=>Math.random().toString(),
 renderCatalog:()=>{},renderRecords:()=>{}});
 return {...f,disk,writes:()=>writes,fail:value=>broken=value};
}
const samplePrint={code:'4901234567894',name:'商品',qty:1,selected:true,nameBreak:null};
test('products, print list and folders commit with exactly one write',()=>{
 const h=storageHarness({legacy:{c:'old-catalog',r:'old-records',f:'old-folders'}});
 const next={catalog:[{code:samplePrint.code}],records:[samplePrint],folders:[{id:'f1',name:'飲料'}]};
 h.persistState(next.catalog,next.records,next.folders);
 assert.equal(h.writes(),1);
 assert.deepEqual(JSON.parse(h.disk.get('snapshot')),{version:1,...next});
 assert.equal(h.disk.get('c'),'old-catalog');
 assert.equal(h.disk.get('r'),'old-records');
 assert.equal(h.disk.get('f'),'old-folders');
});
test('failed restore leaves the complete previous snapshot unchanged without rollback writes',()=>{
 const initial={version:1,catalog:[],records:[],folders:[]},h=storageHarness({initial,fail:true});
 assert.throws(()=>h.mergeBackup({folders:[{id:'f1',name:'飲料'}],
 products:[{code:samplePrint.code,name:'商品',folderId:'f1'}],printItems:[samplePrint]}),/保存/);
 assert.equal(h.writes(),1);
 assert.deepEqual(JSON.parse(h.disk.get('snapshot')),initial);
 assert.deepEqual(h.state(),{catalog:[],records:[],folders:[]});
});
test('one write restores all three collections and survives a fresh load',()=>{
 const h=storageHarness();
 h.mergeBackup({folders:[{id:'f1',name:'飲料'}],
 products:[{code:samplePrint.code,name:'商品',folderId:'f1'}],printItems:[samplePrint]});
 assert.equal(h.writes(),1);
 const reopened=storageHarness({initial:JSON.parse(h.disk.get('snapshot'))});
 assert.deepEqual(reopened.state(),h.state());
});
test('malformed snapshots cannot silently overwrite stored data',()=>{
 const h=storageHarness({initial:'{broken'});
 assert.equal(h.blocked(),true);
 assert.throws(()=>h.persistState(),/保存/);
 assert.equal(h.writes(),0);
 assert.equal(h.disk.get('snapshot'),'{broken');
});
test('restore updates print selection and manual line break without duplicating labels',()=>{
 const h=storageHarness({initial:{version:1,catalog:[],folders:[],
 records:[{id:'r1',...samplePrint,selected:false,nameBreak:null}]}});
 const result=h.mergeBackup({folders:[],products:[],printItems:[{...samplePrint,nameBreak:1}]});
 assert.equal(result.updatedPrint,1);assert.equal(result.print,0);
 assert.equal(h.state().records.length,1);
 assert.equal(h.state().records[0].selected,true);
 assert.equal(h.state().records[0].nameBreak,1);
 assert.equal(h.writes(),1);
});
test('unchanged backup does not write again',()=>{
 const h=storageHarness({initial:{version:1,catalog:[],folders:[],records:[samplePrint]}});
 const result=h.mergeBackup({folders:[],products:[],printItems:[samplePrint]});
 assert.equal(result.updatedPrint,0);assert.equal(h.writes(),0);
});
test('nominal bar height, quiet zones and complete human-readable digits',()=>{
 for(const code of ['4901234567894','12345670','036000291452']){
  const svg=barcode.createBarcodeSvg(code),view=svg.attributes.viewBox.split(' ').map(Number);
  assert.equal(svg.attributes.height,'26.73mm');
  const bars=svg.children.filter(x=>x.tag==='rect'&&x.attributes.fill==='#000000');
  assert.ok(Math.abs(Math.min(...bars.map(x=>Number(x.attributes.height)))*.33-22.85)<.00001);
  assert.ok(svg.children.some(x=>x.tag==='text'&&x.textContent===code));
  if(code.length===12){
   assert.equal(Math.min(...bars.map(x=>Number(x.attributes.x))),9);
   assert.equal(view[2]-Math.max(...bars.map(x=>Number(x.attributes.x)+Number(x.attributes.width))),9);
  }
 }
 const sizes=compile(segment('function validLabelHeight(','function readLabelHeight('),'validLabelHeight');
 for(const n of [5,10,15,20,25,30,35,40,45,50])assert.equal(sizes.validLabelHeight(n),true);
 for(const n of [0,6,55])assert.equal(sizes.validLabelHeight(n),false);
});
test('scan result format is enforced in addition to numeric validation',()=>{
 let updates=0,stops=0;
 const formats={EAN_13:7,EAN_8:6,UPC_A:14,QR_CODE:11,CODE_128:4};
 const elements={'#code':{value:''},'#name':{focus(){}}};
 const scan=compile(segment('function handleScanValue(','function loadDecoder(){'),
 'handleScanValue,isSupportedScanFormat',{
 window:{ZXingBrowser:{BarcodeFormat:formats}},codeInfo:barcode.codeInfo,
 $:id=>elements[id],toast:()=>{},updatePreview:()=>updates++,stopCamera:()=>stops++});
 for(const format of [formats.QR_CODE,formats.CODE_128,undefined]){
  assert.equal(scan.handleScanValue(samplePrint.code,format),false);
 }
 assert.equal(updates,0);assert.equal(stops,0);
 assert.equal(scan.handleScanValue(samplePrint.code,formats.EAN_13),true);
 assert.equal(elements['#code'].value,samplePrint.code);assert.equal(stops,1);
});

function workerHarness({badUrl=null,status=200}={}){
 const listeners={},cacheEntries=new Map(),requests=[],scope='https://example.test/barcode/';
 const contents=new Map([
  [new URL('./index.html',scope).href,Buffer.from(html)],
  [new URL('./app.js?v=70',scope).href,Buffer.from(app)],
  [new URL('./style.css?v=70',scope).href,Buffer.from(css)],
 ]);
 const manifest=JSON.parse(sw.match(/const CORE=(\[[\s\S]*?\]);/)[1]);
 const fallback=new Map();
 for(const entry of manifest)fallback.set(new URL(entry.url,scope).href,entry);
 const caches={open:async()=>({
  put:async(key,response)=>cacheEntries.set(String(key),response.clone()),
  match:async key=>cacheEntries.get(String(key))?.clone()
 }),keys:async()=>[],delete:async()=>true};
 const self={registration:{scope},location:{origin:new URL(scope).origin},
 addEventListener:(type,callback)=>listeners[type]=callback};
 const context={self,caches,crypto:webcrypto,URL,Request,Response,Uint8Array,
 fetch:async request=>{
  const url=typeof request==='string'?request:request.url;requests.push(url);
  const body=url===badUrl?Buffer.from('wrong release'):contents.get(url);
  if(!body)throw Error('fixture missing '+url);
  return new Response(body,{status});
 }};
 // Tests for installation use a reduced, genuinely hashed manifest.
 const testedManifest=manifest.filter(entry=>contents.has(new URL(entry.url,scope).href));
 const source=sw.replace(/const CORE=\[[\s\S]*?\];/,'const CORE='+JSON.stringify(testedManifest)+';');
 vm.runInNewContext(source,context);
 async function install(){let promise;listeners.install({waitUntil:p=>promise=p});await promise;}
 async function request(url,mode='navigate'){
  let promise;listeners.fetch({request:{method:'GET',url,mode},respondWith:p=>promise=p});
  return promise?await promise:null;
 }
 return {install,request,cacheEntries,requests,scope};
}
test('release installation rejects mismatched files before caching anything',async()=>{
 const h=workerHarness({badUrl:'https://example.test/barcode/app.js?v=70'});
 await assert.rejects(h.install(),/mismatch/);
 assert.equal(h.cacheEntries.size,0);
});
test('release installation rejects HTTP errors before caching anything',async()=>{
 const h=workerHarness({status:503});await assert.rejects(h.install(),/unavailable/);
 assert.equal(h.cacheEntries.size,0);
});
test('navigation and assets use the same cached release without network fetches',async()=>{
 const h=workerHarness();await h.install();const before=h.requests.length;
 const response=await h.request(h.scope);
 assert.equal(await response.text(),html);
 const asset=await h.request(h.scope+'app.js?v=70','no-cors');
 assert.equal(await asset.text(),app);
 assert.equal(h.requests.length,before);
 assert.equal(await h.request('https://unpkg.com/scanner.js','no-cors'),null);
});
test('SW manifest digests match the source files',()=>{
 const manifest=JSON.parse(sw.match(/const CORE=(\[[\s\S]*?\]);/)[1]);
 for(const [path,text] of [['index.html',html],['app.js?v=70',app],['style.css?v=70',css]]){
  const entry=manifest.find(x=>x.url==='./'+path);
  assert.equal(entry.sha256,createHash('sha256').update(text).digest('hex'));
 }
});

test('all ten label heights remain selectable in both print toolbars',()=>{
 for(const id of ['label-height','preview-label-height']){
  const select=html.match(new RegExp('<select id="'+id+'">([\\s\\S]*?)</select>'))[1];
  const values=[...select.matchAll(/value="(\d+)"/g)].map(x=>Number(x[1]));
  assert.deepEqual(values,[5,10,15,20,25,30,35,40,45,50]);
 }
 const compact=barcode.createBarcodeSvg('4901234567894',true,true);
 assert.equal(compact.attributes.preserveAspectRatio,'none');
 assert.ok(!compact.children.some(x=>x.tag==='text'));
 assert.equal(barcode.createBarcodeSvg('4901234567894',false,true).attributes.height,'17.82mm');
});

test('label layout defaults to horizontal and remembers only supported values',()=>{
 const source=segment('function validLabelLayout(','function setLabelLayout(');
 for(const [stored,expected] of [[null,'horizontal'],['vertical','vertical'],['horizontal','horizontal'],['unknown','horizontal']]){
  const f=compile(source,'readLabelLayout',{LABEL_LAYOUT_KEY:'layout',localStorage:{getItem:()=>stored}});
  assert.equal(f.readLabelLayout(),expected);
 }
 const unavailable=compile(source,'readLabelLayout',{LABEL_LAYOUT_KEY:'layout',localStorage:{getItem(){throw Error('blocked')}}});
 assert.equal(unavailable.readLabelLayout(),'horizontal');
});
test('layout selector appears next to height in both print toolbars',()=>{
 for(const id of ['label-layout','preview-label-layout']){
  assert.ok(html.includes('id="'+id+'"'));
 }
 assert.ok(app.includes("container.dataset.layout=labelLayout"));
 assert.ok(css.includes('grid-template-rows:minmax(0,22fr) minmax(0,78fr)'));
});

test('vertical three-column sheets increase capacity without changing horizontal paging',()=>{
 const {printPagination}=compile(segment('function printPagination(','function buildPrintSheets('),'printPagination');
 assert.deepEqual(printPagination('A4',20,'horizontal'),{columns:2,perPage:16});
 assert.deepEqual(printPagination('A4',20,'vertical'),{columns:3,perPage:24});
 assert.deepEqual(printPagination('B5',20,'horizontal'),{columns:2,perPage:14});
 assert.deepEqual(printPagination('B5',20,'vertical'),{columns:3,perPage:21});
 assert.deepEqual(printPagination('A4',5,'vertical'),{columns:3,perPage:105});
 assert.deepEqual(printPagination('B5',50,'vertical'),{columns:3,perPage:12});
});
