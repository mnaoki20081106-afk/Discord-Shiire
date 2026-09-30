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
