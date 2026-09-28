export function marketNotionalBounds(
  filters:Array<Record<string,unknown>>|undefined
):{min:number|null;max:number|null}{
  const minimums:number[]=[];
  const maximums:number[]=[];

  for(const filter of filters??[]){
    const type=String(filter.filterType??"");
    if(type==="MIN_NOTIONAL"){
      const min=Number(filter.minNotional);
      if(
        Number.isFinite(min)&&min>0&&
        filter.applyToMarket!==false
      ){
        minimums.push(min);
      }
    }else if(type==="NOTIONAL"){
      const min=Number(filter.minNotional);
      const max=Number(filter.maxNotional);
      if(
        Number.isFinite(min)&&min>0&&
        filter.applyMinToMarket!==false
      ){
        minimums.push(min);
      }
      if(
        Number.isFinite(max)&&max>0&&
        filter.applyMaxToMarket!==false
      ){
        maximums.push(max);
      }
    }
  }

  return {
    min:minimums.length?Math.max(...minimums):null,
    max:maximums.length?Math.min(...maximums):null
  };
}
