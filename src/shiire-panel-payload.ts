// Keep this pure payload contract identical in Discord-Shiire and Xaccount-Bot.
export type PanelMachine={id:string;name:string;panel_title:string|null;panel_description:string|null;panel_image_url:string|null};
export type PanelProduct={id:string;name:string;description:string;emoji:string|null;price_paypay:number;price_kyash:number;stock_count:number;sales_count:number};
export function panelSections(machine:PanelMachine,products:PanelProduct[]){
  const sections=[{id:"description",text:machine.panel_description||"購入したい商品を下のボタンから選択してください。"},
    ...products.map(product=>({id:product.id,text:(product.emoji?product.emoji+" ":"")+"**"+product.name+"**\n"+
      (product.description?product.description+"\n":"")+"PayPay: "+product.price_paypay+"円 / Kyash: "+product.price_kyash+"円 / 在庫: "+product.stock_count+" / 販売: "+product.sales_count}))];
  if(!products.length) sections.push({id:"empty",text:"現在販売中の商品はありません。"});
  let remaining=4096;
  return sections.map((section,index)=>{
    const text=((index?"\n\n":"")+section.text).slice(0,remaining);
    remaining-=text.length;
    return {...section,text};
  }).filter(section=>section.text.length>0);
}

export function machineEmbed(machine:PanelMachine,products:PanelProduct[]){
  const description=panelSections(machine,products).map(section=>section.text).join("");
  return {
    title:(machine.panel_title||machine.name||"仕入れBOT自販機").slice(0,256),
    description,
    color:5763719,
    ...(machine.panel_image_url?{image:{url:machine.panel_image_url}}:{})
  };
}

export function panelPayload(
  machine:PanelMachine,
  products:PanelProduct[]
){
  return {
    embeds:[machineEmbed(machine,products)],
    components:[{
      type:1,
      components:[
        {
          type:2,
          style:3,
          label:"購入する",
          emoji:{name:"🛒"},
          custom_id:"svm:buy:"+machine.id
        },
        {
          type:2,
          style:1,
          label:"在庫・販売数",
          emoji:{name:"📦"},
          custom_id:"svm:stock:"+machine.id
        }
      ]
    }]
  };
}
