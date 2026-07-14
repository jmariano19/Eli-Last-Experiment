(function () {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────────
  const params    = new URLSearchParams(window.location.search);
  const startScene = params.get('scene') || null;

  // Editor previews pass ?scene= / ?preview=1 and must always fetch fresh files.
  // The deployed game uses clean URLs so the browser + in-memory caches can work.
  const devMode   = params.has('preview') || params.has('scene');
  const fetchOpts = devMode ? { cache: 'no-store' } : {};

  // ?shell=0 — strip the desktop phone frame so the game fills the real viewport.
  // Applied by the 📱 mobile test buttons and useful for responsive testing.
  if (params.get('shell') === '0') {
    document.documentElement.setAttribute('data-shell', 'none');
  }

  // Multi-game: ?game=<id> plays that game's content from games/<id>/.
  // Without the param the server serves the default game at the legacy paths.
  const gameId   = (params.get('game') || '').replace(/[^a-z0-9_-]/gi, '');
  const gameBase = gameId ? `./games/${gameId}` : '.';

  function sceneAssetUrl(sceneId, rest) {
    return `${gameBase}/scenes/${sceneId}/${rest}`;
  }

  function resolveAssetUrl(sceneId, path) {
    if (!path) return '';
    if (/^(?:https?:|data:|blob:|\.?\/)/.test(path)) return path;
    return sceneAssetUrl(sceneId, path);
  }

  function freshUrl(url) {
    return devMode ? `${url}?v=${Date.now()}` : url;
  }

  // Player progress — lets a returning player resume where they left off
  const PROGRESS_KEY = `eli.progress.${gameId || 'default'}`;

  let sequence        = null;
  let currentSceneId  = null;
  let riveInstance    = null;
  let inputByName     = new Map();
  let navPollFrame    = null;
  let hapticPollFrame = null;
  let activeLipSyncAudio  = null;
  let activeLipSyncFrame  = null;
  let segmentCleanup  = null;
  let activeSegmentBgs = [];      // array — supports multiple simultaneous bg tracks
  let activeSegmentBgNames = [];  // parallel array of filenames for change-detection
  let activeBgAudios = [];
  const RIVE_CACHE_MAX = 8;
  let riveBufferCache  = new Map();   // path → Promise<ArrayBuffer>, LRU capped
  let sceneConfigCache = new Map();   // id → scene.json (game mode only)
  let chatMessages    = [];
  let activeTextCueTimer = null;
  let activeCharTimers = [];
  let lastEmotion = 0;
  let sceneLoading = false;
  let pendingSceneId = null;
  let sceneTapCleanups = [];
  let activeMemoryCleanup = null;
  let activeMemoryCaptionTimer = null;

  // Haptic presets — keep in sync with the editor's HAPTIC_PRESETS.
  // Rive events named haptic_<preset> fire these (Android; iOS has no support).
  const HAPTIC_PATTERNS = {
    tap: [20], soft: [50], strong: [140],
    double: [45, 70, 45], heartbeat: [35, 80, 55, 320], buzz: [400],
  };

  function playHaptic(nameOrPattern) {
    if (!navigator.vibrate) return;
    const pattern = Array.isArray(nameOrPattern)
      ? nameOrPattern
      : HAPTIC_PATTERNS[String(nameOrPattern)] || [50];
    try { navigator.vibrate(pattern); } catch {}
  }

  // One-shot tap listeners that must not survive a scene change.
  // Registered here so loadScene() can remove any that never fired.
  function addSceneTapListener(target, handler) {
    target.addEventListener('pointerup', handler, { once: true });
    const cleanup = () => target.removeEventListener('pointerup', handler);
    sceneTapCleanups.push(cleanup);
    return cleanup;
  }

  function clearSceneTapListeners() {
    for (const fn of sceneTapCleanups) fn();
    sceneTapCleanups = [];
  }

  // ─── Mumble voice system (pure Web Audio synthesis — no files needed) ────────
  // Two-formant vowel synthesis: each character maps to a phoneme with distinct
  // F1/F2 formant frequencies, giving each syllable a different timbral quality
  // similar to Animal Crossing's approach. No file loading = works instantly.
  const MUMBLE_MIN_INTERVAL = 80;
  const MUMBLE_VOLUME       = 0.22;
  // Smaller semitone range and irregular pattern — speech-like, not scale-like
  const MUMBLE_MELODY = [0, 2, -1, 1, 3, 0, -2, 2, 1, -1, 0, 3, -1, 2, 0, 1];

  // Phoneme → [F1 Hz, F2 Hz] formant pairs
  const MUMBLE_FORMANTS = {
    ah:  [780, 1100], eh:  [680, 1800], ee:  [390, 2300],
    oh:  [560,  840], oo:  [315,  850], mm:  [490, 1000],
    nn:  [490, 1100], ss:  [560, 3100], ff:  [540, 2900],
    th:  [555, 3000], ba:  [680, 1100], da:  [690, 1400],
    ka:  [680, 1300], la:  [610, 1100], ra:  [670, 1050],
    wa:  [710,  950], ya:  [540, 2200], ha:  [770, 1300],
    huh: [650, 1000], uh:  [670, 1100],
  };

  let mumbleAudioContext  = null;
  let mumbleMaster        = null;
  let mumbleNoiseBuffer   = null;   // 2-sec white noise buffer, created once and reused
  let lastMumbleTime      = 0;
  let lastMumblePick      = '';
  let mumbleMelodyIdx     = 0;

  // Sample-based mumble: syllable chunks sliced from the real voice recordings
  // (public/audio/mumble/, rebuilt with `node build-mumble-sprite.mjs <mp3s>`).
  // Loaded lazily; until ready — or if the sprite is missing — the formant
  // synth below plays instead, so the game never goes silent.
  const MUMBLE_SAMPLE_VOLUME = 0.5;
  let mumbleSpriteBuffer  = null;
  let mumbleSpriteChunks  = null;
  let mumbleSpriteLoading = false;
  let lastChunkIdxs       = [];

  function loadMumbleSprite(ctx) {
    if (mumbleSpriteBuffer || mumbleSpriteLoading) return;
    mumbleSpriteLoading = true;
    Promise.all([
      fetch('./public/audio/mumble/eli-mumble.json').then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
      fetch('./public/audio/mumble/eli-mumble.wav').then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }),
    ]).then(([manifest, wav]) => ctx.decodeAudioData(wav).then(buf => {
      mumbleSpriteBuffer = buf;
      mumbleSpriteChunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
    })).catch(() => { /* keep synth fallback; don't retry */ });
  }

  // Game-wide voice tuning, set with the sliders next to the Mumble checkbox
  // in the editor (persisted as `mumble` in sequence.json). All multipliers:
  // 1 = the built-in defaults.
  let mumbleTuning = { volume: 1, pitch: 1, expression: 1, variation: 1 };

  function applyMumbleTuning(raw) {
    if (!raw || typeof raw !== 'object') return;
    const pct = (v, lo, hi, dflt) => Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v) / 100)) : dflt;
    mumbleTuning = {
      volume:     pct(raw.volume,     0,   2,   1),
      pitch:      pct(raw.pitch,      0.5, 1.5, 1),
      expression: pct(raw.expression, 0,   2,   1),
      variation:  pct(raw.variation,  0,   2,   1),
    };
  }

  // Phrase-level prosody so the mumble follows speech melody instead of a
  // looping scale: pitch declines across the phrase, rises at the end of a
  // question, and wanders slightly (random walk + jitter) like a real voice.
  let mumblePhrase = { len: 1, question: false, walk: 0 };

  function resetMumblePhrase(wordCount, isQuestion) {
    mumblePhrase = { len: Math.max(1, wordCount), question: isQuestion, walk: 0 };
  }

  // Generate a 2-second white-noise AudioBuffer once per AudioContext.
  // Reusing the buffer (looped) is far cheaper than allocating per syllable.
  function getMumbleNoise(ctx) {
    if (mumbleNoiseBuffer) return mumbleNoiseBuffer;
    const sr  = ctx.sampleRate;
    const buf = ctx.createBuffer(1, sr * 2, sr);
    const d   = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    mumbleNoiseBuffer = buf;
    return buf;
  }

  function getMumbleContext() {
    if (mumbleAudioContext) return mumbleAudioContext;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    const ctx    = new AudioCtx();
    mumbleMaster      = ctx.createGain();
    mumbleMaster.gain.value = 0.9;
    mumbleMaster.connect(ctx.destination);
    mumbleAudioContext = ctx;
    mumbleNoiseBuffer  = null;   // reset so getMumbleNoise() regenerates for new ctx
    loadMumbleSprite(ctx);
    return ctx;
  }

  function unlockMumbleAudio() {
    const ctx = getMumbleContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    ['pointerdown', 'touchend', 'click', 'keydown'].forEach(evt =>
      document.removeEventListener(evt, unlockMumbleAudio)
    );
  }
  ['pointerdown', 'touchend', 'click', 'keydown'].forEach(evt =>
    document.addEventListener(evt, unlockMumbleAudio)
  );

  function ensureMumbleUnlocked() {
    const ctx = getMumbleContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  function pickMumbleSound(char) {
    const vowelMap   = { a:'ah', e:'eh', i:'ee', o:'oh', u:'oo', A:'ah', E:'eh', I:'ee', O:'oh', U:'oo' };
    const softSounds = ['la','ra','wa','ya','mm','nn'];
    const hardSounds = ['ba','da','ka','ha'];
    const hissSounds = ['ss','ff','th'];
    let pick;
    if (vowelMap[char])                        pick = vowelMap[char];
    else if ('sSfFxXzZ'.includes(char))        pick = hissSounds[Math.floor(Math.random() * hissSounds.length)];
    else if ('bBdDgGkKpPtT'.includes(char))    pick = hardSounds[Math.floor(Math.random() * hardSounds.length)];
    else if ('mMnNlLrRwWyY'.includes(char))    pick = softSounds[Math.floor(Math.random() * softSounds.length)];
    else { const pool = Math.random() < 0.65 ? softSounds : hardSounds; pick = pool[Math.floor(Math.random() * pool.length)]; }
    if (pick === lastMumblePick) {
      const alt = ['ah','eh','la','ra','ba','da'];
      pick = alt[Math.floor(Math.random() * alt.length)];
    }
    lastMumblePick = pick;
    return pick;
  }

  function emotionPitchBase(emotion) {
    // Values 1–8 are emotional eye states — keep the expressive pitch.
    // 10–13 are gaze directions, which shouldn't change the voice.
    if (emotion === 1) return 0.92;
    if (emotion === 2) return 1.20;
    if (emotion === 3) return 1.13;
    if (emotion === 4) return 1.18;
    return 1.06;
  }

  function playMumbleSyllable(char, emotion, pros = {}) {
    const now = performance.now();
    if (now - lastMumbleTime < MUMBLE_MIN_INTERVAL) return;
    const ctx = mumbleAudioContext;
    if (!ctx || ctx.state !== 'running') return;

    lastMumbleTime = now;

    if (mumbleSpriteBuffer && mumbleSpriteChunks && mumbleSpriteChunks.length) {
      playMumbleSample(char, emotion, pros.wordIndex || 0, pros.word || '');
    } else {
      playMumbleSynth(char, emotion);
    }
  }

  // Real-voice mumble: play one sliced syllable with phrase prosody.
  function playMumbleSample(char, emotion, wordIndex, word) {
    const ctx    = mumbleAudioContext;
    const chunks = mumbleSpriteChunks;

    // Hissy letters get hissy chunks; everything else gets voiced ones.
    // Avoid the last few picks so short phrases don't repeat a syllable.
    const wantHiss = 'sSfFxXzZcC'.includes(char);
    let pool = chunks.map((c, i) => ({ c, i })).filter(o => (o.c.kind === 'hiss') === wantHiss);
    if (!pool.length) pool = chunks.map((c, i) => ({ c, i }));
    const fresh = pool.filter(o => !lastChunkIdxs.includes(o.i));
    const pick  = (fresh.length ? fresh : pool)[Math.floor(Math.random() * (fresh.length ? fresh.length : pool.length))];
    lastChunkIdxs = [pick.i, ...lastChunkIdxs].slice(0, 4);

    // Prosody: declination across the phrase, question rise at the end,
    // slow random walk + per-syllable jitter. All expressed as playback rate
    // so the actor's own pitch stays the neutral center. `expression` scales
    // the melodic movement, `variation` the randomness.
    const prog = mumblePhrase.len > 1 ? Math.min(1, wordIndex / (mumblePhrase.len - 1)) : 0;
    const expr = mumbleTuning.expression;
    const vari = mumbleTuning.variation;
    mumblePhrase.walk = Math.max(-0.05, Math.min(0.05, mumblePhrase.walk + (Math.random() * 0.036 - 0.018) * vari));
    let rate = (emotionPitchBase(emotion) / 1.06) * mumbleTuning.pitch;   // 1.0 = actor pitch
    rate *= 1 + (0.05 - 0.10 * prog) * expr;                              // phrase declination
    if (mumblePhrase.question && prog > 0.7) rate *= 1 + 0.16 * ((prog - 0.7) / 0.3) * expr;
    rate *= 1 + mumblePhrase.walk * expr + (Math.random() * 0.02 - 0.01) * vari;

    // Stress: phrase-initial and long words land a little louder
    const stressed = wordIndex === 0 || (word && word.length >= 6);
    const t   = ctx.currentTime + 0.003;
    const src = ctx.createBufferSource();
    src.buffer = mumbleSpriteBuffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = MUMBLE_SAMPLE_VOLUME * mumbleTuning.volume * (stressed ? 1.15 : 1 - 0.08 * vari + Math.random() * 0.16 * vari);
    src.connect(g);
    g.connect(mumbleMaster || ctx.destination);
    src.start(t, pick.c.start, pick.c.dur);
  }

  // Formant-synth mumble — fallback while the sprite loads or if it's missing.
  function playMumbleSynth(char, emotion) {
    const ctx = mumbleAudioContext;

    const semitone = MUMBLE_MELODY[mumbleMelodyIdx % MUMBLE_MELODY.length];
    mumbleMelodyIdx++;

    const pick     = pickMumbleSound(char);
    const [f1, f2] = MUMBLE_FORMANTS[pick] || [650, 1200];
    const wobble   = 1 + (Math.random() * 0.04 - 0.02);
    const f0       = emotionPitchBase(emotion) * 230 * Math.pow(2, semitone / 12) * wobble * mumbleTuning.pitch;
    const dur      = 0.10 + Math.random() * 0.055;   // 100–155 ms
    const t        = ctx.currentTime + 0.003;

    // — Source A: sawtooth oscillator (vocal-cord-like, rich harmonics) —
    const oscA = ctx.createOscillator();
    oscA.type = 'sawtooth';
    oscA.frequency.setValueAtTime(f0, t);
    oscA.frequency.exponentialRampToValueAtTime(f0 * 0.975, t + dur);

    // — Source B: slightly detuned sawtooth (adds chorus warmth) —
    const oscB = ctx.createOscillator();
    oscB.type = 'sawtooth';
    oscB.frequency.setValueAtTime(f0 * 1.007, t);  // ~12 cents sharp
    const gB = ctx.createGain();
    gB.gain.value = 0.45;

    // — Source C: bandpass-filtered noise (breathiness / aspiration) —
    const noise = ctx.createBufferSource();
    noise.buffer     = getMumbleNoise(ctx);
    noise.loop       = true;
    noise.loopStart  = Math.random() * 1.8;
    const noiseBP    = ctx.createBiquadFilter();
    noiseBP.type     = 'bandpass';
    noiseBP.frequency.value = f1 * 0.65;  // below F1 — body breath sound
    noiseBP.Q.value  = 1.2;
    const gNoise     = ctx.createGain();
    gNoise.gain.value = 0.14;

    // — Formant filters (softer Q = smoother, less electronic) —
    const bp1 = ctx.createBiquadFilter();
    bp1.type = 'bandpass';
    bp1.frequency.value = f1;
    bp1.Q.value = 2.8;

    const bp2 = ctx.createBiquadFilter();
    bp2.type = 'bandpass';
    bp2.frequency.value = f2;
    bp2.Q.value = 3.2;
    const gF2 = ctx.createGain();
    gF2.gain.value = 0.32;

    // — Gentle high shelf roll-off (lip radiation: de-emphasise harsh highs) —
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 3200;
    shelf.gain.value = -9;   // −9 dB above 3.2 kHz

    // — Amplitude envelope: 18 ms attack, brief sustain, 28 ms release —
    const vol = Math.max(0.001, MUMBLE_VOLUME * mumbleTuning.volume);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.001, t);
    env.gain.exponentialRampToValueAtTime(vol, t + 0.018);
    env.gain.setValueAtTime(vol, t + Math.max(0.022, dur - 0.028));
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);

    // — Signal routing —
    // Tonal sources → formants → env
    oscA.connect(bp1); oscA.connect(bp2);
    oscB.connect(gB);  gB.connect(bp1); gB.connect(bp2);
    bp1.connect(env);
    bp2.connect(gF2);  gF2.connect(env);
    // Noise bypasses formants (aspiration sits beneath the tone)
    noise.connect(noiseBP); noiseBP.connect(gNoise); gNoise.connect(env);
    // Final: env → shelf roll-off → output
    env.connect(shelf);
    shelf.connect(mumbleMaster || ctx.destination);

    oscA.start(t); oscA.stop(t + dur + 0.01);
    oscB.start(t); oscB.stop(t + dur + 0.01);
    noise.start(t); noise.stop(t + dur + 0.01);
  }

  // ─── DOM refs ────────────────────────────────────────────────────────────────
  const stage       = document.getElementById('stage');
  const canvas      = document.getElementById('canvas');
  const videoScreen = document.getElementById('videoScreen');
  const sceneVideo  = document.getElementById('sceneVideo');
  const videoOverlay = document.getElementById('videoOverlay');
  const chatScreen  = document.getElementById('chatScreen');
  const chatCanvas  = document.getElementById('chatCanvas');
  const chatThread  = document.getElementById('chatThread');
  const chatForm    = document.getElementById('chatForm');
  const chatInput   = document.getElementById('chatInput');
  const memoryScreen = document.getElementById('memoryScreen');
  const memoryRoomBg = document.getElementById('memoryRoomBg');
  const memoryObjects = document.getElementById('memoryObjects');
  const memoryCaption = document.getElementById('memoryCaption');
  const memoryWhisper = document.getElementById('memoryWhisper');
  const memoryEli = document.getElementById('memoryEli');
  const memoryHeart = document.getElementById('memoryHeart');
  const memoryHoldProgress = document.getElementById('memoryHoldProgress');
  const messageEl   = document.getElementById('message');
  const fadeEl      = document.getElementById('fade');
  let stableViewportWidth = 0;
  let stableViewportHeight = 0;
  let resizeFrame = null;

  // ─── Mute ────────────────────────────────────────────────────────────────────
  // All scene audio goes through makeAudio() so one toggle silences everything,
  // including the synthesized mumble voice and video.
  let muted = false;
  try { muted = localStorage.getItem('eli.muted') === '1'; } catch {}
  const trackedAudios = [];

  function makeAudio(url) {
    const a = new Audio(url);
    a.muted = muted;
    trackedAudios.push(a);
    if (trackedAudios.length > 60) trackedAudios.splice(0, trackedAudios.length - 60);
    return a;
  }

  function applyMute() {
    for (const a of trackedAudios) a.muted = muted;
    if (sceneVideo) sceneVideo.muted = muted;
    if (mumbleMaster) mumbleMaster.gain.value = muted ? 0 : 0.9;
    const btn = document.getElementById('muteBtn');
    if (btn) { btn.textContent = muted ? '🔇' : '🔊'; btn.classList.toggle('is-muted', muted); }
  }

  (function initMute() {
    const btn = document.getElementById('muteBtn');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      muted = !muted;
      try { localStorage.setItem('eli.muted', muted ? '1' : '0'); } catch {}
      applyMute();
    });
    applyMute();
  })();

  function viewportSize() {
    // On desktop (≥600px) with phone shell active: use the phone-screen element's
    // actual rect so Rive canvas, CSS vars, and text layout match the frame.
    // Skip this when shell=0 strips the frame (data-shell="none").
    const noShell = document.documentElement.getAttribute('data-shell') === 'none';
    const phoneScreen = document.getElementById('phoneScreen');
    if (!noShell && phoneScreen && window.innerWidth >= 600) {
      const rect = phoneScreen.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        stableViewportWidth  = Math.round(rect.width);
        stableViewportHeight = Math.round(rect.height);
        return { width: stableViewportWidth, height: stableViewportHeight,
                 visualHeight: stableViewportHeight, visualTop: 0 };
      }
    }
    // Mobile path — track stable dimensions across keyboard show/hide
    const vv = window.visualViewport;
    const layoutWidth = Math.round(window.innerWidth || document.documentElement.clientWidth || vv?.width || 1);
    const layoutHeight = Math.round(window.innerHeight || document.documentElement.clientHeight || vv?.height || 1);
    const visualWidth = Math.round(vv?.width || layoutWidth);
    const visualHeight = Math.round(vv?.height || layoutHeight);
    stableViewportWidth = Math.max(stableViewportWidth, layoutWidth, visualWidth);
    stableViewportHeight = Math.max(stableViewportHeight, layoutHeight, visualHeight);

    return {
      width: stableViewportWidth,
      height: stableViewportHeight,
      visualHeight,
      visualTop: Math.round(vv?.offsetTop || 0),
    };
  }

  function syncViewportVars() {
    const size = viewportSize();
    const keyboardOffset = Math.max(0, size.height - size.visualHeight - size.visualTop);
    document.documentElement.style.setProperty('--app-width', `${size.width}px`);
    document.documentElement.style.setProperty('--app-height', `${size.height}px`);
    document.documentElement.style.setProperty('--keyboard-offset', `${keyboardOffset}px`);
  }

  function sizeCanvasToViewport(targetCanvas) {
    const size = viewportSize();
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    targetCanvas.width = Math.max(1, Math.round(size.width * scale));
    targetCanvas.height = Math.max(1, Math.round(size.height * scale));
  }

  // ─── Boot ────────────────────────────────────────────────────────────────────
  // Live time for phone status bar
  (function initPhoneTime() {
    const el = document.getElementById('phoneTime');
    if (!el) return;
    function tick() {
      const d = new Date();
      el.textContent = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    tick();
    setInterval(tick, 30000);
  })();

  window.addEventListener('load', boot);

  async function boot() {
    showMessage('');
    try {
      const res = await fetch(freshUrl(`${gameBase}/sequence.json`), fetchOpts);
      sequence = res.ok ? await res.json() : { scenes: [], start: null };
    } catch { sequence = { scenes: [], start: null }; }
    applyMumbleTuning(sequence.mumble);

    let resume = null;
    if (!devMode) { try { resume = localStorage.getItem(PROGRESS_KEY); } catch {} }
    if (resume && !(sequence.scenes || []).includes(resume)) resume = null;

    const first = startScene || resume || sequence.start || (sequence.scenes && sequence.scenes[0]) || null;
    if (!first) { showMessage('No scenes yet. Open the editor to get started.', true); return; }
    await loadScene(first);
  }

  // ─── Asset loading & prefetch ────────────────────────────────────────────────
  // Rive buffers are cached as promises so a prefetch and a scene load of the
  // same file share one download. LRU-capped so long sessions can't grow forever.
  function getRiveBuffer(path) {
    if (riveBufferCache.has(path)) {
      const hit = riveBufferCache.get(path);
      riveBufferCache.delete(path);       // re-insert as most recently used
      riveBufferCache.set(path, hit);
      return hit;
    }
    const promise = fetch(freshUrl(path), fetchOpts)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .catch(err => {
        riveBufferCache.delete(path);     // never cache failures
        throw err;
      });
    riveBufferCache.set(path, promise);
    while (riveBufferCache.size > RIVE_CACHE_MAX) {
      riveBufferCache.delete(riveBufferCache.keys().next().value);
    }
    return promise;
  }

  async function fetchSceneConfig(id) {
    if (!devMode && sceneConfigCache.has(id)) return sceneConfigCache.get(id);
    try {
      const res = await fetch(freshUrl(sceneAssetUrl(id, 'scene.json')), fetchOpts);
      if (!res.ok) return null;
      const config = await res.json();
      if (!devMode) sceneConfigCache.set(id, config);
      return config;
    } catch { return null; }
  }

  function riveFilePath(config) {
    if (!config.rive) return null;
    return config.rive === 'shared' ? './public/rive/eli.riv' : sceneAssetUrl(config.id, config.rive);
  }

  function candidateNextScenes(config) {
    const ids = new Set();
    if (config.after?.next) ids.add(config.after.next);
    for (const r of getCtaRoutes(config)) ids.add(r.next);
    const seqNext = nextInSequence(config.id);
    if (seqNext) ids.add(seqNext);
    ids.delete(config.id);
    return [...ids].slice(0, 3);
  }

  // Warm caches for the scenes reachable from the current one so transitions
  // don't stall on downloads. Fire-and-forget; game mode only (the editor
  // preview must always see freshly uploaded files).
  function prefetchNextScenes(config) {
    if (devMode) return;
    for (const id of candidateNextScenes(config)) {
      fetchSceneConfig(id).then(next => {
        if (!next) return;
        const rivePath = riveFilePath(next);
        if (rivePath) getRiveBuffer(rivePath).catch(() => {});
        const firstVoice = Array.isArray(next.segments) && next.segments.length
          ? next.segments[0]?.voice
          : getVoiceFile(next);
        const warm = [firstVoice, ...getBgFiles(next)].filter(Boolean).slice(0, 3);
        for (const f of warm) {
          fetch(sceneAssetUrl(next.id, `audio/${f}`)).then(r => r.ok && r.blob()).catch(() => {});
        }
      }).catch(() => {});
    }
  }

  // ─── Scene loader ────────────────────────────────────────────────────────────
  async function loadScene(id) {
    // If a load is already in flight, remember the request instead of dropping it
    // (e.g. an auto-advance fired synchronously during another scene's setup).
    if (sceneLoading) { pendingSceneId = id; return; }
    sceneLoading = true;
    fadeEl.classList.add('is-loading');
    try {
      if (navPollFrame) { cancelAnimationFrame(navPollFrame); navPollFrame = null; }
      if (hapticPollFrame) { cancelAnimationFrame(hapticPollFrame); hapticPollFrame = null; }
      if (segmentCleanup) { segmentCleanup(); segmentCleanup = null; }
      if (activeLipSyncAudio) { activeLipSyncAudio.pause(); activeLipSyncAudio = null; }
      stopLipSync();
      clearSceneTapListeners();
      for (const a of activeSegmentBgs) a.pause();
      activeSegmentBgs = [];
      activeSegmentBgNames = [];
      for (const a of activeBgAudios) a.pause();
      activeBgAudios = [];
      if (window._chatCleanup) { window._chatCleanup(); window._chatCleanup = null; }
      if (activeMemoryCleanup) { activeMemoryCleanup(); activeMemoryCleanup = null; }
      clearHeartZone();
      hideHeartPrompt();
      hideSegmentChat();
      currentSceneId = id;
      await fadeOut();

      const config = await fetchSceneConfig(id);

      if (!config) { fadeIn(); showMessage(`Scene "${id}" not found.`, true); return; }

      if (!devMode) { try { localStorage.setItem(PROGRESS_KEY, id); } catch {} }

      hideAll();

      if (config.type === 'rive')  await playRiveScene(config);
      if (config.type === 'video') await playVideoScene(config);
      if (config.type === 'chat')  await playChatScene(config);
      if (config.type === 'memory') await playMemoryScene(config);

      updateCtaButton(config);
      // Segment scenes install their own effective zone in playSegment().
      // Avoid replacing it with the legacy scene-level zone after loading.
      if (!(Array.isArray(config.segments) && config.segments.length)) setupHeartZone(config);
      prefetchNextScenes(config);
    } finally {
      sceneLoading = false;
      fadeEl.classList.remove('is-loading');
      if (pendingSceneId && pendingSceneId !== currentSceneId) {
        const next = pendingSceneId;
        pendingSceneId = null;
        loadScene(next);
      } else {
        pendingSceneId = null;
      }
    }
  }

  // ─── Rive scene ──────────────────────────────────────────────────────────────
  async function playRiveScene(config) {
    stage.style.display = 'block';
    showMessage('');

    if (!config.rive) {
      fadeIn(); showMessage('No Rive file set for this scene. Upload one in the editor.', true); return;
    }

    const rivePath = riveFilePath(config);

    let buffer;
    try {
      buffer = await getRiveBuffer(rivePath);
    } catch (err) {
      fadeIn();
      showMessage(`Failed to load Rive file "${config.rive}" — upload it in the editor. (${err.message})`, true);
      return;
    }

    if (riveInstance) { try { riveInstance.cleanup(); } catch {} riveInstance = null; }

    if (typeof rive === 'undefined' || !rive.Rive) {
      fadeIn();
      showMessage('Error: Rive script failed to load. Check your internet connection and reload.', true);
      return;
    }

    const isSharedRive = config.rive === 'shared';
    const smNames = Array.isArray(config.stateMachines) && config.stateMachines.length
      ? config.stateMachines
      : isSharedRive ? ['EliState', 'EliBody', 'FacialState', 'EmotionState', 'AyesMovements'] : [];

    syncViewportVars();
    sizeCanvasToViewport(canvas);

    let riveLoaded = false;
    const riveTimeout = setTimeout(() => {
      if (!riveLoaded) {
        fadeIn();
        showMessage('Rive is taking too long — check the browser console for errors.', true);
      }
    }, 15000);

    const artboard  = config.artboard  || undefined;
    const fitMode   = config.fit === 'contain' ? rive.Fit.Contain : rive.Fit.Cover;

    // Attempt ladder: 0 = as configured · 1 = drop state machines · 2 = bare.
    // Stale names (renamed in Rive Studio) abort the load entirely, so degrade
    // gracefully instead of showing a black screen.
    let initAttempt = 0;

    const attemptInit = () => {
      const attempt = initAttempt;
      riveInstance = new rive.Rive({
        buffer,
        canvas,
        ...(attempt < 2 && artboard ? { artboard } : {}),
        autoplay: true,
        fit: fitMode,
        alignment: rive.Alignment.Center,
        useOffscreenRenderer: true,
        ...(attempt === 0 && smNames.length ? { stateMachines: smNames } : {}),
        onLoad: () => {
          riveLoaded = true;
          clearTimeout(riveTimeout);
          resizeCanvas();
          inputByName = collectInputs(attempt === 0 ? smNames : (riveInstance.stateMachineNames || []));
          if (attempt > 0 && devMode) {
            showMessage("⚠ This scene's Artboard/State machines don't match its Rive file — re-pick them in the editor.", true);
          }
          fadeIn();
          applyScenePose(config);
          playVoiceLines(config);

          if (riveInstance.on && rive.EventType?.RiveEvent) {
            riveInstance.on(rive.EventType.RiveEvent, (event) => {
              const name = event?.data?.name;
              if (!name) return;
              handleRiveEvent(name, config);
            });
          }

          if (riveInstance.on && rive.EventType?.StateChange) {
            let smNavigated = false;
            riveInstance.on(rive.EventType.StateChange, (event) => {
              if (smNavigated) return;
              const states = event?.data || [];
              console.log('[nav] StateChange states:', JSON.stringify(states));
              if (states.some(s => String(s).toLowerCase() === 'exit')) {
                smNavigated = true;
                const dest = config.after?.next || nextInSequence(config.id);
                console.log('[nav] SM exit detected → navigating to', dest);
                if (dest) loadScene(dest);
              }
            });
          }

          // Poll haptic inputs — any boolean input starting with haptic_ or named vabiration/vibration
          const hapticInputNames = [...inputByName.keys()].filter(n =>
            n.startsWith('haptic_') || n === 'vabiration' || n === 'vibration'
          );
          if (hapticInputNames.length) {
            const pollHaptic = () => {
              for (const name of hapticInputNames) {
                const inp = inputByName.get(name);
                if (inp && inp.value === true) {
                  inp.value = false;
                  const preset = name.startsWith('haptic_') ? name.slice(7) : 'heartbeat';
                  playHaptic(preset);
                }
              }
              hapticPollFrame = requestAnimationFrame(pollHaptic);
            };
            hapticPollFrame = requestAnimationFrame(pollHaptic);
          }

          // Poll nav inputs for scene transitions
          const navTrigger = config.after?.trigger;
          const staticTriggers = new Set(['auto', 'tap_heart', 'ended', 'never', '', null, undefined]);
          const routeNames = getCtaRoutes(config).map(r => r.name);
          for (const inputName of inputByName.keys()) {
            if (inputName.startsWith('nav_') && !routeNames.includes(inputName)) {
              routeNames.push(inputName);
            }
          }
          if (navTrigger && !staticTriggers.has(navTrigger) && !routeNames.includes(navTrigger)) {
            routeNames.push(navTrigger);
          }
          if (routeNames.length || inputByName.size) {
            let didNavigate = false;
            const pollNav = () => {
              if ((activeLipSyncAudio && !activeLipSyncAudio.paused && !activeLipSyncAudio.ended) ||
                  segmentCleanup) {
                navPollFrame = requestAnimationFrame(pollNav);
                return;
              }
              // Boolean / trigger inputs
              for (const name of routeNames) {
                const inp = getInputByRouteName(name);
                if (isNavigationInputActive(inp)) {
                  didNavigate = true;
                  navPollFrame = null;
                  handleRiveEvent(name, config);
                  return;
                }
              }
              // Number inputs: Nex_scne=1 routes via connection key "Nex_scne_1"
              for (const [inputName, inp] of inputByName) {
                if (typeof inp.value === 'number' && inp.value > 0) {
                  const routeKey = `${inputName}_${Math.round(inp.value)}`;
                  if (getCtaDestination(routeKey, config)) {
                    didNavigate = true;
                    navPollFrame = null;
                    handleRiveEvent(routeKey, config);
                    return;
                  }
                }
              }
              if (didNavigate) return;
              navPollFrame = requestAnimationFrame(pollNav);
            };
            navPollFrame = requestAnimationFrame(pollNav);
          }
        },
        onLoadError: (err) => {
          if (initAttempt < 2) {
            initAttempt++;
            try { riveInstance && riveInstance.cleanup(); } catch {}
            attemptInit();
            return;
          }
          riveLoaded = true;
          clearTimeout(riveTimeout);
          fadeIn();
          showMessage(`Rive error: ${err?.message || err?.type || JSON.stringify(err) || 'unknown — check browser console'}`, true);
        },
      });
    };

    try {
      attemptInit();
    } catch (err) {
      clearTimeout(riveTimeout);
      fadeIn();
      showMessage(`Rive init failed: ${err?.message || err}`, true);
    }

    if (config.after?.trigger === 'tap_heart') {
      addSceneTapListener(canvas, () => handleInteraction('tap_heart', config));
    }
  }

  // ─── Rive helpers ──────────────────────────────────────────────────────────────
  function collectInputs(smNames) {
    const map = new Map();
    if (!riveInstance) return map;
    const names = smNames || riveInstance.stateMachineNames || [];
    for (const sm of names) {
      try {
        for (const input of (riveInstance.stateMachineInputs(sm) || [])) {
          map.set(input.name, input);
          // Tolerate stray trailing colons/whitespace typed in Rive Studio
          // (e.g. an input named "is_speaking:") — register a cleaned alias
          // so lookups by the intended name still hit.
          const cleaned = input.name.trim().replace(/[:\s]+$/, '');
          if (cleaned && cleaned !== input.name && !map.has(cleaned)) map.set(cleaned, input);
        }
      } catch {}
    }
    return map;
  }

  function setInput(name, value) {
    const input = inputByName.get(name);
    if (!input) return;
    if (typeof value === 'boolean') input.value = value;
    else if (input.type === 3) input.fire();
    else input.value = Number(value);
  }

  function applyScenePose(config) {
    const pose = config?.pose || {};
    if (Number.isFinite(pose.mouth_shape))   { setInput('mouth_shape', pose.mouth_shape); setInput('is_speaking', pose.mouth_shape > 0); }
    if (Number.isFinite(pose.emotion_state)) { setInput('emotion_state', pose.emotion_state); setInput('eyes_state', pose.emotion_state); lastEmotion = pose.emotion_state; }
    if (Number.isFinite(pose.body_movement)) { setInput('body_movement', pose.body_movement); setInput('nav_heart', pose.body_movement); }
    if (Number.isFinite(pose.head_movement)) { setInput('head_movement', pose.head_movement); setInput('head_state', pose.head_movement); }
    if (Number.isFinite(pose.heart_state))   setInput('heart_state', pose.heart_state);
  }

  // Each segment may override the scene's starting pose. Reset every animated
  // track before applying it so state left by the previous segment cannot leak
  // into the next one. Scene-level pose values remain the backwards-compatible
  // fallback for segments created before independent poses were supported.
  function applySegmentPose(config, segment) {
    const pose = { ...(config?.pose || {}), ...(segment?.pose || {}) };
    setInput('mouth_shape', Number.isFinite(pose.mouth_shape) ? pose.mouth_shape : 0);
    setInput('is_speaking', Number.isFinite(pose.mouth_shape) && pose.mouth_shape > 0);
    const emotion = Number.isFinite(pose.emotion_state) ? pose.emotion_state : 0;
    setInput('emotion_state', emotion);
    setInput('eyes_state', emotion);
    lastEmotion = emotion;
    const body = Number.isFinite(pose.body_movement) ? pose.body_movement : 0;
    setInput('body_movement', body);
    setInput('nav_heart', body);
    const head = Number.isFinite(pose.head_movement) ? pose.head_movement : 0;
    setInput('head_movement', head);
    setInput('head_state', head);
    setInput('heart_state', Number.isFinite(pose.heart_state) ? pose.heart_state : 0);
  }

  function getInputByRouteName(name) {
    const exact = inputByName.get(name);
    if (exact) return exact;
    const key = normalizeRouteKey(name);
    for (const [inputName, input] of inputByName) {
      if (normalizeRouteKey(inputName) === key) return input;
    }
    return null;
  }

  function isNavigationInputActive(input) {
    if (!input) return false;
    if (input.value === true) return true;
    return typeof input.value === 'number' && input.value > 0;
  }

  // ─── Voice lines ─────────────────────────────────────────────────────────────
  async function playVoiceLines(config) {
    if (Array.isArray(config.segments) && config.segments.length) {
      playSegment(config, 0);
      return;
    }

    const bgFiles = getBgFiles(config);
    for (const bg of bgFiles) {
      const bgAudio = makeAudio(sceneAssetUrl(config.id, `audio/${bg}`));
      bgAudio.volume = 0.65;
      bgAudio.play().catch(() => {});
      activeBgAudios.push(bgAudio);
    }

    const voiceFile = getVoiceFile(config);
    if (!voiceFile) {
      setupAfterTrigger(config);
      return;
    }
    const audioUrl = sceneAssetUrl(config.id, `audio/${voiceFile}`);
    const { markers, textCues } = await fetchLipSyncData(config.id, voiceFile);

    const audio = makeAudio(audioUrl);
    audio.preload = 'auto';
    activeLipSyncAudio = audio;

    audio.onended = () => {
      stopLipSync();
      setInput('mouth_shape', 0);
      setInput('is_speaking', false);
      setupAfterTrigger(config);
    };

    try {
      await audio.play();
      showMessage('');
      applyLipSyncMarkers(audio, markers, textCues);
    } catch (err) {
      showMessage('Tap to play.', false);
      addSceneTapListener(getActiveTapTarget(), async () => {
        for (const a of activeBgAudios) if (a.paused) a.play().catch(() => {});
        await audio.play();
        showMessage('');
        applyLipSyncMarkers(audio, markers, textCues);
      });
    }
  }

  // ─── Segment playback ───────────────────────────────────────────────────────
  const segmentChatEl   = document.getElementById('segmentChat');
  const segChatThread   = document.getElementById('segChatThread');
  const segChatForm     = document.getElementById('segChatForm');
  const segChatInput    = document.getElementById('segChatInput');
  const segChatContinue = document.getElementById('segChatContinue');

  function hideSegmentChat() {
    if (segmentChatEl) { segmentChatEl.classList.remove('is-visible'); segmentChatEl.style.display = 'none'; }
    if (segChatThread) segChatThread.innerHTML = '';
    if (segChatContinue) segChatContinue.style.display = 'none';
  }

  function getActiveTapTarget() {
    return chatScreen.style.display !== 'none' ? chatScreen : canvas;
  }

  async function playSegment(config, index) {
    if (segmentCleanup) { segmentCleanup(); segmentCleanup = null; }
    if (activeLipSyncAudio) { activeLipSyncAudio.pause(); activeLipSyncAudio = null; }
    stopLipSync();
    clearTextOverlay();
    hideSegmentChat();

    if (index >= config.segments.length) {
      for (const a of activeSegmentBgs) a.pause(); activeSegmentBgs = []; activeSegmentBgNames = [];
      setupAfterTrigger(config);
      return;
    }

    const seg = config.segments[index];
    const isLast = index === config.segments.length - 1;

    applySegmentPose(config, seg);
    const segmentZone = Object.prototype.hasOwnProperty.call(seg, 'heartZone')
      ? seg.heartZone
      : config.heartZone;
    setupHeartZone(config, segmentZone);
    updateSegmentCta(config, index);

    // Segment background audio — supports multiple simultaneous tracks via seg.bgs array
    // Backwards-compatible: seg.bg (string) still works as a single-item array
    const newBgList = Array.isArray(seg.bgs) ? seg.bgs : (seg.bg ? [seg.bg] : []);
    const newBgKey  = newBgList.join('|');
    const oldBgKey  = activeSegmentBgNames.join('|');
    if (newBgKey !== oldBgKey) {
      for (const a of activeSegmentBgs) a.pause();
      activeSegmentBgs = [];
      activeSegmentBgNames = newBgList;
      for (const file of newBgList) {
        const bgAudio = makeAudio(sceneAssetUrl(config.id, `audio/${file}`));
        bgAudio.loop = true;
        bgAudio.volume = 0.5;
        bgAudio.play().catch(() => {});
        activeSegmentBgs.push(bgAudio);
      }
    }

    if (seg.type === 'chat') {
      playChatSegment(config, index);
      return;
    }

    // Voice segment
    const voiceFile = seg.voice;

    if (!voiceFile) {
      if (isLast) { setupAfterTrigger(config); return; }
      // A silent segment can still be an intentional interactive beat. If it
      // has a CTA or Heart Touch action, leave it active until that interaction
      // moves the story; treating missing audio as already-ended used to skip
      // its independent pose immediately.
      const hasHeartInteraction = segmentZone && ['tap', 'doubleTap', 'hold'].some(key => {
        const action = segmentZone[key];
        return action && (action.heartState !== undefined || action.input || action.next);
      });
      if (hasHeartInteraction || String(seg.cta_label || '').trim()) return;
      waitForSegmentTrigger(config, index);
      return;
    }

    const audioUrl = sceneAssetUrl(config.id, `audio/${voiceFile}`);
    const { markers, textCues } = await fetchLipSyncData(config.id, voiceFile);

    const audio = makeAudio(audioUrl);
    audio.preload = 'auto';
    activeLipSyncAudio = audio;

    audio.onended = () => {
      stopLipSync();
      setInput('mouth_shape', 0);
      setInput('is_speaking', false);
      if (isLast) {
        for (const a of activeSegmentBgs) a.pause(); activeSegmentBgs = []; activeSegmentBgNames = [];
        setupAfterTrigger(config);
        return;
      }
      waitForSegmentTrigger(config, index);
    };

    try {
      await audio.play();
      showMessage('');
      applyLipSyncMarkers(audio, markers, textCues);
    } catch (err) {
      showMessage('Tap to play.', false);
      addSceneTapListener(getActiveTapTarget(), async () => {
        for (const a of activeSegmentBgs) if (a.paused) a.play().catch(() => {});
        await audio.play();
        showMessage('');
        applyLipSyncMarkers(audio, markers, textCues);
      });
    }
  }

  function advanceSegment(config, index) {
    const seg = config.segments[index];
    if (seg.sfx) {
      const sfx = makeAudio(sceneAssetUrl(config.id, `audio/${seg.sfx}`));
      sfx.play().catch(() => {});
    }
    const delay = Number(seg.delay) || 0;
    if (delay > 0) {
      const timer = setTimeout(() => playSegment(config, index + 1), delay * 1000);
      segmentCleanup = () => clearTimeout(timer);
    } else {
      playSegment(config, index + 1);
    }
  }

  function waitForSegmentTrigger(config, index) {
    const seg = config.segments[index];
    const trigger = seg.trigger || 'ended';

    if (trigger === 'ended' || trigger === 'auto') {
      advanceSegment(config, index);
      return;
    }

    if (seg.message) showMessage(seg.message, false);

    if (trigger === 'tap_heart') {
      const tapTarget = getActiveTapTarget();
      const handler = () => advanceSegment(config, index);
      tapTarget.addEventListener('pointerup', handler, { once: true });
      segmentCleanup = () => tapTarget.removeEventListener('pointerup', handler);
      return;
    }

    // Poll a Rive input
    let pollFrame = null;
    const poll = () => {
      const inp = getInputByRouteName(trigger);
      if (isNavigationInputActive(inp)) {
        pollFrame = null;
        if (inp) inp.value = typeof inp.value === 'boolean' ? false : 0;
        advanceSegment(config, index);
        return;
      }
      pollFrame = requestAnimationFrame(poll);
    };
    pollFrame = requestAnimationFrame(poll);
    segmentCleanup = () => { if (pollFrame) cancelAnimationFrame(pollFrame); };
  }

  // ─── Chat segment ───────────────────────────────────────────────────────────
  async function playChatSegment(config, index) {
    const seg = config.segments[index];
    const isLast = index === config.segments.length - 1;
    const maxExchanges = seg.max_exchanges || 0;
    let exchangeCount = 0;
    let localMessages = [];

    segmentChatEl.style.display = 'flex';
    segmentChatEl.classList.remove('is-visible');
    segChatThread.innerHTML = '';
    segChatContinue.style.display = 'none';
    segChatInput.closest('form').style.display = '';
    requestAnimationFrame(() => requestAnimationFrame(() => segmentChatEl.classList.add('is-visible')));

    const useMumble = seg.mumble === true;

    if (seg.opening) {
      showTextOverlay(seg.opening, 8, { fontSize: 28, color: '#C1A376', position: 'caption', fontWeight: '700', mumble: useMumble });
      localMessages.push({ role: 'assistant', content: seg.opening });
    }

    let tornDown = false;
    function teardownChatUI() {
      if (tornDown) return;
      tornDown = true;
      segChatContinue.removeEventListener('click', continueHandler);
      segChatForm.removeEventListener('submit', formHandler);
      voiceCleanup();
      if (activeRecognition) { try { activeRecognition.stop(); } catch {} activeRecognition = null; }
      hideSegmentChat();
    }

    function finishChat() {
      teardownChatUI();
      if (isLast) { setupAfterTrigger(config); return; }
      waitForSegmentTrigger(config, index);
    }

    const continueHandler = () => finishChat();
    segChatContinue.addEventListener('click', continueHandler, { once: true });

    const eliThinkingSeg = document.getElementById('eliThinkingSeg');

    function showThinkingSeg() {
      if (eliThinkingSeg) eliThinkingSeg.style.display = 'block';
      segChatInput.disabled = true;
    }

    function hideThinkingSeg() {
      if (eliThinkingSeg) eliThinkingSeg.style.display = 'none';
      segChatInput.disabled = false;
    }

    async function sendChatMessage(text) {
      if (!text) return;
      removeSegSuggestions();
      segChatInput.value = '';
      segChatInput.placeholder = '...';
      localMessages.push({ role: 'user', content: text });
      exchangeCount++;

      showThinkingSeg();
      try {
        const extra = seg.context_hint ? `\n\nCONTEXT HINT FOR THIS MOMENT: ${seg.context_hint}` : '';
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: localMessages, context_hint: extra, game: gameId || undefined }),
        });
        hideThinkingSeg();
        const data = res.ok ? await res.json() : { reply: '...' };
        const reply = data.reply || '...';
        localMessages.push({ role: 'assistant', content: reply });

        showTextOverlay(reply, 8, { fontSize: 28, color: '#C1A376', position: 'caption', fontWeight: '700', mumble: useMumble });

        if (data.vitals) applyVitals(data.vitals);
        if (data.emotion) applyEmotion(data.emotion);
        if (data.body) applyBody(data.body);

        if (data.needs_comfort) {
          segChatInput.closest('form').style.display = 'none';
          showHeartPrompt(() => {
            segChatInput.closest('form').style.display = '';
            sendChatMessage('[The player touched your heart gently]');
          });
          return;
        }

        if (maxExchanges > 0 && exchangeCount >= maxExchanges) {
          setTimeout(() => finishChat(), 3000);
          return;
        }

        if (data.suggested_responses?.length) {
          segChatInput.placeholder = data.suggested_responses.join(', ');
        } else {
          segChatInput.placeholder = 'Say something to Eli...';
        }
      } catch {
        hideThinkingSeg();
        showTextOverlay('...', 3, { fontSize: 28, color: '#C1A376', position: 'caption', fontWeight: '700', mumble: useMumble });
        segChatInput.placeholder = 'Say something to Eli...';
      }
    }

    // Unlock on touchstart of the send button — fires before submit, always a real iOS gesture
    const segSendBtn = segChatForm.querySelector('.chat-card__btn--send');
    if (segSendBtn) segSendBtn.addEventListener('touchstart', ensureMumbleUnlocked, { passive: true });

    const formHandler = (e) => {
      e.preventDefault();
      ensureMumbleUnlocked();
      sendChatMessage(segChatInput.value.trim());
    };
    segChatForm.addEventListener('submit', formHandler);
    const voiceCleanup = setupVoiceButton(document.getElementById('segVoiceBtn'), segChatInput, sendChatMessage);
    segmentCleanup = teardownChatUI;

    if (!seg.opening && seg.suggested_starters?.length) {
      showSegSuggestions(seg.suggested_starters, sendChatMessage);
    }
  }

  function showSegSuggestions(options, onSelect) {
    removeSegSuggestions();
    const wrap = document.createElement('div');
    wrap.className = 'chat-suggestions';
    wrap.id = 'segSuggestions';
    for (const text of options) {
      const btn = document.createElement('button');
      btn.className = 'chat-suggestion';
      btn.textContent = text;
      btn.addEventListener('click', () => onSelect(text));
      wrap.appendChild(btn);
    }
    segChatThread.appendChild(wrap);
    segChatThread.scrollTop = segChatThread.scrollHeight;
  }

  function removeSegSuggestions() {
    const el = document.getElementById('segSuggestions');
    if (el) el.remove();
  }

  function getVoiceFile(config) {
    const files = config.files || {};
    return Object.keys(files).find(f => files[f] === 'voice') || null;
  }

  function getBgFiles(config) {
    const files = config.files || {};
    return Object.keys(files).filter(f => files[f] === 'bg');
  }

  // ─── Scene transitions ───────────────────────────────────────────────────────
  function setupAfterTrigger(config) {
    const after = config.after || {};
    if (after.trigger === 'never') {
      if (after.message) showMessage(after.message, false);
      return;
    }
    if (after.trigger === 'auto' || after.trigger === 'ended' || !after.trigger) {
      if (after.next) {
        loadScene(after.next);
      } else if (after.message) {
        showMessage(after.message, false);
      }
      return;
    }
    showMessage(after.message || '', false);
    addSceneTapListener(getActiveTapTarget(), () => {
      if (after.next) loadScene(after.next);
    });
  }

  function handleRiveEvent(name, config) {
    // Rive events named haptic_<preset> vibrate instead of navigating —
    // author them in Rive Studio at the exact frame you want the pulse.
    if (name.startsWith('haptic_')) { playHaptic(name.slice(7)); return; }

    const ctaDest = getCtaDestination(name, config);
    if (ctaDest) { loadScene(ctaDest); return; }
    if (name === 'tap_heart' || name === 'hit_heart') { handleInteraction('tap_heart', config); return; }
    if (name.startsWith('goto_')) { loadScene(name.slice(5)); return; }
    const after = config.after || {};
    if (after.trigger && name === after.trigger) {
      const dest = after.next || nextInSequence(config.id);
      if (dest) { loadScene(dest); return; }
    }
    if (sequence && sequence.scenes && sequence.scenes.includes(name)) {
      loadScene(name);
    }
  }

  function nextInSequence(id) {
    const scenes = sequence?.scenes || [];
    const idx = scenes.indexOf(id);
    return idx >= 0 && idx + 1 < scenes.length ? scenes[idx + 1] : null;
  }

  // ─── CTA button ───────────────────────────────────────────────────────────────
  // A tappable button at the bottom of the screen. Scene-level: cta { label,
  // next }. Segment-level: seg.cta_label / seg.cta_next — empty cta_next means
  // "advance to the next segment" (or the scene fallback on the last one).
  let ctaButtonEl = null;

  // hold=true: the button must be pressed and held (~1.1s) — the pill fills
  // while held and releasing early cancels. Matches the game's presence verb.
  function showCta(label, action, hold = false) {
    if (ctaButtonEl) ctaButtonEl.remove();   // fresh node = no stale listeners
    ctaButtonEl = document.createElement('button');
    ctaButtonEl.className = 'scene-cta';
    ctaButtonEl.type = 'button';
    ctaButtonEl.textContent = label;
    document.getElementById('phoneScreen')?.appendChild(ctaButtonEl);

    if (!hold) {
      ctaButtonEl.onclick = action;
    } else {
      let holdTimer = null;
      const cancel = () => {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        ctaButtonEl.classList.remove('is-holding');
      };
      ctaButtonEl.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        ctaButtonEl.classList.add('is-holding');
        holdTimer = setTimeout(() => {
          cancel();
          if (navigator.vibrate) { try { navigator.vibrate(30); } catch {} }
          action();
        }, 1100);
      });
      ctaButtonEl.addEventListener('pointerup', cancel);
      ctaButtonEl.addEventListener('pointercancel', cancel);
      ctaButtonEl.addEventListener('pointerleave', cancel);
      ctaButtonEl.oncontextmenu = (e) => e.preventDefault();   // long-press menu would break the hold
    }
    // Element was just inserted — let the browser paint once so the fade-in runs
    requestAnimationFrame(() => requestAnimationFrame(() => ctaButtonEl.classList.add('is-visible')));
  }

  function hideCta() {
    if (!ctaButtonEl) return;
    ctaButtonEl.classList.remove('is-visible');
    ctaButtonEl.onclick = null;
  }

  function updateCtaButton(config) {
    const cta = config.cta;
    const label = String(cta?.label || '').trim();
    if (!label) { hideCta(); return; }
    showCta(label, () => {
      const dest = cta.next || config.after?.next || nextInSequence(config.id);
      if (dest) loadScene(dest);
      else showMessage('The story ends here — for now.');
    }, cta.hold === true);
  }

  // Called at the start of every segment. A segment's own CTA wins; without
  // one the scene-level CTA (if any) applies.
  function updateSegmentCta(config, index) {
    const seg = config.segments?.[index];
    if (!seg) return;
    const label = String(seg.cta_label || '').trim();
    if (!label) { updateCtaButton(config); return; }
    showCta(label, () => {
      if (segmentCleanup) { segmentCleanup(); segmentCleanup = null; }
      if (activeLipSyncAudio) { activeLipSyncAudio.pause(); activeLipSyncAudio = null; }
      stopLipSync();
      hideSegmentChat();
      if (seg.cta_next) { loadScene(seg.cta_next); return; }
      const isLast = index === config.segments.length - 1;
      if (!isLast) { playSegment(config, index + 1); return; }
      const dest = config.after?.next || nextInSequence(config.id);
      if (dest) loadScene(dest);
      else showMessage('The story ends here — for now.');
    }, seg.cta_hold === true);
  }

  // Fire a Rive input by name regardless of its type: booleans go true,
  // triggers fire, numbers get 1.
  function fireNamedInput(name) {
    const inp = getInputByRouteName(name);
    if (!inp) return;
    try {
      if (typeof inp.value === 'boolean') inp.value = true;
      else if (typeof inp.fire === 'function') inp.fire();
      else inp.value = 1;
    } catch {}
  }

  // ─── Heart touch zone ────────────────────────────────────────────────────────
  // An invisible circular hit area over Eli's heart (position/size are % of
  // the stage, set in the editor). Recognizes tap, double-tap, and hold — each
  // maps to an action: set heart_state, fire a Rive input, and/or go to a
  // scene. The Rive file owns how the heart LOOKS; this owns how it FEELS.
  let heartZoneEl = null;
  let heartZoneTimers = [];

  function clearHeartZone() {
    for (const t of heartZoneTimers) clearTimeout(t);
    heartZoneTimers = [];
    if (heartZoneEl) { heartZoneEl.remove(); heartZoneEl = null; }
  }

  function fireHeartAction(action, config) {
    if (!action) return;
    const hs = Number(action.heartState);
    if (action.heartState !== '' && action.heartState !== undefined && action.heartState !== null && Number.isFinite(hs)) {
      setInput('heart_state', hs);
    }
    if (action.input) fireNamedInput(String(action.input));
    if (navigator.vibrate) { try { navigator.vibrate(25); } catch {} }
    if (action.next) {
      const destination = String(action.next);
      const segmentMatch = destination.match(/^@segment:(\d+)$/);
      if (segmentMatch && Array.isArray(config.segments)) {
        const index = Number(segmentMatch[1]);
        if (index >= 0 && index < config.segments.length) playSegment(config, index);
      } else {
        // Existing scene IDs remain plain strings, preserving old configs.
        loadScene(destination);
      }
    }
  }

  function setupHeartZone(config, zone = config.heartZone) {
    clearHeartZone();
    if (config.type !== 'rive') return;
    const hz = zone;
    if (!hz) return;
    const gTap  = hz.tap && (hz.tap.heartState !== undefined || hz.tap.input || hz.tap.next) ? hz.tap : null;
    const gDbl  = hz.doubleTap && (hz.doubleTap.heartState !== undefined || hz.doubleTap.input || hz.doubleTap.next) ? hz.doubleTap : null;
    const gHold = hz.hold && (hz.hold.heartState !== undefined || hz.hold.input || hz.hold.next) ? hz.hold : null;
    if (!gTap && !gDbl && !gHold) return;

    const x = Number(hz.x) || 50, y = Number(hz.y) || 62, size = Number(hz.size) || 24;
    heartZoneEl = document.createElement('div');
    heartZoneEl.className = 'heart-zone';
    Object.assign(heartZoneEl.style, {
      left: `${x}%`,
      top: `${y}%`,
      width: `${size}%`,
    });
    heartZoneEl.oncontextmenu = (e) => e.preventDefault();
    // ?zones=1 → draw the zone so it can be positioned precisely
    if (new URLSearchParams(location.search).get('zones') === '1') heartZoneEl.classList.add('heart-zone--debug');
    stage.appendChild(heartZoneEl);

    let holdTimer = null;
    let tapTimer  = null;
    let lastTapAt = 0;

    heartZoneEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (gHold) {
        const dur = Math.max(0.3, Number(gHold.duration) || 3);
        holdTimer = setTimeout(() => { holdTimer = null; fireHeartAction(gHold, config); }, dur * 1000);
        heartZoneTimers.push(holdTimer);
      }
    });

    const cancelHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };

    heartZoneEl.addEventListener('pointerup', (e) => {
      e.stopPropagation();
      const held = gHold && !holdTimer;   // hold already fired for this press
      cancelHold();
      if (held) return;
      const now = performance.now();
      if (gDbl && now - lastTapAt < 340) {
        if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
        lastTapAt = 0;
        fireHeartAction(gDbl, config);
        return;
      }
      lastTapAt = now;
      if (gTap) {
        if (gDbl) {
          // wait long enough to be sure it isn't the first half of a double-tap
          tapTimer = setTimeout(() => { tapTimer = null; fireHeartAction(gTap, config); }, 350);
          heartZoneTimers.push(tapTimer);
        } else {
          fireHeartAction(gTap, config);
        }
      }
    });

    heartZoneEl.addEventListener('pointercancel', cancelHold);
    heartZoneEl.addEventListener('pointerleave', cancelHold);
  }

  function handleInteraction(type, config) {
    const ctaDest = getCtaDestination(type, config);
    if (ctaDest) { loadScene(ctaDest); return; }
    const after = config.after || {};
    if (after.trigger === type && after.next) {
      loadScene(after.next);
    }
  }

  function getCtaRoutes(config) {
    const result = [];
    const routes = config.routes && typeof config.routes === 'object' ? config.routes : {};
    for (const [name, next] of Object.entries(routes)) {
      if (name && next) result.push({ name: String(name).trim(), next: String(next).trim() });
    }
    if (Array.isArray(config.ctaRoutes)) {
      for (const r of config.ctaRoutes) {
        const name = String(r?.name || '').trim();
        const next = String(r?.next || '').trim();
        if (name && next && !result.find(x => normalizeRouteKey(x.name) === normalizeRouteKey(name))) {
          result.push({ name, next });
        }
      }
    }
    return result;
  }

  function getCtaDestination(name, config) {
    const key = normalizeRouteKey(name);
    if (!key) return null;
    const match = getCtaRoutes(config).find(r => normalizeRouteKey(r.name) === key);
    if (match) return match.next;
    if (name.startsWith('nav_')) {
      const dest = name.slice(4);
      if (sequence?.scenes?.includes(dest)) return dest;
    }
    return null;
  }

  function normalizeRouteKey(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  // ─── Lip sync ─────────────────────────────────────────────────────────────────
  async function fetchLipSyncData(sceneId, voiceFile) {
    const baseName = voiceFile.replace(/\.[^.]+$/, '');
    try {
      const res = await fetch(freshUrl(sceneAssetUrl(sceneId, `audio/${baseName}.lipsync.json`)), fetchOpts);
      if (res.ok) {
        const payload = await res.json();
        return {
          markers: sanitizeMarkers(payload.markers),
          textCues: Array.isArray(payload.textCues) ? payload.textCues : [],
        };
      }
    } catch {}
    return { markers: [], textCues: [] };
  }

  function applyLipSyncMarkers(audio, markers, textCues) {
    if (activeLipSyncFrame) { cancelAnimationFrame(activeLipSyncFrame); activeLipSyncFrame = null; }
    clearTextOverlay();

    const hasMarkers = markers && markers.length;
    const hasTextCues = textCues && textCues.length;
    if (!hasMarkers && !hasTextCues) return;

    // Markers are sorted by time and playback time only moves forward, so a
    // single advancing pointer replaces the old scan-every-marker-every-frame.
    let nextMarker = 0;
    let textApplied = new Set();
    function tick() {
      // Stop only when playback is finished or the scene replaced this audio.
      // A transient pause (buffering, tab switch) keeps the loop alive.
      if (!audio || audio.ended || audio !== activeLipSyncAudio) return;
      if (audio.paused) { activeLipSyncFrame = requestAnimationFrame(tick); return; }
      const t = audio.currentTime;
      if (hasMarkers) {
        while (nextMarker < markers.length && t >= markers[nextMarker].time) {
          const m = markers[nextMarker];
          if (Number.isFinite(m.mouth_shape))   { setInput('mouth_shape', m.mouth_shape); setInput('is_speaking', m.mouth_shape > 0); }
          if (Number.isFinite(m.emotion_state))  { setInput('emotion_state', m.emotion_state); setInput('eyes_state', m.emotion_state); lastEmotion = m.emotion_state; }
          if (Number.isFinite(m.body_movement))  { setInput('body_movement', m.body_movement); setInput('nav_heart', m.body_movement); }
          if (Number.isFinite(m.head_movement))  { setInput('head_movement', m.head_movement); setInput('head_state', m.head_movement); }
          if (Number.isFinite(m.heart_state))    setInput('heart_state', m.heart_state);
          if (Array.isArray(m.haptic) && navigator.vibrate) { try { navigator.vibrate(m.haptic); } catch {} }
          nextMarker++;
        }
      }
      if (hasTextCues) {
        for (let i = 0; i < textCues.length; i++) {
          if (textApplied.has(i)) continue;
          const tc = textCues[i];
          if (t >= tc.time && t < tc.time + tc.duration) {
            textApplied.add(i);
            showTextOverlay(tc.text, tc.duration, tc);
          }
        }
      }
      activeLipSyncFrame = requestAnimationFrame(tick);
    }
    activeLipSyncFrame = requestAnimationFrame(tick);
  }

  function stopLipSync() {
    if (activeLipSyncFrame) { cancelAnimationFrame(activeLipSyncFrame); activeLipSyncFrame = null; }
  }

  // ─── Text overlay with typewriter effect ─────────────────────────────────────
  const textOverlayEl = document.getElementById('textOverlay');

  function showTextOverlay(text, duration, style) {
    if (!textOverlayEl) return;
    if (activeTextCueTimer) { clearTimeout(activeTextCueTimer); activeTextCueTimer = null; }

    const s = style || {};
    const baseFontSize = s.fontSize || 24;
    textOverlayEl.style.fontSize   = baseFontSize + 'px';
    textOverlayEl.style.color      = s.color || '#C1A376';
    textOverlayEl.style.fontWeight = s.fontWeight || '700';
    textOverlayEl.style.top      = '';
    textOverlayEl.style.bottom   = '';
    textOverlayEl.style.width    = '';
    textOverlayEl.style.maxWidth = '';
    if (s.position === 'caption')     { textOverlayEl.style.top = '60px'; textOverlayEl.style.bottom = 'auto'; textOverlayEl.style.width = 'min(90%, 350px)'; textOverlayEl.style.maxWidth = 'min(90%, 350px)'; }
    else if (s.position === 'top')    { textOverlayEl.style.top = '12%'; textOverlayEl.style.bottom = 'auto'; }
    else if (s.position === 'center') { textOverlayEl.style.top = '45%'; textOverlayEl.style.bottom = 'auto'; }
    else                              { textOverlayEl.style.top = ''; textOverlayEl.style.bottom = '15%'; }

    const tokens = text.split(/(\s+)/);
    const html = tokens.map(token => {
      if (token.includes('\n')) return '<br>';
      if (/^\s+$/.test(token)) return ' ';
      return `<span class="word">${token.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</span>`;
    }).join('');
    textOverlayEl.innerHTML = html;
    textOverlayEl.classList.add('is-visible');

    // Shrink font to fit the screen so long captions never run off the top/bottom edge
    const maxOverlayHeight = stableViewportHeight - (s.position === 'caption' ? 100 : 80);
    let fittedSize = baseFontSize;
    textOverlayEl.style.fontSize = fittedSize + 'px';
    while (textOverlayEl.scrollHeight > maxOverlayHeight && fittedSize > 12) {
      fittedSize -= 2;
      textOverlayEl.style.fontSize = fittedSize + 'px';
    }

    const wordEls = textOverlayEl.querySelectorAll('.word');
    const perWord = (Number(s.speed) || 90) * 4;

    const isChatText = s.position === 'caption' && s.lipSync !== false;
    const currentEmotion = typeof lastEmotion === 'number' ? lastEmotion : 0;
    const mouthShapes = [1, 3, 8, 0, 5, 7, 0, 2, 11, 1, 0, 5, 3, 0];

    if (isChatText) setInput('is_speaking', true);

    for (const id of activeCharTimers) clearTimeout(id);
    activeCharTimers = [];
    if (s.mumble === true) resetMumblePhrase(wordEls.length, /\?\s*['"’”]?\s*$/.test(text));
    wordEls.forEach((el, i) => {
      const tid = setTimeout(() => {
        el.classList.add('is-typed');
        const word = el.textContent;
        const firstChar = word.charAt(0);

        if (isChatText) {
          setInput('mouth_shape', mouthShapes[i % mouthShapes.length]);
        }

        if (s.mumble === true && firstChar && /[a-z0-9]/i.test(firstChar)) {
          playMumbleSyllable(firstChar, currentEmotion, { wordIndex: i, word });
        }
      }, i * perWord);
      activeCharTimers.push(tid);
    });

    if (isChatText) {
      const stopMouthTid = setTimeout(() => {
        setInput('mouth_shape', 0);
        setInput('is_speaking', false);
      }, wordEls.length * perWord + 100);
      activeCharTimers.push(stopMouthTid);
    }

    // Hide the overlay once its duration elapses (never before typing finishes).
    const typingMs   = wordEls.length * perWord;
    const durationMs = Math.max((Number(duration) || 3) * 1000, typingMs + 800);
    activeTextCueTimer = setTimeout(() => {
      activeTextCueTimer = null;
      textOverlayEl.classList.remove('is-visible');
    }, durationMs);
  }

  function clearTextOverlay() {
    if (!textOverlayEl) return;
    if (activeTextCueTimer) { clearTimeout(activeTextCueTimer); activeTextCueTimer = null; }
    for (const id of activeCharTimers) clearTimeout(id);
    activeCharTimers = [];
    textOverlayEl.classList.remove('is-visible');
    textOverlayEl.innerHTML = '';
  }

  // ─── Voice input (Speech Recognition) ────────────────────────────────────────
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let activeRecognition = null;

  function setupVoiceButton(voiceBtn, inputEl, onSend) {
    const noop = () => {};
    if (!voiceBtn) return noop;
    if (!SpeechRecognition) { voiceBtn.style.display = 'none'; return noop; }

    const handler = () => {
      ensureMumbleUnlocked();
      if (activeRecognition) { activeRecognition.stop(); return; }

      const recognition = new SpeechRecognition();
      recognition.lang = 'en-US';
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.maxAlternatives = 1;
      activeRecognition = recognition;

      voiceBtn.classList.add('is-recording');
      inputEl.placeholder = 'Listening...';
      inputEl.value = '';

      recognition.onresult = (event) => {
        let transcript = '';
        for (const result of event.results) {
          transcript += result[0].transcript;
        }
        inputEl.value = transcript;
        if (event.results[event.results.length - 1].isFinal) {
          recognition.stop();
        }
      };

      recognition.onend = () => {
        activeRecognition = null;
        voiceBtn.classList.remove('is-recording');
        inputEl.placeholder = 'Say something to Eli...';
        const text = inputEl.value.trim();
        if (text && onSend) onSend(text);
      };

      recognition.onerror = (event) => {
        activeRecognition = null;
        voiceBtn.classList.remove('is-recording');
        inputEl.placeholder = 'Say something to Eli...';
        if (event.error !== 'no-speech' && event.error !== 'aborted') {
          inputEl.placeholder = 'Mic not available — type instead';
        }
      };

      recognition.start();
    };
    voiceBtn.addEventListener('click', handler);
    return () => voiceBtn.removeEventListener('click', handler);
  }

  function sanitizeMarkers(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(m => m && Number.isFinite(m.time) && m.time >= 0 &&
      (Number.isFinite(m.mouth_shape) || Number.isFinite(m.emotion_state) || Number.isFinite(m.body_movement) || Number.isFinite(m.head_movement) || Number.isFinite(m.heart_state) || Array.isArray(m.haptic))
    ).sort((a, b) => a.time - b.time);
  }

  // ─── Memory room scene ──────────────────────────────────────────────────────
  async function playMemoryScene(config) {
    if (!memoryScreen || !memoryRoomBg || !memoryObjects || !memoryCaption || !memoryWhisper || !memoryEli || !memoryHeart) {
      fadeIn();
      showMessage('Memory room UI is missing.', true);
      return;
    }

    showMessage('');
    clearTextOverlay();
    syncViewportVars();

    const timers = [];
    const cleanups = [];
    const later = (fn, ms) => {
      const id = setTimeout(fn, ms);
      timers.push(id);
      return id;
    };
    activeMemoryCleanup = () => {
      for (const id of timers) clearTimeout(id);
      for (const fn of cleanups) fn();
      memoryScreen.classList.remove('is-awake', 'is-collapsing', 'is-calm');
      memoryObjects.innerHTML = '';
      memoryCaption.textContent = '';
      memoryCaption.classList.remove('is-visible');
      if (activeMemoryCaptionTimer) { clearTimeout(activeMemoryCaptionTimer); activeMemoryCaptionTimer = null; }
      memoryWhisper.textContent = '';
      memoryWhisper.classList.remove('is-visible');
      memoryEli.classList.remove('is-visible', 'is-holding');
      if (memoryHoldProgress) memoryHoldProgress.style.setProperty('--hold-progress', '0');
    };

    const memory = config.memory || {};
    const objects = Array.isArray(memory.objects) && memory.objects.length ? memory.objects : [
      { id: 'notebook', label: 'Notebook', x: 28, y: 76, size: 94, fragment: 'I sat here.' },
      { id: 'photo', label: 'Photo', x: 50, y: 72, size: 88, fragment: 'I don’t remember her face.' },
      { id: 'locker', label: 'Locker', x: 74, y: 52, size: 104, fragment: 'Someone was laughing.' },
      { id: 'drawing', label: 'Drawing', x: 72, y: 64, size: 86, fragment: 'Don’t forget me.' },
    ];
    const collapseAfter = Math.max(1, Math.min(objects.length, Number(memory.collapseAfter) || 3));
    const holdMs = Math.max(800, Number(memory.holdMs) || 2400);
    const destination = config.after?.next || nextInSequence(config.id);

    memoryRoomBg.style.backgroundImage = `url("${resolveAssetUrl(config.id, memory.background || './public/memory/memory-room-v1.png')}")`;
    memoryScreen.style.display = 'block';
    fadeIn();

    later(() => memoryScreen.classList.add('is-awake'), 80);
    showMemoryCaption(memory.opening || 'Everything disappears...\nexcept you', 3200);

    let found = 0;
    let collapsed = false;
    let holdFrame = null;
    let holdStartedAt = 0;

    const revealWhisper = (text, duration = 2200) => {
      memoryWhisper.textContent = text;
      memoryWhisper.classList.add('is-visible');
      later(() => memoryWhisper.classList.remove('is-visible'), duration);
    };

    const beginCollapse = () => {
      if (collapsed) return;
      collapsed = true;
      playHaptic('heartbeat');
      memoryScreen.classList.add('is-collapsing');
      showMemoryCaption(memory.collapseText || 'It’s slipping.', 2200);
      later(() => {
        memoryEli.classList.add('is-visible');
        revealWhisper(memory.holdHint || 'Hold his heart.', 2600);
      }, 900);
    };

    const finishHold = () => {
      if (holdFrame) cancelAnimationFrame(holdFrame);
      holdFrame = null;
      memoryEli.classList.remove('is-holding');
      memoryScreen.classList.remove('is-collapsing');
      memoryScreen.classList.add('is-calm');
      if (memoryHoldProgress) memoryHoldProgress.style.setProperty('--hold-progress', '1');
      playHaptic('soft');
      showMemoryCaption(memory.recoveredText || 'You brought it back.', 2600);
      revealWhisper(memory.thanks || 'Thank you.', 2600);
      later(() => {
        if (destination) loadScene(destination);
        else showMemoryCaption(memory.ending || 'Can I ask you something?\nIf I disappear... would you come back tomorrow?', 8000);
      }, 3200);
    };

    const updateHold = () => {
      const progress = Math.min(1, (performance.now() - holdStartedAt) / holdMs);
      if (memoryHoldProgress) memoryHoldProgress.style.setProperty('--hold-progress', String(progress));
      if (progress >= 1) {
        finishHold();
        return;
      }
      holdFrame = requestAnimationFrame(updateHold);
    };

    const startHold = (event) => {
      if (!collapsed || memoryScreen.classList.contains('is-calm')) return;
      event.preventDefault();
      holdStartedAt = performance.now();
      memoryEli.classList.add('is-holding');
      playHaptic('tap');
      updateHold();
    };
    const cancelHold = () => {
      if (memoryScreen.classList.contains('is-calm')) return;
      if (holdFrame) cancelAnimationFrame(holdFrame);
      holdFrame = null;
      memoryEli.classList.remove('is-holding');
      if (memoryHoldProgress) memoryHoldProgress.style.setProperty('--hold-progress', '0');
    };

    memoryHeart.addEventListener('pointerdown', startHold);
    memoryHeart.addEventListener('pointerup', cancelHold);
    memoryHeart.addEventListener('pointercancel', cancelHold);
    memoryHeart.addEventListener('pointerleave', cancelHold);
    cleanups.push(() => {
      memoryHeart.removeEventListener('pointerdown', startHold);
      memoryHeart.removeEventListener('pointerup', cancelHold);
      memoryHeart.removeEventListener('pointercancel', cancelHold);
      memoryHeart.removeEventListener('pointerleave', cancelHold);
      if (holdFrame) cancelAnimationFrame(holdFrame);
    });

    memoryObjects.innerHTML = '';
    for (const object of objects) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'memory-object';
      btn.setAttribute('aria-label', object.label || object.id || 'Memory object');
      btn.style.setProperty('--object-x', `${Number(object.x) || 50}%`);
      btn.style.setProperty('--object-y', `${Number(object.y) || 50}%`);
      btn.style.setProperty('--object-size', `${Number(object.size) || 84}px`);
      btn.addEventListener('click', () => {
        if (btn.classList.contains('is-found') || collapsed) return;
        btn.classList.add('is-found');
        found++;
        playHaptic(found >= collapseAfter ? 'strong' : 'tap');
        revealWhisper(object.fragment || 'This was mine.');
        if (found >= collapseAfter) later(beginCollapse, 700);
      });
      memoryObjects.appendChild(btn);
    }
  }

  function showMemoryCaption(text, duration) {
    if (!memoryCaption) return;
    if (activeMemoryCaptionTimer) { clearTimeout(activeMemoryCaptionTimer); activeMemoryCaptionTimer = null; }
    memoryCaption.textContent = text || '';
    memoryCaption.classList.toggle('is-visible', !!text);
    if (duration) {
      activeMemoryCaptionTimer = setTimeout(() => {
        activeMemoryCaptionTimer = null;
        if (memoryCaption.textContent === text) memoryCaption.classList.remove('is-visible');
      }, duration);
    }
  }

  // ─── Video scene ─────────────────────────────────────────────────────────────
  async function playVideoScene(config) {
    clearTextOverlay();
    videoScreen.style.display = 'flex';
    const files = config.files || {};
    const videoFile = Object.keys(files).find(f => files[f] === 'video') || null;
    if (!videoFile) { showMessage('No video file set for this scene.', true); return; }

    sceneVideo.src = sceneAssetUrl(config.id, `audio/${videoFile}`);
    sceneVideo.load();

    const overlayConfig = config.videoOverlay || config.overlay || null;
    const overlaySrc = typeof overlayConfig === 'string' ? overlayConfig : overlayConfig?.src;
    if (videoOverlay && overlaySrc) {
      videoOverlay.src = resolveAssetUrl(config.id, overlaySrc);
      videoOverlay.style.setProperty('--video-overlay-opacity', String(overlayConfig?.opacity ?? 0.78));
      videoOverlay.style.display = 'block';
    } else if (videoOverlay) {
      videoOverlay.removeAttribute('src');
      videoOverlay.style.display = 'none';
      videoOverlay.style.removeProperty('--video-overlay-opacity');
    }

    const skipNext = () => {
      sceneVideo.pause();
      const after = config.after || {};
      if (after.next) loadScene(after.next);
    };

    sceneVideo.onended = skipNext;

    const skipBtn = document.getElementById('videoSkip');
    if (skipBtn) skipBtn.onclick = skipNext;

    fadeIn();
    try { await sceneVideo.play(); } catch { showMessage('Tap to play video.'); }
  }

  // ─── Chat scene ──────────────────────────────────────────────────────────────
  async function playChatScene(config) {
    chatScreen.style.display = 'flex';

    const chatRivePath = riveFilePath(config);

    if (chatRivePath && riveInstance) {
      try { riveInstance.cleanup(); } catch {}
      riveInstance = null;
      inputByName = new Map();   // don't act on the previous scene's inputs if load fails
    }

    if (chatRivePath) {
      const chatBuffer = await getRiveBuffer(chatRivePath).catch(() => null);
      if (chatBuffer) {
        const chatSmNames = Array.isArray(config.stateMachines) && config.stateMachines.length
          ? config.stateMachines
          : config.rive === 'shared' ? ['EliState', 'EliBody', 'FacialState', 'EmotionState', 'AyesMovements'] : [];
        await new Promise((resolve) => {
          riveInstance = new rive.Rive({
            buffer: chatBuffer,
            canvas: chatCanvas,
            autoplay: true,
            fit: config.fit === 'contain' ? rive.Fit.Contain : rive.Fit.Cover,
            alignment: rive.Alignment.Center,
            ...(chatSmNames.length ? { stateMachines: chatSmNames } : {}),
            onLoad: () => {
              inputByName = collectInputs(chatSmNames);
              if (riveInstance.on && rive.EventType?.RiveEvent) {
                riveInstance.on(rive.EventType.RiveEvent, (event) => {
                  const nm = event?.data?.name;
                  if (nm) handleRiveEvent(nm, config);
                });
              }
              setTimeout(resizeChatCanvas, 50);
              resolve();
            },
            onLoadError: () => resolve(),
          });
        });
      }
    }

    fadeIn();
    chatThread.innerHTML = '';
    chatMessages = [];
    chatInput.value = '';
    chatInput.placeholder = 'Say something to Eli...';

    if (window._chatCleanup) { window._chatCleanup(); window._chatCleanup = null; }

    chatForm.style.display = 'none';

    const hasSegments = Array.isArray(config.segments) && config.segments.length;
    if (hasSegments) {
      playSegment(config, 0);
    } else {
      const hasVoice = getVoiceFile(config);
      if (hasVoice) {
        playVoiceLines(config);
        const waitForDone = setInterval(() => {
          if (!activeLipSyncAudio || activeLipSyncAudio.ended) {
            clearInterval(waitForDone);
            chatForm.style.display = '';
          }
        }, 200);
      } else {
        chatForm.style.display = '';
      }
    }

    const eliThinking = document.getElementById('eliThinking');

    function showThinking() {
      if (eliThinking) eliThinking.style.display = 'block';
      chatInput.disabled = true;
    }

    function hideThinking() {
      if (eliThinking) eliThinking.style.display = 'none';
      chatInput.disabled = false;
    }

    async function sendMessage(text) {
      if (!text) return;
      chatInput.value = '';
      chatInput.placeholder = '...';
      chatMessages.push({ role: 'user', content: text });

      showThinking();
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: chatMessages, game: gameId || undefined }),
        });
        hideThinking();
        const data = res.ok ? await res.json() : { reply: '...' };
        const reply = data.reply || '...';
        chatMessages.push({ role: 'assistant', content: reply });
        showTextOverlay(reply, 8, { fontSize: 28, color: '#C1A376', position: 'caption', fontWeight: '700' });
        if (data.vitals) applyVitals(data.vitals);
        if (data.emotion) applyEmotion(data.emotion);
        if (data.body) applyBody(data.body);

        if (data.needs_comfort) {
          chatForm.style.display = 'none';
          showHeartPrompt(() => {
            chatForm.style.display = '';
            sendMessage('[The player touched your heart gently]');
          });
          return;
        }

        if (data.suggested_responses?.length) {
          chatInput.placeholder = data.suggested_responses.join(', ');
        } else {
          chatInput.placeholder = 'Say something to Eli...';
        }
      } catch {
        hideThinking();
        showTextOverlay('...', 3, { fontSize: 28, color: '#C1A376', position: 'caption', fontWeight: '700' });
        chatInput.placeholder = 'Say something to Eli...';
      }
    }

    const chatSubmitHandler = (e) => {
      e.preventDefault();
      ensureMumbleUnlocked();
      sendMessage(chatInput.value.trim());
    };
    chatForm.addEventListener('submit', chatSubmitHandler);
    const voiceCleanup = setupVoiceButton(document.getElementById('chatVoiceBtn'), chatInput, sendMessage);
    window._chatCleanup = () => {
      chatForm.removeEventListener('submit', chatSubmitHandler);
      voiceCleanup();
    };
  }

  // ─── Emotion / body mapping ──────────────────────────────────────────────────
  // Eyes track: 0–9 are the emotional eye states (same values as before),
  // 10–13 are gaze directions (Up, Down, Left, Right).
  const EMOTION_MAP = { neutral: 0, sad: 1, happy: 2, angry: 3, surprised: 4, confused: 5, remembering: 6, scared: 7, tired: 8 };
  const BODY_MAP    = { idle: 0, heart_glow: 1, heart_pain: 2 };

  // ─── Heart comfort interaction ──────────────────────────────────────────────
  const heartPrompt = document.getElementById('heartPrompt');
  let heartComfortCallback = null;

  function showHeartPrompt(onComfort) {
    if (!heartPrompt) return;
    heartComfortCallback = onComfort;
    heartPrompt.style.display = 'flex';
    heartPrompt.classList.remove('is-touching');

    const handler = () => {
      heartPrompt.classList.add('is-touching');
      playHaptic('heartbeat');
      setInput('body_movement', 1);

      setTimeout(() => {
        heartPrompt.style.display = 'none';
        heartPrompt.classList.remove('is-touching');
        setTimeout(() => { setInput('body_movement', 0); }, 2000);
        if (heartComfortCallback) heartComfortCallback();
        heartComfortCallback = null;
      }, 1500);
    };

    heartPrompt.onclick = handler;
  }

  function hideHeartPrompt() {
    if (heartPrompt) { heartPrompt.style.display = 'none'; heartPrompt.onclick = null; }
    heartComfortCallback = null;
  }

  function applyVitals(vitals) {
    if (Number.isFinite(vitals.bpm))  setInput('heart_pulse', vitals.bpm);
    if (Number.isFinite(vitals.mood)) { setInput('emotion_state', vitals.mood); setInput('eyes_state', vitals.mood); lastEmotion = vitals.mood; }
  }

  function applyEmotion(emotion) {
    const val = EMOTION_MAP[emotion];
    if (val !== undefined) { setInput('emotion_state', val); setInput('eyes_state', val); lastEmotion = val; }
  }

  function applyBody(body) {
    const val = BODY_MAP[body];
    if (val !== undefined) setInput('body_movement', val);
  }

  // ─── UI helpers ───────────────────────────────────────────────────────────────
  function hideAll() {
    stage.style.display       = 'none';
    videoScreen.style.display = 'none';
    if (videoOverlay) {
      videoOverlay.style.display = 'none';
      videoOverlay.removeAttribute('src');
      videoOverlay.style.removeProperty('--video-overlay-opacity');
    }
    chatScreen.style.display  = 'none';
    if (memoryScreen) memoryScreen.style.display = 'none';
  }

  function showMessage(text, isError = false) {
    messageEl.textContent  = text;
    messageEl.style.display = text ? 'block' : 'none';
    messageEl.classList.toggle('is-error', !!isError);
  }

  function fadeOut() {
    return new Promise(resolve => {
      fadeEl.classList.add('is-visible');
      setTimeout(resolve, 300);
    });
  }

  function fadeIn() {
    fadeEl.classList.remove('is-visible');
  }

  function resizeCanvas() {
    if (!riveInstance) return;
    syncViewportVars();
    sizeCanvasToViewport(canvas);
    riveInstance.resizeToCanvas();
  }

  function resizeChatCanvas() {
    if (!riveInstance) return;
    syncViewportVars();
    sizeCanvasToViewport(chatCanvas);
    riveInstance.resizeToCanvas();
  }

  function scheduleResize() {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      syncViewportVars();
      if (chatScreen.style.display !== 'none') resizeChatCanvas();
      else if (stage.style.display !== 'none') resizeCanvas();
    });
  }

  // A 3s hold would be cut short by the long-press context menu — block it
  for (const c of [canvas, chatCanvas]) {
    if (c) c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  window.addEventListener('resize', scheduleResize);
  window.addEventListener('orientationchange', () => {
    stableViewportWidth = 0;
    stableViewportHeight = 0;
    setTimeout(scheduleResize, 250);
  });

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', scheduleResize);
    window.visualViewport.addEventListener('scroll', scheduleResize);
  }
}());
