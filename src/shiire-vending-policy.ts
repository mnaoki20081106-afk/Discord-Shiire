export const SHIIRE_DISCORD_BOT_PERMISSIONS=268553216;

export type ShiirePaymentMethod="paypay"|"kyash";

export type ShiirePricedProduct={
  price_paypay:number;
  price_kyash:number;
  stock_count?:number;
};

export function paymentPrice(
  product:ShiirePricedProduct,
  method:ShiirePaymentMethod
):number{
  return method==="kyash"
    ?Math.max(0,Math.floor(Number(product.price_kyash)||0))
    :Math.max(0,Math.floor(Number(product.price_paypay)||0));
}

export function paymentMethodEnabled(
  product:ShiirePricedProduct,
  method:ShiirePaymentMethod
):boolean{
  return paymentPrice(product,method)>=1;
}

export function canReleaseReservedOrder(status:string):boolean{
  return status==="awaiting_payment"||
    status==="reserving"||
    status==="failed";
}

export function shouldExpireUnpaidOrder(
  status:string,
  reservedUntil:number|null,
  now:number
):boolean{
  return status==="awaiting_payment"&&
    reservedUntil!==null&&
    Number.isFinite(reservedUntil)&&
    reservedUntil<now;
}

export function deliveryNonce(orderId:string):string{
  return ("svd"+orderId.replace(/[^A-Za-z0-9]/g,"")).slice(0,25);
}
