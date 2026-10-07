/**
 * Optional industrial ambience (§127), synthesised with WebAudio — no audio files.
 * HVAC rumble (filtered noise) + mains hum + a machine voice whose pitch follows the
 * current process (e.g. spin speed, RF power). Everything works with sound off.
 */
import { engine } from '@/simulation/engine';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let voice: OscillatorNode | null = null;
let voiceGain: GainNode | null = null;
let timer = 0;

export function startAudio() {
  if (ctx) {
    ctx.resume();
    master!.gain.setTargetAtTime(0.5, ctx.currentTime, 0.4);
    if (!timer) timer = window.setInterval(updateVoice, 200);
    return;
  }
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);
  master.gain.setTargetAtTime(0.5, ctx.currentTime, 0.6);

  // HVAC: brown-ish noise through a low-pass
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    d[i] = last * 3.5;
  }
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  noise.loop = true;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 380;
  const ng = ctx.createGain();
  ng.gain.value = 0.22;
  noise.connect(lp).connect(ng).connect(master);
  noise.start();

  // mains hum
  const hum = ctx.createOscillator();
  hum.frequency.value = 100;
  const hg = ctx.createGain();
  hg.gain.value = 0.012;
  hum.connect(hg).connect(master);
  hum.start();

  // machine voice
  voice = ctx.createOscillator();
  voice.type = 'sawtooth';
  voice.frequency.value = 80;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 600;
  bp.Q.value = 2;
  voiceGain = ctx.createGain();
  voiceGain.gain.value = 0;
  voice.connect(bp).connect(voiceGain).connect(master);
  voice.start();

  timer = window.setInterval(updateVoice, 200);
}

function updateVoice() {
  if (!ctx || !voice || !voiceGain) return;
  const ch = engine.tele.channels[0];
  const playing = engine.player.playing && engine.player.view.phase.machineState === 'PROCESSING';
  let f = 0;
  if (ch && isFinite(ch.value)) f = Math.min(1, Math.max(0, (ch.value - ch.def.min) / (ch.def.max - ch.def.min || 1)));
  voice.frequency.setTargetAtTime(60 + 240 * f, ctx.currentTime, 0.25);
  voiceGain.gain.setTargetAtTime(playing ? 0.025 : 0.0, ctx.currentTime, 0.3);
}

export function stopAudio() {
  if (!ctx || !master) return;
  master.gain.setTargetAtTime(0, ctx.currentTime, 0.2);
  window.setTimeout(() => ctx?.suspend(), 400);
  window.clearInterval(timer);
  timer = 0;
}
