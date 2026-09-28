export function comparableEffectivePriceJumpPercent(input:{
  previousUnitPrice:number;
  previousCurrency:string;
  previousPlannedQuantity:number|null;
  currentUnitPrice:number;
  currentCurrency:string;
  currentPlannedQuantity:number;
}):number|null{
  const previous=Number(input.previousUnitPrice);
  const current=Number(input.currentUnitPrice);
  const previousQty=Number(input.previousPlannedQuantity);
  const currentQty=Number(input.currentPlannedQuantity);

  if(
    !Number.isFinite(previous)||previous<=0||
    !Number.isFinite(current)||current<=0||
    !Number.isSafeInteger(previousQty)||previousQty<=0||
    !Number.isSafeInteger(currentQty)||currentQty<=0||
    previousQty!==currentQty||
    String(input.previousCurrency).toUpperCase()!==
      String(input.currentCurrency).toUpperCase()
  ){
    return null;
  }

  return Math.abs(current-previous)/previous*100;
}
