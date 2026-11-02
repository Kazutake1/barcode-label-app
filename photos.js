'use strict';
// Product photos are stored locally in IndexedDB, not sent to a server.
window.BarcodePhotos=(()=>{
  const DB='barcode-label-product-photos-v1',TABLE='photos';
  let connecting=null;
  function valid(data){
    return typeof data==='string'&&data.length<=250000&&/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(data);
  }
  function open(){
    if(!('indexedDB' in window))return Promise.reject(Error('この端末では写真を保存できません。'));
    if(connecting)return connecting;
    connecting=new Promise((resolve,reject)=>{
      const req=indexedDB.open(DB,1);
      req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(TABLE))req.result.createObjectStore(TABLE);};
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error||Error('写真の保存領域を開けません。'));
      req.onblocked=()=>reject(Error('写真の保存領域を開けません。他の画面を閉じてください。'));
    }).catch(e=>{connecting=null;throw e;});
    return connecting;
  }
  async function transaction(id,mode,method,data){
    if(typeof id!=='string'||!id||id.length>150)throw Error('写真の商品番号が正しくありません。');
    const db=await open();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(TABLE,mode);
      const store=tx.objectStore(TABLE);
      const request=method==='get'?store.get(id):method==='put'?store.put(data,id):store.delete(id);
      let result;
      request.onsuccess=()=>{result=request.result;};
      tx.oncomplete=()=>resolve(method==='get'?result||null:undefined);
      tx.onerror=()=>reject(tx.error||Error('写真の保存に失敗しました。'));
      tx.onabort=()=>reject(tx.error||Error('写真の保存が中断されました。'));
    });
  }
  return Object.freeze({
    valid,
    get:id=>transaction(id,'readonly','get'),
    put:(id,data)=>valid(data)?transaction(id,'readwrite','put',data):Promise.reject(Error('写真の形式が正しくありません。')),
    remove:id=>transaction(id,'readwrite','delete')
  });
})();
