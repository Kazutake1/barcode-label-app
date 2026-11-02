import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';

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
const barcode=compile(table+barcodePart,'checkDigit,codeInfo,barcodeBits,createBarcodeSvg',{document:doc});
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
  records:[],STORE_KEY:'test',toast:()=>{},localStorage:{setItem(){throw Error('quota');}}
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
  window:{ZXingBrowser:{BrowserMultiFormatReader:class{decodeFromConstraints(){decoding=true;return pending;}}}}};
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
test('service worker stays on first-party resources',()=>{
 assert.ok(sw.includes('barcode-label-local-v63'));
 assert.ok(sw.includes('origin!==self.location.origin'));
 assert.ok(sw.includes('if(req.method!=="GET")return'));
});
