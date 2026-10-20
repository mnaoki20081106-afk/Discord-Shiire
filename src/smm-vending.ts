import type { Env } from "./types";
import { getMainPaymentStatus } from "./main-bot";
import { luckyPanelConfigured, type LuckyService } from "./smm-luckypanel";
import {
  attachSmmPaymentLink,
  countOpenSmmOrders,
  createSmmOrder,
  ensureSmmSchema,
  getSmmMachine,
  getSmmOrder,
  getSmmProduct,
  getSmmSettings,
  listSmmOrders,
  listSmmProducts,
  type SmmOrder,
  type SmmProduct
} from "./smm-db";
import {
  SMM_LINK_LABEL,
  SmmError,
  smmEphemeral,
  smmOrderLines,
  smmStatusLabel,
  yen,
  productPer1000
} from "./smm-discord";
import {
  processSmmPayment,
  smmServicesMap,
  smmSupplierReadiness
} from "./smm-orders";
import {
  isSupportedSmmServiceType,
  normalizeSmmLink,
  parseSmmQuantity,
  smmCost,
  smmQuantityBounds,
  smmQuote,
  smmQuoteIsProfitable
} from "./smm-policy";

const MAX_STALE_PRICE_AGE_MS=60*60_000;

function interactionResponse(payload:unknown){
  return new Response(JSON.stringify(payload),{
    headers:{"Content-Type":"application/json; charset=utf-8"}
  });
}

function deferred(){
  return interactionResponse({type:5,data:{flags:64}});
}

function userId(interaction:any){
  return String(interaction?.member?.user?.id??interaction?.user?.id??"");
}

async function editOriginal(
  interaction:any,
  body:{content?:string;components?:unknown[];embeds?:unknown[]}
){
  const applicationId=String(interaction.application_id??"");
  const token=String(interaction.token??"");
  if(!applicationId||!token) return;
  const response=await fetch(
    "https://discord.com/api/v10/webhooks/"+
      encodeURIComponent(applicationId)+"/"+encodeURIComponent(token)+
      "/messages/@original",
    {
      method:"PATCH",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        content:(body.content??"").slice(0,2000),
        components:body.components??[],
        embeds:body.embeds??[]
      })
    }
  );
  if(!response.ok){
    console.error("smm interaction edit failed",response.status,(await response.text()).slice(0,300));
  }
}

function fieldValue(interaction:any,id:string){
  const fields=interaction.data?.components?.flatMap((row:any)=>row.components??[])??[];
  return String(fields.find((field:any)=>field.custom_id===id)?.value??"");
}

function describeOption(product:SmmProduct,service:LuckyService|undefined){
  if(!service||!Number.isFinite(service.rate)) return "価格確認中";
  const bounds=smmQuantityBounds(service,product);
  return (
    "1000件 "+productPer1000(product,service.rate)+" / "+
    bounds.min.toLocaleString("ja-JP")+"〜"+bounds.max.toLocaleString("ja-JP")
  ).slice(0,100);
}

/* ---------------- order creation ---------------- */

async function createOrderFromInput(
  env:Env,
  interaction:any,
  productId:string
):Promise<{order:SmmOrder;product:SmmProduct}>{
  await ensureSmmSchema(env);
  const product=await getSmmProduct(env,productId);
  if(!product||!product.active) throw new SmmError(404,"この商品は現在購入できません。");
  if(String(interaction.guild_id??"")!==product.guild_id){
    throw new SmmError(400,"このサーバーの商品ではありません。");
  }
  const settings=await getSmmSettings(env,product.guild_id);
  if(settings.paused) throw new SmmError(409,"現在、注文の受付を停止しています。");
  if(!luckyPanelConfigured(env)) throw new SmmError(503,"現在、注文を受け付けられません。(運営設定未完了)");

  const payment=await getMainPaymentStatus(env).catch(()=>({paypay:false,kyash:false}));
  if(!payment.paypay) throw new SmmError(503,"PayPay決済が現在利用できません。");

  const link=normalizeSmmLink(product.link_kind,fieldValue(interaction,"link"));
  if(!link){
    throw new SmmError(400,
      "URLの形式が正しくありません。"+SMM_LINK_LABEL[product.link_kind].placeholder+" の形式で入力してください。"
    );
  }

  let services:Awaited<ReturnType<typeof smmServicesMap>>;
  try{
    services=await smmServicesMap(env);
  }catch{
    throw new SmmError(503,"現在、価格を確認できません。しばらくしてからお試しください。");
  }
  if(services.stale&&Date.now()-services.cachedAt>MAX_STALE_PRICE_AGE_MS){
    throw new SmmError(503,"現在、価格を確認できません。しばらくしてからお試しください。");
  }
  const service=services.map.get(product.service_id);
  if(!service||!isSupportedSmmServiceType(service.type)||!Number.isFinite(service.rate)){
    throw new SmmError(409,"この商品は現在販売停止中です。");
  }

  const bounds=smmQuantityBounds(service,product);
  const quantity=parseSmmQuantity(fieldValue(interaction,"quantity"),bounds);
  if(quantity===null){
    throw new SmmError(400,
      "数量が不正です。"+bounds.min.toLocaleString("ja-JP")+"〜"+bounds.max.toLocaleString("ja-JP")+" の整数で入力してください。"
    );
  }

  const buyer=userId(interaction);
  if(!buyer) throw new SmmError(400,"購入者を特定できません。");
  if(await countOpenSmmOrders(env,product.guild_id,buyer)>=settings.max_open_orders_per_user){
    throw new SmmError(429,"進行中の注文が上限に達しています。完了後にもう一度お試しください。");
  }

  const total=smmQuote(service.rate,quantity,product);
  if(!smmQuoteIsProfitable(total,service.rate,quantity,settings.min_margin_percent)){
    console.error("smm quote below margin floor",product.id,total,service.rate,quantity);
    throw new SmmError(409,"この商品は現在販売停止中です。");
  }

  let balance:{balance:number;currency:string};
  try{
    balance=await smmSupplierReadiness(env);
  }catch{
    throw new SmmError(503,"現在、注文を受け付けられません。しばらくしてからお試しください。");
  }
  if(balance.balance<smmCost(service.rate,quantity)+settings.min_supplier_balance_jpy){
    throw new SmmError(503,"現在この数量の受付枠が不足しています。数量を減らすか、時間をおいてお試しください。");
  }

  const order=await createSmmOrder(env,{
    guildId:product.guild_id,
    userId:buyer,
    product,
    link,
    quantity,
    rateSnapshot:service.rate,
    total
  });
  return {order,product};
}

function payButton(order:SmmOrder){
  return [{type:1,components:[{
    type:2,
    style:3,
    label:"送金リンクを入力",
    custom_id:"smm:pay:"+order.id
  }]}];
}

/* ---------------- interaction entry ---------------- */

export async function handleSmmInteraction(
  interaction:any,
  env:Env,
  ctx:ExecutionContext
):Promise<Response|null>{
  const id=String(interaction.data?.custom_id??"");
  if(!id.startsWith("smm:")) return null;
  await ensureSmmSchema(env);

  if(interaction.type===3){
    if(id.startsWith("smm:buy:")){
      const machine=await getSmmMachine(env,id.slice(8));
      if(!machine||String(interaction.guild_id??"")!==machine.guild_id){
        return interactionResponse(smmEphemeral("この自販機は利用できません。"));
      }
      const settings=await getSmmSettings(env,machine.guild_id);
      if(settings.paused){
        return interactionResponse(smmEphemeral("現在、注文の受付を停止しています。"));
      }
      const products=await listSmmProducts(env,machine.guild_id,{machineId:machine.id,activeOnly:true});
      if(!products.length){
        return interactionResponse(smmEphemeral("現在購入できる商品がありません。"));
      }
      let serviceMap=new Map<string,LuckyService>();
      try{serviceMap=(await smmServicesMap(env,{maxAgeMs:Number.MAX_SAFE_INTEGER})).map;}catch{}
      return interactionResponse(smmEphemeral(
        "購入する商品を選択してください。",
        [{type:1,components:[{
          type:3,
          custom_id:"smm:pick:"+machine.id,
          placeholder:"商品を選択",
          options:products.slice(0,25).map(product=>({
            label:product.name.slice(0,100),
            value:product.id,
            description:describeOption(product,serviceMap.get(product.service_id)),
            ...(product.emoji?{emoji:{name:product.emoji}}:{})
          }))
        }]}]
      ));
    }

    if(id.startsWith("smm:pick:")){
      const product=await getSmmProduct(env,String(interaction.data?.values?.[0]??""));
      if(!product||!product.active||product.machine_id!==id.slice(9)){
        return interactionResponse(smmEphemeral("この商品は現在購入できません。"));
      }
      const meta=SMM_LINK_LABEL[product.link_kind];
      return interactionResponse({
        type:9,
        data:{
          custom_id:"smm:order:"+product.id,
          title:product.name.slice(0,45),
          components:[
            {type:1,components:[{
              type:4,custom_id:"link",label:meta.label,style:1,
              required:true,max_length:300,placeholder:meta.placeholder
            }]},
            {type:1,components:[{
              type:4,custom_id:"quantity",label:"数量",style:1,
              required:true,max_length:9,placeholder:"例: 1000"
            }]}
          ]
        }
      });
    }

    if(id.startsWith("smm:status:")){
      const machine=await getSmmMachine(env,id.slice(11));
      if(!machine||String(interaction.guild_id??"")!==machine.guild_id){
        return interactionResponse(smmEphemeral("この自販機は利用できません。"));
      }
      const orders=await listSmmOrders(env,machine.guild_id,{userId:userId(interaction),limit:5});
      if(!orders.length) return interactionResponse(smmEphemeral("注文履歴はまだありません。"));
      return interactionResponse(smmEphemeral("",undefined,[{
        title:"あなたの直近の注文",
        color:5793266,
        fields:orders.map(order=>({
          name:smmStatusLabel(order.status)+" / "+order.product_name,
          value:"```\n"+smmOrderLines(order)+
            (order.status==="placed"&&order.remains!==null?"\n残り: "+order.remains:"")+
            (order.refund_state==="required"?"\n返金予定: "+yen(order.refund_amount):"")+
            "\n```",
          inline:false
        }))
      }]));
    }

    if(id.startsWith("smm:pay:")){
      const order=await getSmmOrder(env,id.slice(8));
      if(!order||order.user_id!==userId(interaction)||order.status!=="awaiting_payment"){
        return interactionResponse(smmEphemeral("支払い可能な注文が見つかりません。"));
      }
      return interactionResponse({
        type:9,
        data:{
          custom_id:"smm:paymodal:"+order.id,
          title:"PayPay決済",
          components:[{type:1,components:[{
            type:4,custom_id:"link",label:"送金リンク",style:1,
            required:true,max_length:1000,placeholder:"https://pay.paypay.ne.jp/..."
          }]}]
        }
      });
    }
    return null;
  }

  if(interaction.type===5){
    if(id.startsWith("smm:order:")){
      const productId=id.slice(10);
      ctx.waitUntil((async()=>{
        try{
          const {order,product}=await createOrderFromInput(env,interaction,productId);
          await editOriginal(interaction,{
            content:
              "**"+product.name+"** × "+order.quantity.toLocaleString("ja-JP")+
              "\n対象: "+order.link+
              "\n支払額: **"+yen(order.total_amount)+"**(PayPayマネーのみ)"+
              "\n10分以内に送金リンクを入力してください。PayPayマネーライトを含むリンクは受け取れません。",
            components:payButton(order)
          });
        }catch(error){
          const message=error instanceof SmmError
            ?error.message
            :"注文を作成できませんでした。しばらくしてからお試しください。";
          if(!(error instanceof SmmError)) console.error("smm order create failed",error);
          await editOriginal(interaction,{content:message});
        }
      })());
      return deferred();
    }

    if(id.startsWith("smm:paymodal:")){
      const orderId=id.slice(13);
      ctx.waitUntil((async()=>{
        try{
          const order=await getSmmOrder(env,orderId);
          if(!order||order.user_id!==userId(interaction)||order.status!=="awaiting_payment"){
            await editOriginal(interaction,{content:"注文が失効しています。"});
            return;
          }
          const link=fieldValue(interaction,"link").trim();
          if(!link||link.length>1000){
            await editOriginal(interaction,{content:"送金リンクが不正です。",components:payButton(order)});
            return;
          }
          await attachSmmPaymentLink(env,order.id,link);
          let outcome:Awaited<ReturnType<typeof processSmmPayment>>;
          try{
            outcome=await processSmmPayment(env,order,link);
          }catch(error){
            console.error("smm payment processing failed",order.id,error);
            await editOriginal(interaction,{
              content:"決済を確認中です。1分ごとに自動で再確認します。完了するとDMでお知らせします。"
            });
            return;
          }
          if(outcome.status==="pending"){
            await editOriginal(interaction,{content:"決済受取が保留されています。1分ごとに自動確認します。"});
          }else if(outcome.status==="rejected"){
            await editOriginal(interaction,{
              content:
                outcome.reason==="PAYPAY_MONEY_LIGHT_NOT_ALLOWED"
                  ?"PayPayマネーライトを含む送金リンクは利用できません。PayPayマネーのみのリンクを入力してください。"
                  :outcome.reason==="PAYPAY_BALANCE_TYPE_UNKNOWN"
                    ?"PayPay残高の種類を確認できないため受け取りませんでした。PayPayマネーのみのリンクを入力してください。"
                    :"決済を確認できませんでした。別の有効な送金リンクを入力してください。",
              components:payButton((await getSmmOrder(env,order.id))??order)
            });
          }else{
            await editOriginal(interaction,{
              content:
                outcome.placed==="placed"
                  ?"入金を確認し、発注しました。完了するとDMでお知らせします。"
                  :outcome.placed==="failed"
                    ?"入金を確認しましたが発注できませんでした。運営が返金対応します。"
                    :"入金を確認しました。発注処理中です。結果はDMでお知らせします。"
            });
          }
        }catch(error){
          console.error("smm paymodal failed",orderId,error);
          await editOriginal(interaction,{
            content:"処理中にエラーが発生しました。「注文状況」で状態を確認してください。"
          });
        }
      })());
      return deferred();
    }
  }
  return null;
}
