/**
 * REPO TALES — soundService.js
 * Système audio 8-bit entièrement synthétisé (Web Audio API), zéro asset.
 *
 * Pourquoi pas des .mp3/.wav ? Un thème chiptune + 6 bruitages pèsent vite
 * plusieurs centaines de Ko, et les navigateurs bloquent de toute façon l'audio
 * avant une interaction utilisateur. Ici tout est généré à la volée par des
 * oscillateurs (square/triangle) et un buffer de bruit blanc.
 *
 * API :
 *   sound.unlock()          — crée/réveille l'AudioContext (à appeler sur un geste)
 *   sound.toggleBgm()       — active/coupe la boucle, persiste le choix
 *   sound.isBgmEnabled()    — préférence persistée (localStorage)
 *   sound.subscribe(fn)     — notifie les composants React (bouton BGM)
 *   sound.insertCoin() · sound.click() · sound.pageFlip() · sound.alarm()
 *   sound.attack() · sound.critical() · sound.error()
 *
 * La boucle BGM utilise un scheduler à lookahead : les notes sont programmées
 * sur l'horloge AudioContext (précision échantillon), pas sur setInterval.
 */

const STORAGE_KEY = 'repotales:bgm';

/* 112 BPM, croches. 16 pas = 2 mesures. */
const BGM_STEP_SECONDS = 60 / 112 / 2;
const BGM_LOOKAHEAD = 0.2;
const BGM_TICK_MS = 40;
const BGM_VOLUME = 0.07;

/* La mineur : arpège i–VI–III–VII, une octave au-dessus de la basse. */
const MELODY = [69, 72, 76, 72, 69, 72, 76, 79, 67, 71, 74, 71, 67, 71, 74, 78];
/* Basse aux noires (une note toutes les 2 croches). */
const BASS = [45, null, 45, null, 43, null, 43, null, 41, null, 41, null, 43, null, 43, null];

const subscribers = new Set();

let ctx = null;
let master = null;
let bgmGain = null;
let sfxGain = null;
let noiseBuffer = null;

let bgmTimer = null;
let bgmPlaying = false;
let bgmStep = 0;
let nextStepAt = 0;

function readStoredPreference() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? true : raw === 'on';
  } catch {
    return true;
  }
}

let bgmEnabled = typeof window === 'undefined' ? true : readStoredPreference();

const midiToHz = (note) => 440 * 2 ** ((note - 69) / 12);

function createNoiseBuffer(c) {
  const length = Math.max(1, Math.floor(c.sampleRate));
  const buffer = c.createBuffer(1, length, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function ensureContext() {
  if (ctx) return ctx;
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;

  ctx = new Ctor();
  master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);

  bgmGain = ctx.createGain();
  bgmGain.gain.value = bgmEnabled ? BGM_VOLUME : 0;
  bgmGain.connect(master);

  sfxGain = ctx.createGain();
  sfxGain.gain.value = 0.16;
  sfxGain.connect(master);

  noiseBuffer = createNoiseBuffer(ctx);
  return ctx;
}

/** Crée (si besoin) et réveille l'AudioContext. À appeler sur un geste. */
export function unlock() {
  const c = ensureContext();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
  return c;
}

function playTone({
  freq,
  to,
  type = 'square',
  at,
  duration = 0.12,
  volume = 0.6,
  destination = sfxGain,
}) {
  const c = ensureContext();
  if (!c || !destination) return;
  const start = Math.max(at ?? c.currentTime, c.currentTime);
  const end = start + duration;

  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(20, freq), start);
  if (to != null) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), end);
  }
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), start + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);

  osc.connect(gain).connect(destination);
  osc.start(start);
  osc.stop(end + 0.03);
}

function playNoise({
  at,
  duration = 0.12,
  volume = 0.5,
  from = 3000,
  to = 300,
  q = 0.8,
  destination = sfxGain,
}) {
  const c = ensureContext();
  if (!c || !destination || !noiseBuffer) return;
  const start = Math.max(at ?? c.currentTime, c.currentTime);
  const end = start + duration;

  const source = c.createBufferSource();
  source.buffer = noiseBuffer;

  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = q;
  filter.frequency.setValueAtTime(Math.max(40, from), start);
  filter.frequency.exponentialRampToValueAtTime(Math.max(40, to), end);

  const gain = c.createGain();
  gain.gain.setValueAtTime(Math.max(0.0002, volume), start);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);

  source.connect(filter).connect(gain).connect(destination);
  source.start(start);
  source.stop(end + 0.02);
}

/* ── Bruitages ─────────────────────────────────────────────────────────── */

export function click() {
  unlock();
  playTone({ freq: 880, to: 660, duration: 0.05, volume: 0.5 });
}

export function insertCoin() {
  const c = unlock();
  if (!c) return;
  [1046.5, 1318.5, 1568, 2093].forEach((freq, index) => {
    playTone({ freq, at: c.currentTime + index * 0.065, duration: 0.09, volume: 0.55 });
  });
}

export function pageFlip() {
  unlock();
  playNoise({ from: 4200, to: 380, duration: 0.15, volume: 0.5 });
  playTone({ freq: 1400, to: 260, type: 'triangle', duration: 0.13, volume: 0.28 });
}

export function alarm() {
  const c = unlock();
  if (!c) return;
  for (let i = 0; i < 3; i += 1) {
    const at = c.currentTime + i * 0.28;
    playTone({ freq: 740, at, duration: 0.13, volume: 0.5 });
    playTone({ freq: 494, at: at + 0.14, duration: 0.13, volume: 0.5 });
  }
  playNoise({ from: 900, to: 180, duration: 0.5, volume: 0.22 });
}

export function attack() {
  unlock();
  playTone({ freq: 320, to: 90, type: 'sawtooth', duration: 0.16, volume: 0.5 });
  playNoise({ from: 1400, to: 120, duration: 0.12, volume: 0.32 });
}

export function critical() {
  const c = unlock();
  if (!c) return;
  playTone({ freq: 220, to: 70, type: 'sawtooth', duration: 0.2, volume: 0.55 });
  playNoise({ from: 2600, to: 140, duration: 0.18, volume: 0.4 });
  [1568, 2093, 2637].forEach((freq, index) => {
    playTone({ freq, at: c.currentTime + 0.02 + index * 0.05, duration: 0.07, volume: 0.35 });
  });
}

export function victory() {
  const c = unlock();
  if (!c) return;
  // Fanfare 8-bit : arpège montant puis accord tenu, type « quest clear ».
  [523, 659, 784, 1047].forEach((freq, index) => {
    playTone({ freq, at: c.currentTime + index * 0.09, duration: 0.12, volume: 0.5 });
  });
  [1319, 1568, 2093].forEach((freq) => {
    playTone({ freq, at: c.currentTime + 0.4, duration: 0.42, volume: 0.32 });
  });
  playNoise({ from: 5200, to: 900, duration: 0.3, volume: 0.18 });
}

export function error() {
  unlock();
  playTone({ freq: 220, to: 110, type: 'square', duration: 0.18, volume: 0.45 });
}

/* ── Boucle BGM ────────────────────────────────────────────────────────── */

function scheduleBgmStep(step, at) {
  const note = MELODY[step % MELODY.length];
  if (note != null) {
    playTone({
      freq: midiToHz(note),
      at,
      duration: BGM_STEP_SECONDS * 0.9,
      type: 'square',
      volume: 0.55,
      destination: bgmGain,
    });
  }

  const bass = BASS[step % BASS.length];
  if (bass != null) {
    playTone({
      freq: midiToHz(bass),
      at,
      duration: BGM_STEP_SECONDS * 1.7,
      type: 'triangle',
      volume: 0.9,
      destination: bgmGain,
    });
  }

  /* Kick toutes les noires, hi-hat sur les croches paires. */
  if (step % 4 === 0) {
    playTone({
      freq: 130,
      to: 48,
      at,
      duration: 0.12,
      type: 'sine',
      volume: 0.9,
      destination: bgmGain,
    });
  }
  if (step % 2 === 0) {
    playNoise({
      at,
      duration: 0.035,
      volume: 0.12,
      from: 7000,
      to: 5000,
      q: 1.2,
      destination: bgmGain,
    });
  }
}

function scheduler() {
  const c = ctx;
  if (!c || !bgmPlaying) return;
  while (nextStepAt < c.currentTime + BGM_LOOKAHEAD) {
    scheduleBgmStep(bgmStep, nextStepAt);
    nextStepAt += BGM_STEP_SECONDS;
    bgmStep = (bgmStep + 1) % MELODY.length;
  }
}

function setBgmGain(value) {
  if (!ctx || !bgmGain) return;
  bgmGain.gain.cancelScheduledValues(ctx.currentTime);
  bgmGain.gain.setTargetAtTime(value, ctx.currentTime, 0.03);
}

export function startBgm() {
  if (!bgmEnabled) return;
  const c = unlock();
  if (!c || bgmPlaying) return;
  bgmPlaying = true;
  bgmStep = 0;
  nextStepAt = c.currentTime + 0.06;
  setBgmGain(BGM_VOLUME);
  bgmTimer = window.setInterval(scheduler, BGM_TICK_MS);
}

export function stopBgm() {
  bgmPlaying = false;
  if (bgmTimer != null) window.clearInterval(bgmTimer);
  bgmTimer = null;
  setBgmGain(0);
}

function notify() {
  subscribers.forEach((fn) => {
    try {
      fn(bgmEnabled);
    } catch {
      /* un abonné qui jette ne doit pas casser les autres */
    }
  });
}

export function setBgmEnabled(value) {
  const next = Boolean(value);
  if (next === bgmEnabled) {
    if (next) startBgm();
    return;
  }
  bgmEnabled = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
  } catch {
    /* stockage indisponible (navigation privée) : préférence en mémoire */
  }
  if (next) startBgm();
  else stopBgm();
  notify();
}

export function toggleBgm() {
  setBgmEnabled(!bgmEnabled);
  click();
}

export function isBgmEnabled() {
  return bgmEnabled;
}

export function subscribe(listener) {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

/** Débloque l'audio au premier geste, puis lance la BGM si activée. */
if (typeof window !== 'undefined') {
  const onFirstGesture = () => {
    window.removeEventListener('pointerdown', onFirstGesture);
    unlock();
    if (bgmEnabled) startBgm();
  };
  window.addEventListener('pointerdown', onFirstGesture, { once: true, passive: true });
}

export const sound = {
  unlock,
  startBgm,
  stopBgm,
  setBgmEnabled,
  toggleBgm,
  isBgmEnabled,
  subscribe,
  click,
  insertCoin,
  pageFlip,
  alarm,
  attack,
  critical,
  victory,
  error,
};

export default sound;
