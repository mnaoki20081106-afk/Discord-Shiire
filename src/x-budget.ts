export type ProcurementBudgetClass=
  | "INVITE_CAMPAIGN"
  | "NO_SHADOWBAN"
  | "TOP_SEARCH";

export type ProcurementBudgetPercentages={
  INVITE_CAMPAIGN:number;
  NO_SHADOWBAN:number;
  TOP_SEARCH:number;
};

export type ProcurementBudgetAmounts={
  INVITE_CAMPAIGN:number;
  NO_SHADOWBAN:number;
  TOP_SEARCH:number;
};

const CLASSES:readonly ProcurementBudgetClass[]=[
  "INVITE_CAMPAIGN",
  "NO_SHADOWBAN",
  "TOP_SEARCH"
];

export function validateProcurementBudgetPercentages(
  percentages:ProcurementBudgetPercentages
){
  let total=0;
  for(const key of CLASSES){
    const value=percentages[key];
    if(!Number.isSafeInteger(value)||value<0||value>100){
      throw new Error("PROCUREMENT_BUDGET_PERCENT_INVALID");
    }
    total+=value;
  }
  if(total!==100) throw new Error("PROCUREMENT_BUDGET_PERCENT_TOTAL_NOT_100");
  return percentages;
}

function roundUsd(value:number){
  return Math.round((value+Number.EPSILON)*100_000_000)/100_000_000;
}

export function allocateProcurementBudget(
  totalUsd:number,
  percentages:ProcurementBudgetPercentages
):ProcurementBudgetAmounts{
  validateProcurementBudgetPercentages(percentages);
  const safeTotal=
    Number.isFinite(totalUsd)&&totalUsd>0
      ?roundUsd(totalUsd)
      :0;

  const invite=roundUsd(
    safeTotal*percentages.INVITE_CAMPAIGN/100
  );
  const noShadow=roundUsd(
    safeTotal*percentages.NO_SHADOWBAN/100
  );
  const top=roundUsd(Math.max(0,safeTotal-invite-noShadow));

  return {
    INVITE_CAMPAIGN:invite,
    NO_SHADOWBAN:noShadow,
    TOP_SEARCH:top
  };
}

export function procurementBudgetTotal(amounts:ProcurementBudgetAmounts){
  return roundUsd(
    Math.max(0,amounts.INVITE_CAMPAIGN)+
    Math.max(0,amounts.NO_SHADOWBAN)+
    Math.max(0,amounts.TOP_SEARCH)
  );
}


export function procurementBudgetCharges(
  targetClass:ProcurementBudgetClass,
  splitAcrossClasses:boolean,
  totalUsd:number
):ProcurementBudgetAmounts{
  const safeTotal=
    Number.isFinite(totalUsd)&&totalUsd>0
      ?roundUsd(totalUsd)
      :0;
  const charges:ProcurementBudgetAmounts={
    INVITE_CAMPAIGN:0,
    NO_SHADOWBAN:0,
    TOP_SEARCH:0
  };
  if(splitAcrossClasses&&targetClass!=="INVITE_CAMPAIGN"){
    const firstHalf=roundUsd(safeTotal/2);
    const secondHalf=roundUsd(Math.max(0,safeTotal-firstHalf));
    charges.TOP_SEARCH=firstHalf;
    charges.NO_SHADOWBAN=secondHalf;
  }else{
    charges[targetClass]=safeTotal;
  }
  return charges;
}

export function maxAffordableQuantityForBudget(
  targetClass:ProcurementBudgetClass,
  splitAcrossClasses:boolean,
  unitPriceUsd:number,
  maxQuantity:number,
  available:ProcurementBudgetAmounts
){
  if(!Number.isFinite(unitPriceUsd)||unitPriceUsd<=0) return 0;
  const safeMax=Math.max(0,Math.floor(maxQuantity));
  if(splitAcrossClasses&&targetClass!=="INVITE_CAMPAIGN"){
    const perClassBudget=Math.min(
      Math.max(0,available.TOP_SEARCH),
      Math.max(0,available.NO_SHADOWBAN)
    );
    const pairs=Math.floor(
      (perClassBudget+0.00000001)/unitPriceUsd
    );
    const evenMax=safeMax-safeMax%2;
    return Math.min(evenMax,pairs*2);
  }
  return Math.min(
    safeMax,
    Math.floor(
      (Math.max(0,available[targetClass])+0.00000001)/unitPriceUsd
    )
  );
}
