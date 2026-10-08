// xterm's serializer preserves mouse tracking but not the report encoding.
// Observe public parser hooks without consuming the program's mode changes.
export function trackMouseEncoding(term){
 let encoding='DEFAULT';
 const change=enabled=>params=>{
  for(const value of params){
   if(value===1006)encoding=enabled?'SGR':'DEFAULT';
   if(value===1016)encoding=enabled?'SGR_PIXELS':'DEFAULT';
  }
  return false;
 };
 const reset=()=>{encoding='DEFAULT';};
 const hooks=[term.parser.registerCsiHandler({prefix:'?',final:'h'},change(true)),term.parser.registerCsiHandler({prefix:'?',final:'l'},change(false)),term.parser.registerEscHandler({final:'c'},()=>{reset();return false;})];
 return {reset,serialize(serializer,options){
  const mode=encoding==='SGR'?'\x1b[?1006h':encoding==='SGR_PIXELS'?'\x1b[?1016h':'\x1b[?1006l\x1b[?1016l';
  return serializer.serialize(options)+mode;
 },dispose(){hooks.forEach(hook=>hook.dispose());}};
}
