import test from 'node:test';
import assert from 'node:assert/strict';
import { panelPayload, type PanelProduct } from '../src/shiire-panel-payload.ts';
const machine={id:'fixture',name:'自販機',panel_title:null,panel_description:null,panel_image_url:null};
const product:PanelProduct={id:'p',name:'商品',description:'説明',emoji:'✨',price_paypay:150,price_kyash:200,stock_count:2,sales_count:3};
test('production panel payload preserves Discord embed, image omission and button contract',()=>{
 const payload=panelPayload(machine,[product]);
 assert.deepEqual(payload.embeds,[{title:'自販機',description:'購入したい商品を下のボタンから選択してください。\n\n✨ **商品**\n説明\n```\nPayPay: 150円 / Kyash: 200円 / 在庫: 2 / 販売: 3\n```',color:5763719}]);
 assert.deepEqual(payload.components[0].components.map(p=>[p.label,p.style,p.custom_id]),[['購入する',3,'svm:buy:fixture'],['在庫・販売数',1,'svm:stock:fixture']]);
 assert.deepEqual(panelPayload({...machine,panel_image_url:'https://example.com/image.png'},[]).embeds[0].image,{url:'https://example.com/image.png'});
});
test('description truncation matches previous Discord payload for every boundary',()=>{
 for(let length=3990;length<4100;length++){
  const description='x'.repeat(length),p={...product,description:'z'.repeat(500)};
  const expected=(description+'\n\n✨ **商品**\n'+p.description+'\n```\nPayPay: 150円 / Kyash: 200円 / 在庫: 2 / 販売: 3\n```').slice(0,4096);
  assert.equal(panelPayload({...machine,panel_description:description},[p]).embeds[0].description,expected);
 }
 assert.equal(panelPayload({...machine,panel_title:'x'.repeat(300)},[]).embeds[0].title.length,256);
});

test('custom RGB colors including black survive payload construction; legacy values keep green',()=>{
 for(const color of [0,0xff3366,0xffffff]) assert.equal(panelPayload({...machine,panel_color:color},[product]).embeds[0].color,color);
 for(const color of [null,-1,0x1000000,0.5,NaN]) assert.equal(panelPayload({...machine,panel_color:color},[]).embeds[0].color,5763719);
});
