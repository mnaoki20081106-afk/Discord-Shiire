export function jstDateKey(now=Date.now()){
  const d=new Date(now+9*60*60*1000);
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth()+1).padStart(2,"0"),
    String(d.getUTCDate()).padStart(2,"0")
  ].join("-");
}

export function isDailyRestockScheduleMinute(scheduledTime:number){
  const d=new Date(scheduledTime+9*60*60*1000);
  return d.getUTCHours()===18&&d.getUTCMinutes()===0;
}


export function shouldNotifyDailyRestock(input:{
  addedTopSearch:number;
  addedNoShadowban:number;
}){
  return (
    Math.max(0,Number(input.addedTopSearch)||0)+
    Math.max(0,Number(input.addedNoShadowban)||0)
  )>0;
}

// Retry missed starts after notification retries or a busy daily lease.
// startDailyRestock still enforces one batch per JST date.
export function isDailyRestockScheduleWindow(scheduledTime:number){
  return new Date(scheduledTime+9*60*60*1000).getUTCHours()>=18;
}
