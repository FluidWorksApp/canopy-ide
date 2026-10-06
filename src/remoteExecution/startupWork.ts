let epoch=0;
export const beginStartupWork=()=>++epoch;
export const cancelStartupWork=()=>{epoch++;};
export const currentStartupWork=(value:number)=>value===epoch;
export function boundedStartup<T>(task:Promise<T>,milliseconds=10000):Promise<T>{
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('STARTUP_TIMEOUT')),milliseconds);task.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
}
