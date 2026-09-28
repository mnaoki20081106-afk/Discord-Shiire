export type RestockClass="TOP_SEARCH"|"NO_SHADOWBAN";

export type RestockDecisionInput={
  topInventory:number;
  topReorderPoint:number;
  topTargetStock:number;
  topCycleActive:boolean;
  noShadowInventory:number;
  noShadowReorderPoint:number;
  noShadowTargetStock:number;
  noShadowCycleActive:boolean;
};

export type RestockDecision={
  targetClass:RestockClass;
  classInventory:number;
  classTarget:number;
  triggeredNow:boolean;
}|null;

function nonNegative(value:number){
  return Math.max(0,Number.isFinite(value)?value:0);
}

export function restockCycleComplete(
  inventory:number,
  targetStock:number
):boolean{
  return nonNegative(inventory)>=nonNegative(targetStock);
}

export function chooseRestockClass(
  input:RestockDecisionInput
):RestockDecision{
  const topInventory=nonNegative(input.topInventory);
  const topReorder=nonNegative(input.topReorderPoint);
  const topTarget=nonNegative(input.topTargetStock);
  const shadowInventory=nonNegative(input.noShadowInventory);
  const shadowReorder=nonNegative(input.noShadowReorderPoint);
  const shadowTarget=nonNegative(input.noShadowTargetStock);

  const topTriggered=topInventory<=topReorder;
  const topActive=
    (input.topCycleActive||topTriggered)&&
    topInventory<topTarget;

  if(topActive){
    return {
      targetClass:"TOP_SEARCH",
      classInventory:topInventory,
      classTarget:topTarget,
      triggeredNow:!input.topCycleActive&&topTriggered
    };
  }

  const shadowTriggered=shadowInventory<=shadowReorder;
  const shadowActive=
    (input.noShadowCycleActive||shadowTriggered)&&
    shadowInventory<shadowTarget;

  if(shadowActive){
    return {
      targetClass:"NO_SHADOWBAN",
      classInventory:shadowInventory,
      classTarget:shadowTarget,
      triggeredNow:!input.noShadowCycleActive&&shadowTriggered
    };
  }

  return null;
}
