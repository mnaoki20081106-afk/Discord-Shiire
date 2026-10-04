import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

const bundle=await build({stdin:{contents:`
import {selectCandidate} from './src/x-engine';
import {saveXSettings} from './src/x-settings';
export default {async fetch(request,env){
  const input=await request.json();
  await saveXSettings(env,{
    usd_jpy_rate:150,usd_jpy_rate_updated_at:Date.now(),
    seller_quality_mode:input.mode??'trial_only',
    approved_hstora_product_ids:[],trial_purchase_count:10
  });
  return Response.json(await selectCandidate(env,10,input.target,input.budget));
}};`,resolveDir:process.cwd(),sourcefile:'candidate-fixture.ts'},bundle:true,write:false,format:'esm',platform:'browser'});

function product(id,price,{top=false,...overrides}={}){
  return {id,price,name:`Twitter accounts No shadow bans${top?' Top Search':''}`,
    slug:`twitter-${id}`,short_description:'No shadow bans',description:top?'Top Search No shadow bans':'No shadow bans',
    currency:'USD',delivery_type:'instant',stock_available:100,
    product_url:`https://hstora.com/en/product/${id}`,updated_at:new Date().toISOString(),
    price_tiers:[],rules:{delivery_type:'instant',instant_delivery:true,delivery_data_exposed:true},...overrides};
}

test('candidate selection compares live eligible prices and preserves source classes',async t=>{
  let catalog=[];
  let details=new Map();
  let catalogRequests=0;
  const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,
    compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_compat'],
    d1Databases:['DB'],bindings:{HSTORA_API_KEY:'fixture',HSTORA_API_SECRET:'fixture-secret'},
    outboundService:async request=>{
      assert.equal(request.method,'GET','selection must never purchase');
      const url=new URL(request.url);
      if(url.pathname==='/api/v1/catalog'){
        catalogRequests++;
        const page=Number(url.searchParams.get('page'));
        return Response.json({success:true,data:{items:catalog.slice((page-1)*2,page*2),
          pagination:{page,limit:2,total:catalog.length,pages:Math.max(1,Math.ceil(catalog.length/2))}}});
      }
      const id=Number(url.pathname.split('/').at(-1));
      const item=details.get(id);
      return item?Response.json({success:true,data:item}):
        Response.json({success:false,error:{code:'NOT_FOUND',message:'fixture unavailable'}},{status:404});
    }});
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB');
  async function choose(items,input={},extra=[]){
    catalog=items;details=new Map([...items,...extra].map(item=>[item.id,item]));
    const response=await mf.dispatchFetch('https://fixture.example',{method:'POST',
      body:JSON.stringify({target:'NO_SHADOWBAN',...input})});
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  }
  async function clear(){await db.prepare('DELETE FROM supplier_products').run();}

  await t.test('1609 qualifies from plural wording and is No Shadowban only',async()=>{
    const result=await choose([product(1609,0.21,{top:true})]);
    assert.equal(result.product.id,1609);
    assert.equal(result.q.procurement_class,'NO_SHADOWBAN');
    assert.equal(result.plannedQuantity,10);
    assert.equal(await choose([product(1609,0.21,{top:true})],{target:'TOP_SEARCH'}),null);
    await clear();
  });
  await t.test('cheaper alternative beats preferred source across catalog pages',async()=>{
    const before=catalogRequests;
    const result=await choose([product(4521,0.23),product(1609,0.21),product(9999,0.19)]);
    assert.equal(result.product.id,9999);
    assert.equal(catalogRequests-before,2);
    await clear();
  });
  await t.test('equal price prefers selected source despite higher alternative stock',async()=>{
    const result=await choose([product(9999,0.21,{stock_available:1000}),product(1609,0.21)]);
    assert.equal(result.product.id,1609);
    await clear();
  });
  await t.test('small price changes switch the winning source on the next scan',async()=>{
    assert.equal((await choose([product(1609,0.21),product(9999,0.22)])).product.id,1609);
    assert.equal((await choose([product(1609,0.24),product(9999,0.22)])).product.id,9999);
    await clear();
  });
  await t.test('preferred source absent from catalog is still considered',async()=>{
    const result=await choose([product(9999,0.22)],{},[product(1609,0.21)]);
    assert.equal(result.product.id,1609);
    await clear();
  });
  await t.test('TOP alternatives require both capabilities',async()=>{
    const result=await choose([product(4841,0.30,{top:true}),product(8888,0.20,{top:true}),
      product(9999,0.10,{top:true,name:'Twitter Top Search',short_description:'',description:'Top Search'})],{target:'TOP_SEARCH'});
    assert.equal(result.product.id,8888);
    await clear();
  });
  await t.test('full detail must retain No Shadowban evidence for a generic TOP source',async()=>{
    const result=await choose([product(4841,0.30,{top:true}),product(8888,0.20,{top:true})],
      {target:'TOP_SEARCH'},[product(8888,0.20,{top:true,name:'Twitter Top Search',short_description:'',description:'Top Search'})]);
    assert.equal(result.product.id,4841);
    await clear();
  });
  await t.test('budget reduction removes unreachable volume discount before ranking',async()=>{
    const result=await choose([product(1609,0.30,{price_tiers:[{min_quantity:10,unit_price:0.20}]}),product(9999,0.25)],
      {budget:{NO_SHADOWBAN:1,TOP_SEARCH:0,INVITE_CAMPAIGN:0}});
    assert.equal(result.product.id,9999);
    assert.equal(result.q.unit_price_source,0.25);
    assert.equal(result.plannedQuantity,4);
    await clear();
  });
  await t.test('reachable volume discounts can beat the cheaper base price',async()=>{
    const result=await choose([product(1609,0.30,{price_tiers:[{min_quantity:10,unit_price:0.20}]}),product(9999,0.25)]);
    assert.equal(result.product.id,1609);
    assert.equal(result.q.unit_price_source,0.20);
    await clear();
  });
  await t.test('invite campaign selection also ranks price before preferred source',async()=>{
    const result=await choose([product(1609,0.21),product(9999,0.19)],
      {target:'INVITE_CAMPAIGN',budget:{NO_SHADOWBAN:0,TOP_SEARCH:0,INVITE_CAMPAIGN:1}});
    assert.equal(result.product.id,9999);
    await clear();
  });
  await t.test('volatile source is excluded without blocking stable alternatives',async()=>{
    await choose([product(1609,0.21)]);
    const result=await choose([product(1609,0.35),product(9999,0.22)]);
    assert.equal(result.product.id,9999);
    const open=await db.prepare("SELECT COUNT(*) AS n FROM circuit_breakers WHERE state='OPEN'").first();
    assert.equal(open.n,0);
    await clear();
  });
  await t.test('out of stock and over-ceiling sources cannot win on price',async()=>{
    const result=await choose([product(1609,0.21),product(9999,0.01,{stock_available:0}),product(8888,0.70)]);
    assert.equal(result.product.id,1609);
    await clear();
  });
  await t.test('manual approval still excludes unapproved alternatives',async()=>{
    const result=await choose([product(1609,0.21),product(9999,0.10)],{mode:'manual_product_approval'});
    assert.equal(result.product.id,1609);
    await clear();
  });
});
