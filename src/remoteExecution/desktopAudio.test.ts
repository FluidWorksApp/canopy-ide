import {expect,it,vi} from 'vitest';
import {createPcmPlayer} from './desktopAudio';
function context(){
 const started:number[]=[];const channels:Float32Array[]=[];
 return {started,channels,value:{currentTime:1,destination:{},createBuffer:(_c:number,frames:number,rate:number)=>{const data=[new Float32Array(frames),new Float32Array(frames)];channels.push(...data);return {duration:frames/rate,getChannelData:(i:number)=>data[i]};},createBufferSource:()=>({buffer:null,connect:vi.fn(),start:(at:number)=>started.push(at)})} as unknown as AudioContext};
}
const pcm=(...values:number[])=>new Int16Array(values).buffer;
it('splits interleaved samples into channels and plays buffers back to back',()=>{
 const c=context();const play=createPcmPlayer(c.value);
 play(pcm(16384,-16384));play(pcm(0,0));
 expect([...c.channels[0]]).toEqual([0.5]);expect([...c.channels[1]]).toEqual([-0.5]);
 expect(c.started[0]).toBeCloseTo(1.08);expect(c.started[1]).toBeCloseTo(1.08+1/48000);
});
it('drops sound that has run too far ahead, and restarts after a gap',()=>{
 const c=context();const play=createPcmPlayer(c.value);const second=pcm(...new Array(96000).fill(0));
 play(second);play(pcm(0,0));expect(c.started).toHaveLength(1);
 (c.value as {currentTime:number}).currentTime=5;play(pcm(0,0));expect(c.started[1]).toBeCloseTo(5.08);
});
