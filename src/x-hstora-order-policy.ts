export function hstoraStatusRequiresDelivery(status:string):boolean{
  const normalized=String(status??"").trim().toUpperCase();
  return normalized==="DELIVERED"||normalized==="COMPLETED";
}

export function hstoraHasUsableDelivery(order:{
  delivery?:{available?:boolean;items?:unknown[]};
}):boolean{
  return Boolean(
    order.delivery?.available===true&&
    Array.isArray(order.delivery.items)
  );
}
