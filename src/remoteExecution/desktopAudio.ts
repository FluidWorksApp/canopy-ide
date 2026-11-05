/** Must match PAREC_ARGS in packages/remote-host/desktop-audio.mjs. */
export const DESKTOP_AUDIO_RATE = 48_000;
const CHANNELS = 2;
/** How far ahead sound is scheduled, to ride out network jitter. */
const LEAD_S = 0.08;
/** Past this, sound is dropped so it catches up with the picture. */
const MAX_LEAD_S = 0.4;

/** A player for the desktop's raw 16-bit stereo stream. Scheduling buffers needs
 *  no worklet, so nothing has to be allowed through the app's script policy. */
export function createPcmPlayer(context: AudioContext) {
  let next = 0;
  return (data: ArrayBuffer) => {
    const samples = new Int16Array(data);
    const frames = Math.floor(samples.length / CHANNELS);
    if (!frames) return;
    const now = context.currentTime;
    if (next < now) next = now + LEAD_S;
    else if (next > now + MAX_LEAD_S) return;
    const buffer = context.createBuffer(CHANNELS, frames, DESKTOP_AUDIO_RATE);
    for (let channel = 0; channel < CHANNELS; channel++) {
      const output = buffer.getChannelData(channel);
      for (let frame = 0; frame < frames; frame++) output[frame] = samples[frame * CHANNELS + channel] / 32768;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(next);
    next += buffer.duration;
  };
}
