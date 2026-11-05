// Sound for the on-demand remote desktop. VNC carries only pixels, so programs
// play into a virtual sound card (a PulseAudio null sink) and the IDE opens a
// second stream of its monitor, as raw 16-bit stereo PCM at 48 kHz. Raw keeps
// the player in the IDE simple; it costs about 1.5 Mbit/s, and only while the
// person has Sound switched on.
export const PULSE_ARGS=Object.freeze(['--daemonize=no','--use-pid-file=false','--exit-idle-time=-1','--disallow-exit','--realtime=false','--high-priority=false','--disable-shm=true','-n','--load=module-native-protocol-unix','--load=module-null-sink sink_name=canopy sink_properties=device.description=Canopy rate=48000 channels=2']);
export const PAREC_ARGS=Object.freeze(['--device=canopy.monitor','--format=s16le','--rate=48000','--channels=2','--latency-msec=40']);
const FRAME_BYTES=4;
// Live sound is better dropped than delayed: a slow connection skips audio
// rather than falling further and further behind the picture.
const MAX_QUEUED_BYTES=256*1024;

/** Stream the desktop's sound to one WebSocket until either side ends. Each
 *  message holds whole frames, so a dropped message can't swap the channels. */
export function streamDesktopAudio(ws,{spawn,env}){
 const capture=spawn('parec',[...PAREC_ARGS],{stdio:['ignore','pipe','ignore'],env});
 let rest=Buffer.alloc(0);
 capture.stdout?.on('data',chunk=>{
  const data=rest.length?Buffer.concat([rest,chunk]):chunk;
  const whole=data.length-data.length%FRAME_BYTES;
  rest=data.subarray(whole);
  if(whole&&ws.readyState===1&&ws.bufferedAmount<=MAX_QUEUED_BYTES)ws.send(data.subarray(0,whole));
 });
 const end=()=>{if(ws.readyState<=1)ws.close(1011,'Desktop audio ended');};
 capture.once('error',end);capture.once('close',end);
 ws.once('close',()=>capture.kill());
 ws.on('error',()=>capture.kill());
}
