export const DEFAULT_RESTOCK_MESSAGE=`{mention}

***在庫入荷のお知らせ***
本日の在庫を入荷しました！
*①Search Top + No shadow ban*
現在在庫 : {normal_stock}個（+{normal_added}個）

*②【Old】Top Search + No shadow ban*
現在在庫 : {old_stock}個（+{old_added}個）

🌙Paypay、Kyashでの購入が可能です！
/毎日18:00（JST）入荷`;

export type RestockMessageCounts={normal_stock:number;normal_added:number;old_stock:number;old_added:number};

export function normalizeRestockMessage(message:string){
  return message.trim()==="本日の在庫を入荷しました！"?DEFAULT_RESTOCK_MESSAGE:message;
}

export function isRestockMention(value:string){
  return value===""||value==="everyone"||/^\d{15,22}$/.test(value);
}

export function renderRestockMessage(template:string,counts:RestockMessageCounts,mention="everyone"){
  const target=mention==="everyone"?"@everyone":/^\d{15,22}$/.test(mention)?"<@&"+mention+">":"";
  template=template.replace(/@everyone|\{mention\}/g,()=>target);
  return template.replace(/\{(normal_stock|normal_added|old_stock|old_added)\}/g,(_,key:keyof RestockMessageCounts)=>{
    const value=counts[key];
    return String(Number.isSafeInteger(value)&&value>=0?value:0);
  });
}

export function validateRestockMessage(template:string){
  const max=Number.MAX_SAFE_INTEGER;
  return Boolean(template.trim())&&template.length<=2000&&renderRestockMessage(template,{normal_stock:max,normal_added:max,old_stock:max,old_added:max},"9".repeat(22)).length<=2000;
}

export function restockMessagePayload(template:string,counts:RestockMessageCounts,notify=false,mention="everyone"){
  const content=renderRestockMessage(template,counts,mention);
  if(!content.trim()||content.length>2000) throw new Error("NOTIFICATION_MESSAGE_INVALID");
  const allowed_mentions=notify&&mention==="everyone"?{parse:["everyone"]}:notify&&/^\d{15,22}$/.test(mention)?{roles:[mention]}:{parse:[]};
  return {content,embeds:[],allowed_mentions};
}
