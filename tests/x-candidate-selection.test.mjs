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
    approved_hstora_product_ids:input.approved??[],
    trial_purchase_count:10,
    max_no_shadowban_unit_price_usd:0.35
  });
  return Response.json(await selectCandidate(env,10,input.target,input.budget));
}};`,resolveDir:process.cwd(),sourcefile:'candidate-fixture.ts'},bundle:true,write:false,format:'esm',platform:'browser'});

function product(id,price,{search=false,old=false,noShadow=true,...overrides}={}){
  const parts=['Twitter accounts'];
  if(noShadow) parts.push('No shadow bans');
  if(search) parts.push('Top Search');
  if(old) parts.push('2006-2025');
  const description=[
    noShadow?'No shadow bans':'',
    search?'Search Visible Top Search':'',
    old?'2006-2025':''
  ].filter(Boolean).join(' / ');
  return {
    id,price,
    name:parts.join(' '),
    slug:`twitter-${id}`,
    short_description:noShadow?'No shadow bans':'',
    description,
    currency:'USD',delivery_type:'instant',stock_available:100,
    product_url:`https://hstora.com/en/product/${id}`,
    updated_at:new Date().toISOString(),
    price_tiers:[],
    rules:{delivery_type:'instant',instant_delivery:true,delivery_data_exposed:true},
    ...overrides
  };
}

test('candidate selection enforces the new normal procurement policy',async t=>{
  let catalog=[];
  let details=new Map();
  const mf=new Miniflare({
    modules:true,
    script:bundle.outputFiles[0].text,
    compatibilityDate:'2026-08-06',
    compatibilityFlags:['nodejs_compat'],
    d1Databases:['DB'],
    bindings:{HSTORA_API_KEY:'fixture',HSTORA_API_SECRET:'fixture-secret'},
    outboundService:async request=>{
      assert.equal(request.method,'GET','selection must never purchase');
      const url=new URL(request.url);
      if(url.pathname==='/api/v1/catalog'){
        const page=Number(url.searchParams.get('page'));
        return Response.json({success:true,data:{
          items:catalog.slice((page-1)*20,page*20),
          pagination:{page,limit:20,total:catalog.length,pages:Math.max(1,Math.ceil(catalog.length/20))}
        }});
      }
      const id=Number(url.pathname.split('/').at(-1));
      const item=details.get(id);
      return item
        ?Response.json({success:true,data:item})
        :Response.json({success:false,error:{code:'NOT_FOUND',message:'fixture unavailable'}},{status:404});
    }
  });
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB');

  async function choose(items,input={},extra=[]){
    catalog=items;
    details=new Map([...items,...extra].map(item=>[item.id,item]));
    const response=await mf.dispatchFetch('https://fixture.example',{
      method:'POST',
      body:JSON.stringify({target:'NO_SHADOWBAN',...input})
    });
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  }

  async function clear(){
    await db.prepare('DELETE FROM supplier_products').run();
  }

  await t.test('① accepts any No Shadowban source under the ceiling',async()=>{
    const result=await choose([product(4841,0.27,{search:true,old:false})]);
    assert.equal(result.product.id,4841);
    assert.equal(result.q.procurement_class,'NO_SHADOWBAN');
    await clear();
  });

  await t.test('① does not require search visibility or old age',async()=>{
    const result=await choose([product(1609,0.21)]);
    assert.equal(result.product.id,1609);
    assert.equal(result.q.procurement_class,'NO_SHADOWBAN');
    await clear();
  });

  await t.test('② requires No Shadowban + search visibility + old evidence',async()=>{
    const result=await choose([
      product(7001,0.20,{search:true,old:false}),
      product(7002,0.22,{search:false,old:true}),
      product(7003,0.24,{search:true,old:true})
    ],{target:'TOP_SEARCH'});
    assert.equal(result.product.id,7003);
    assert.equal(result.q.procurement_class,'TOP_SEARCH');
    await clear();
  });

  await t.test('② rejects old searchable products without No Shadowban',async()=>{
    const result=await choose([
      product(7004,0.20,{search:true,old:true,noShadow:false})
    ],{target:'TOP_SEARCH'});
    assert.equal(result,null);
    await clear();
  });

  await t.test('5132 is excluded even if its fixture price drops to 20 cents',async()=>{
    const result=await choose([
      product(5132,0.20,{search:true,old:true}),
      product(7005,0.28,{search:true,old:true})
    ],{target:'TOP_SEARCH'});
    assert.equal(result.product.id,7005);
    await clear();
  });

  await t.test('anything above 35 cents is excluded from normal procurement',async()=>{
    const result=await choose([
      product(7006,0.36),
      product(7007,0.35)
    ]);
    assert.equal(result.product.id,7007);
    await clear();
  });

  await t.test('sub-30-cent sources beat 30-35-cent normal candidates',async()=>{
    const result=await choose([
      product(4521,0.31),
      product(7008,0.29)
    ]);
    assert.equal(result.product.id,7008);
    await clear();
  });

  await t.test('within the same price band the cheapest eligible source wins',async()=>{
    const result=await choose([
      product(1609,0.24),
      product(7009,0.22),
      product(7010,0.29)
    ]);
    assert.equal(result.product.id,7009);
    await clear();
  });

  await t.test('equal price still prefers selected No Shadowban sources',async()=>{
    const result=await choose([
      product(7011,0.21,{stock_available:1000}),
      product(1609,0.21)
    ]);
    assert.equal(result.product.id,1609);
    await clear();
  });

  await t.test('out-of-stock sources cannot win on price',async()=>{
    const result=await choose([
      product(1609,0.21),
      product(7012,0.01,{stock_available:0})
    ]);
    assert.equal(result.product.id,1609);
    await clear();
  });

  await t.test('manual approval mode still fails closed for unapproved generic sources',async()=>{
    const result=await choose([
      product(1609,0.21),
      product(7013,0.10)
    ],{mode:'manual_product_approval'});
    assert.equal(result.product.id,1609);
    await clear();
  });
});
