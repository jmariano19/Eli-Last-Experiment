(function () {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────────
  const params    = new URLSearchParams(window.location.search);
  const startScene = params.get('scene') || null;
  // ?restart — wipe saved progress and begin from the first scene
  const freshStart = params.has('restart') || params.has('fresh');
  // ?segment=N — editor's per-segment ▶ test: start the scene at that segment
  const startSegment = params.get('segment');
  let startSegmentUsed = false;

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
  let activePlayingSegment = -1;   // index of the segment currently playing
  let segmentsDone = false;        // true once a segmented scene reaches its fallback stage
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
  let activeGiveCleanup = null;
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
  const threadScreen = document.getElementById('threadScreen');
  const threadField = document.getElementById('threadField');
  const threadNodes = document.getElementById('threadNodes');
  const threadPath = document.getElementById('threadPath');
  const threadCaption = document.getElementById('threadCaption');
  const threadWhisper = document.getElementById('threadWhisper');
  const threadRecovered = document.getElementById('threadRecovered');
  const wordsScreen = document.getElementById('wordsScreen');
  const wordsCaption = document.getElementById('wordsCaption');
  const wordsMemories = document.getElementById('wordsMemories');
  const wordsCurrent = document.getElementById('wordsCurrent');
  const wordsWheel = document.getElementById('wordsWheel');
  const wordsLetters = document.getElementById('wordsLetters');
  const wordsPath = document.getElementById('wordsPath');
  const wordsReveal = document.getElementById('wordsReveal');
  const wordsRecovered = document.getElementById('wordsRecovered');
  const wordsEli = document.getElementById('wordsEli');
  const wordsEliImg = document.getElementById('wordsEliImg');
  const pairsScreen  = document.getElementById('pairsScreen');
  const pairsBoard   = document.getElementById('pairsBoard');
  const pairsCaption = document.getElementById('pairsCaption');
  const pairsFound   = document.getElementById('pairsFound');
  const jigsawScreen  = document.getElementById('jigsawScreen');
  const jigsawBoard   = document.getElementById('jigsawBoard');
  const jigsawCaption = document.getElementById('jigsawCaption');
  const jigsawPlaced  = document.getElementById('jigsawPlaced');
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

    if (freshStart) { try { localStorage.removeItem(PROGRESS_KEY); } catch {} }
    let resume = null;
    if (!devMode && !freshStart) { try { resume = localStorage.getItem(PROGRESS_KEY); } catch {} }
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
  async function applyDynamicRiveText(config) {
    const isDiaryScene = Boolean(config.dynamicDiary) ||
      config.id === '7_the_diary' ||
      config.id === 'eli_s_diary';
    if (!isDiaryScene) return;
    const textRun = String(config.dynamicDiary?.textRun || 'DiaryText');

    let playerName = '';
    try {
      const suffix = gameId ? `?game=${encodeURIComponent(gameId)}` : '';
      const response = await fetch(`/api/narrative-state${suffix}`);
      if (response.ok) {
        const state = await response.json();
        playerName = String(state?.player_name || '').trim().slice(0, 40);
      }
    } catch {}

    const text = playerName
      ? `Today, ${playerName} found me in the dark.\n\nThey stayed until my heart became quiet.\n\nTogether, we remembered a playground, a house, and the word Mother.\n\nI wrote their name here so this moment would have somewhere to live.\n\n${playerName} was here.\n\nTonight, I was not alone.`
      : `Today, someone found me in the dark.\n\nThey stayed until my heart became quiet.\n\nTogether, we remembered a playground, a house, and the word Mother.\n\nThey didn't leave me their name. That's all right.\n\nI still know they were here.\n\nTonight, I was not alone.`;

    let appliedToRive = false;
    if (!config.dynamicDiary?.overlayOnly && riveInstance?.setTextRunValue) {
      try {
        riveInstance.setTextRunValue(textRun, text);
        appliedToRive = typeof riveInstance.getTextRunValue !== 'function' ||
          riveInstance.getTextRunValue(textRun) === text;
      } catch (err) {
        if (devMode) console.warn(`[diary] Rive text run "${textRun}" was not found`, err);
      }
    }

    // A Rive text run must be explicitly exposed by the asset. Until it is,
    // render the same personalized entry as an HTML layer so testing never
    // produces a blank diary.
    if (!appliedToRive) {
      showTextOverlay(text, 600, {
        fontSize: 17,
        color: '#d8b77b',
        position: 'diary',
        fontWeight: '400',
        speed: 38,
        revealDurationMs: Number(config.dynamicDiary?.revealDurationMs) || 30200,
        lipSync: false,
        hold: true,
      });
    }
  }

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
      if (activeGiveCleanup) { activeGiveCleanup(); activeGiveCleanup = null; }
      cleanupWordsEliRive();
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
      if (config.type === 'thread') await playThreadScene(config);
      if (config.type === 'words') await playWordsScene(config);
      if (config.type === 'pairs') await playPairsScene(config);
      if (config.type === 'jigsaw') await playJigsawScene(config);

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
          applyDynamicRiveText(config);
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
    return collectInputsFrom(riveInstance, smNames);
  }

  function collectInputsFrom(instance, smNames) {
    const map = new Map();
    if (!instance) return map;
    const names = smNames || instance.stateMachineNames || [];
    for (const sm of names) {
      try {
        for (const input of (instance.stateMachineInputs(sm) || [])) {
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
  // Apply one timed expression mark from a Silence segment's timeline.
  // Only the fields the mark sets are changed; everything else holds.
  function applyPoseMark(mark) {
    if (Number.isFinite(mark.mouth_shape))   { setInput('mouth_shape', mark.mouth_shape); setInput('is_speaking', mark.mouth_shape > 0); }
    if (Number.isFinite(mark.emotion_state)) { setInput('emotion_state', mark.emotion_state); setInput('eyes_state', mark.emotion_state); lastEmotion = mark.emotion_state; }
    if (Number.isFinite(mark.body_movement)) { setInput('body_movement', mark.body_movement); setInput('nav_heart', mark.body_movement); }
    if (Number.isFinite(mark.head_movement)) { setInput('head_movement', mark.head_movement); setInput('head_state', mark.head_movement); }
    if (Number.isFinite(mark.heart_state))   setInput('heart_state', mark.heart_state);
  }

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
      // First load of the ?scene= target may jump straight to ?segment=N —
      // one-time so later navigation through the scene behaves normally.
      let startIndex = 0;
      if (devMode && startSegment !== null && !startSegmentUsed && config.id === startScene) {
        startSegmentUsed = true;
        const n = Number(startSegment);
        if (Number.isFinite(n)) startIndex = Math.max(0, Math.min(config.segments.length - 1, n));
      }
      playSegment(config, startIndex);
      return;
    }

    const bgFiles = getBgFiles(config);
    for (const bg of bgFiles) {
      const bgAudio = makeAudio(sceneAssetUrl(config.id, `audio/${bg}`));
      bgAudio.loop = shouldLoopBackground(config, bg, false);
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
      requestPlaybackTap('touch to hear him', async () => {
        for (const a of activeBgAudios) if (a.paused) a.play().catch(() => {});
        await audio.play();
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
    activePlayingSegment = index;
    segmentsDone = false;

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
        bgAudio.loop = shouldLoopBackground(config, file, true);
        bgAudio.volume = 0.5;
        bgAudio.play().catch(() => {});
        activeSegmentBgs.push(bgAudio);
      }
    }

    if (seg.type === 'chat') {
      playChatSegment(config, index);
      return;
    }

    if (seg.type === 'video') {
      playVideoSegment(config, index);
      return;
    }

    if (seg.type === 'pause') {
      // Silence segment — no voice, no chat. Eli animates through timed
      // expression marks (seg.marks) while only BG sound plays; after the
      // duration the trigger decides how to advance (ended = auto,
      // tap_heart = wait for tap, etc.).
      setInput('mouth_shape', 0);
      setInput('is_speaking', false);
      const durationMs = (Number(seg.duration) || 0) * 1000;
      const marks = (Array.isArray(seg.marks) ? seg.marks : [])
        .filter(m => m && Number.isFinite(Number(m.t)))
        .sort((a, b) => Number(a.t) - Number(b.t));
      let markFrame = null;
      let timer = null;
      const startedAt = performance.now();
      let mi = 0;
      const tickMarks = () => {
        const elapsed = (performance.now() - startedAt) / 1000;
        while (mi < marks.length && Number(marks[mi].t) <= elapsed) {
          applyPoseMark(marks[mi]);
          mi++;
        }
        markFrame = mi < marks.length ? requestAnimationFrame(tickMarks) : null;
      };
      if (marks.length) markFrame = requestAnimationFrame(tickMarks);
      const finish = () => {
        if (markFrame) { cancelAnimationFrame(markFrame); markFrame = null; }
        if (isLast) {
          for (const a of activeSegmentBgs) a.pause(); activeSegmentBgs = []; activeSegmentBgNames = [];
          setupAfterTrigger(config);
          return;
        }
        waitForSegmentTrigger(config, index);
      };
      segmentCleanup = () => {
        if (timer) clearTimeout(timer);
        if (markFrame) cancelAnimationFrame(markFrame);
      };
      if (durationMs > 0) {
        timer = setTimeout(() => {
          timer = null;
          finish();
        }, durationMs);
      } else {
        finish();
      }
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
      requestPlaybackTap('touch to hear him', async () => {
        for (const a of activeSegmentBgs) if (a.paused) a.play().catch(() => {});
        await audio.play();
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
      // A configured Heart Touch gesture owns this beat. Installing the legacy
      // pointerup fallback here would let a quick tap bypass an authored hold.
      const zone = Object.prototype.hasOwnProperty.call(seg, 'heartZone')
        ? seg.heartZone
        : config.heartZone;
      const hasHeartGesture = zone && ['tap', 'doubleTap', 'hold'].some(key => {
        const action = zone[key];
        return action && (action.heartState !== undefined || action.input || action.next);
      });
      if (hasHeartGesture) return;
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

  // ─── Video segment ──────────────────────────────────────────────────────────
  // Plays a full-screen clip over the Rive stage using the shared videoScreen
  // element, then returns to Eli and advances via the segment's trigger.
  async function playVideoSegment(config, index) {
    const seg = config.segments[index];
    const isLast = index === config.segments.length - 1;
    const videoFile = seg.video;

    setInput('mouth_shape', 0);
    setInput('is_speaking', false);

    if (!videoFile) {
      if (isLast) { setupAfterTrigger(config); return; }
      waitForSegmentTrigger(config, index);
      return;
    }

    videoScreen.style.display = 'flex';
    sceneVideo.src = sceneAssetUrl(config.id, `audio/${videoFile}`);
    sceneVideo.load();

    const skipBtn = document.getElementById('videoSkip');
    const showSkip = seg.skippable !== false;
    if (skipBtn) skipBtn.style.display = showSkip ? '' : 'none';

    let finished = false;
    const hideVideo = () => {
      sceneVideo.pause();
      sceneVideo.onended = null;
      sceneVideo.removeAttribute('src');
      sceneVideo.load();
      if (skipBtn) { skipBtn.onclick = null; skipBtn.style.display = ''; }
      videoScreen.style.display = 'none';
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      hideVideo();
      if (isLast) {
        for (const a of activeSegmentBgs) a.pause(); activeSegmentBgs = []; activeSegmentBgNames = [];
        setupAfterTrigger(config);
        return;
      }
      waitForSegmentTrigger(config, index);
    };

    sceneVideo.onended = finish;
    if (skipBtn && showSkip) skipBtn.onclick = finish;

    // Leaving the scene (or jumping segments) mid-video must not leave the
    // full-screen video sitting over the next scene.
    segmentCleanup = () => { finished = true; hideVideo(); };

    try {
      await sceneVideo.play();
      showMessage('');
    } catch {
      requestPlaybackTap('touch to stay with him', async () => { await sceneVideo.play(); });
    }
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
      showTextOverlay(seg.opening, 8, { fontSize: 28, color: '#C1A376', position: 'caption', fontWeight: '700', mumble: useMumble, hold: true });
      localMessages.push({ role: 'assistant', content: seg.opening });
    }

    let tornDown = false;
    let continueRevealTimer = null;
    function teardownChatUI() {
      if (tornDown) return;
      tornDown = true;
      if (continueRevealTimer) {
        clearTimeout(continueRevealTimer);
        continueRevealTimer = null;
      }
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

        showTextOverlay(reply, 8, { fontSize: 28, color: '#C1A376', position: 'caption', fontWeight: '700', mumble: useMumble, hold: true });

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
          // Keep Eli's final answer visible until the player has finished
          // reading it. Reveal Continue only after the typewriter animation
          // completes and a short reading pause has passed.
          segChatInput.closest('form').style.display = 'none';
          const replyWordCount = reply.trim().split(/\s+/).filter(Boolean).length;
          const continueDelayMs = Math.max(6500, replyWordCount * 360 + 1800);
          continueRevealTimer = setTimeout(() => {
            continueRevealTimer = null;
            segChatContinue.style.display = 'block';
          }, continueDelayMs);
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

  function shouldLoopBackground(config, filename, defaultValue = false) {
    const settings = config?.bgLoops;
    return settings && Object.prototype.hasOwnProperty.call(settings, filename)
      ? settings[filename] === true
      : defaultValue;
  }

  // ─── Scene transitions ───────────────────────────────────────────────────────
  function setupAfterTrigger(config) {
    segmentsDone = true;
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
    if (name === 'tap_heart' || name === 'hit_heart') {
      // An active Heart Touch zone owns heart gestures. The Rive rig's own
      // heart listeners fire on mere pointer-over, which would bypass the
      // zone's tap/double-tap/hold timing — so ignore them while a zone is up.
      if (heartZoneEl) return;
      handleInteraction('tap_heart', config);
      return;
    }
    if (name.startsWith('goto_')) { loadScene(name.slice(5)); return; }
    const after = config.after || {};
    if (after.trigger && name === after.trigger) {
      // Same gate as handleInteraction: segmented scenes honor the fallback
      // trigger only after the last segment has ended.
      if (Array.isArray(config.segments) && config.segments.length && !segmentsDone) return;
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
      else showMessage(cta.message || 'The story ends here — for now.');
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
      // Relative jump — advance to whatever segment follows the one playing.
      // Past the end, playSegment falls through to the scene's FALLBACK.
      if (destination === '@segment:next' && Array.isArray(config.segments)) {
        playSegment(config, Math.min(activePlayingSegment + 1, config.segments.length));
        return;
      }
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

  function showHeartGift(x, y, size) {
    const gift = document.createElement('div');
    gift.className = 'heart-gift-burst';
    gift.setAttribute('aria-hidden', 'true');
    Object.assign(gift.style, {
      left: `${x}%`,
      top: `${y}%`,
      width: `${Math.max(34, size * 2.2)}%`,
    });
    gift.innerHTML = `
      <span class="heart-gift-burst__core"></span>
      <span class="heart-gift-burst__ring"></span>
      <span class="heart-gift-burst__spark"></span>
      <span class="heart-gift-burst__spark"></span>
      <span class="heart-gift-burst__spark"></span>
      <span class="heart-gift-burst__spark"></span>
      <span class="heart-gift-burst__spark"></span>
      <span class="heart-gift-burst__spark"></span>`;
    stage.appendChild(gift);
    // Keep this timer independent from the gesture timers: a successful hold
    // can immediately advance the segment, but the gift bloom should finish.
    setTimeout(() => gift.remove(), 1150);
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
    heartZoneEl.setAttribute('aria-hidden', 'true');
    heartZoneEl.innerHTML = `
      <span class="heart-zone__core"></span>
      <span class="heart-zone__mote"></span>
      <span class="heart-zone__mote"></span>
      <span class="heart-zone__mote"></span>
      <span class="heart-zone__mote"></span>
      <span class="heart-zone__mote"></span>
      <span class="heart-zone__mote"></span>`;
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
    let holdStartedAt = 0;
    let holdDurationMs = 0;
    let holdFired = false;
    let completeHold = null;
    let tapTimer  = null;
    let lastTapAt = 0;
    let activePointerId = null;

    heartZoneEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (activePointerId !== null) return;
      activePointerId = e.pointerId;
      holdFired = false;
      heartZoneEl.classList.add('is-touching');
      // Immediate tactile acknowledgement that the player's finger found
      // Eli's heart. The stronger lub-dub pattern plays on completion.
      if (navigator.vibrate) { try { navigator.vibrate(22); } catch {} }
      try { heartZoneEl.setPointerCapture(e.pointerId); } catch {}
      if (gHold) {
        const dur = Math.max(0.3, Number(gHold.duration) || 3);
        holdStartedAt = performance.now();
        holdDurationMs = dur * 1000;
        heartZoneEl.style.setProperty('--heart-hold-duration', `${dur}s`);
        heartZoneEl.classList.add('is-holding');
        completeHold = () => {
          if (holdFired) return;
          holdFired = true;
          if (holdTimer) clearTimeout(holdTimer);
          holdTimer = null;
          heartZoneEl?.classList.remove('is-holding');
          heartZoneEl?.classList.add('is-received');
          showHeartGift(x, y, size);
          fireHeartAction(gHold, config);
          // fireHeartAction includes a generic tap tick. Set the authored
          // hold-complete pattern afterward so it remains the final haptic.
          if (navigator.vibrate) { try { navigator.vibrate([42, 70, 78]); } catch {} }
        };
        holdTimer = setTimeout(() => {
          completeHold();
        }, holdDurationMs);
        heartZoneTimers.push(holdTimer);
      }
    });

    const cancelHold = () => {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      heartZoneEl?.classList.remove('is-holding', 'is-touching');
    };

    heartZoneEl.addEventListener('pointerup', (e) => {
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      e.stopPropagation();
      if (gHold && !holdFired && holdTimer &&
          performance.now() - holdStartedAt >= holdDurationMs) {
        completeHold?.();
      }
      const held = holdFired;
      cancelHold();
      try { heartZoneEl.releasePointerCapture(e.pointerId); } catch {}
      activePointerId = null;
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

    heartZoneEl.addEventListener('pointercancel', (e) => {
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      cancelHold();
      activePointerId = null;
    });
  }

  function handleInteraction(type, config) {
    const ctaDest = getCtaDestination(type, config);
    if (ctaDest) { loadScene(ctaDest); return; }
    const after = config.after || {};
    if (after.trigger === type) {
      // In a segmented scene the fallback trigger only applies once the last
      // segment has ended — heart taps mid-story are visual, not navigation.
      if (Array.isArray(config.segments) && config.segments.length && !segmentsDone) return;
      const destination = after.next || nextInSequence(config.id);
      if (destination) loadScene(destination);
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
    textOverlayEl.style.maxHeight = '';
    textOverlayEl.style.lineHeight = '';
    textOverlayEl.dataset.position = s.position || 'bottom';
    if (s.position === 'caption')     { textOverlayEl.style.top = 'max(60px, calc(var(--safe-top) + 48px))'; textOverlayEl.style.bottom = 'auto'; textOverlayEl.style.width = 'min(90%, 350px)'; textOverlayEl.style.maxWidth = 'min(90%, 350px)'; }
    else if (s.position === 'top')    { textOverlayEl.style.top = '12%'; textOverlayEl.style.bottom = 'auto'; }
    else if (s.position === 'center') { textOverlayEl.style.top = '45%'; textOverlayEl.style.bottom = 'auto'; }
    else if (s.position === 'diary')  { textOverlayEl.style.top = '49%'; textOverlayEl.style.bottom = 'auto'; textOverlayEl.style.width = 'min(62%, 350px)'; textOverlayEl.style.maxWidth = 'min(62%, 350px)'; }
    else                              { textOverlayEl.style.top = ''; textOverlayEl.style.bottom = '15%'; }

    const tokens = text.split(/(\s+)/);
    const html = tokens.map(token => {
      if (token.includes('\n')) return '<br>';
      if (/^\s+$/.test(token)) return ' ';
      return `<span class="word">${token.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</span>`;
    }).join('');
    textOverlayEl.innerHTML = html;
    textOverlayEl.classList.add('is-visible');

    // Caption CSS used to clip at 30vh while this fitter measured against nearly
    // the whole screen. Give dialogue a real bounded region and fit within that
    // exact same value so no final words disappear behind overflow:hidden.
    const viewportHeight = document.getElementById('phoneScreen')?.clientHeight || stableViewportHeight || window.innerHeight;
    const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    const maxOverlayHeight = s.position === 'caption'
      ? Math.max(220, Math.min(viewportHeight * 0.56, viewportHeight - 190))
      : s.position === 'diary'
        ? Math.max(200, Math.min(viewportHeight * 0.45, 320))
      : Math.max(160, viewportHeight - 100);
    textOverlayEl.style.maxHeight = `${Math.floor(maxOverlayHeight)}px`;
    textOverlayEl.style.lineHeight = s.position === 'diary'
      ? '1.24'
      : wordCount > 34 ? '1.3' : '1.5';
    let fittedSize = wordCount > 60 ? Math.min(baseFontSize, 20)
      : wordCount > 34 ? Math.min(baseFontSize, 24)
        : baseFontSize;
    textOverlayEl.style.fontSize = fittedSize + 'px';
    while (textOverlayEl.scrollHeight > maxOverlayHeight && fittedSize > 13) {
      fittedSize -= 1;
      textOverlayEl.style.fontSize = fittedSize + 'px';
    }

    const wordEls = textOverlayEl.querySelectorAll('.word');
    const requestedRevealDuration = Number(s.revealDurationMs);
    const perWord = Number.isFinite(requestedRevealDuration) && requestedRevealDuration > 0
      ? requestedRevealDuration / Math.max(1, wordEls.length - 1)
      : (Number(s.speed) || 90) * 4;

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

    // hold: true → never auto-hide; the text stays until the next overlay or
    // scene change replaces it (chat replies — the player reads at their pace).
    if (s.hold === true) return;

    // Hide the overlay once its duration elapses — but never before the player
    // has had time to READ it. Typing reveals ~1 word per 0.36s; after the last
    // word lands, hold for ~0.4s per word (≈150 wpm re-read pace, min 3.5s).
    const typingMs   = wordEls.length * perWord;
    const readingMs  = Math.max(3500, 1200 + wordCount * 400);
    const durationMs = Math.max((Number(duration) || 3) * 1000, typingMs + readingMs);
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

  // ─── Memory Thread scene ────────────────────────────────────────────────────
  // A familiar one-thumb connect gesture with a moral edge: preserving one
  // complete memory path means allowing the other path to fade.
  async function playThreadScene(config) {
    if (!threadScreen || !threadField || !threadNodes || !threadPath || !threadCaption || !threadWhisper || !threadRecovered) {
      fadeIn(); showMessage('Memory Thread UI is missing.', true); return;
    }
    const sceneId = config.id;
    const t = config.thread || {};
    const defaultPaths = [
      { id: 'care', title: 'Someone came back', nodes: ['wet shoes', 'the door', 'her voice'], fragment: 'someone_was_there', signal: 'caution' },
      { id: 'experiment', title: 'The bright room', nodes: ['cold floor', 'bright light', 'an alarm'], fragment: 'bright_light', signal: 'risk' },
    ];
    const paths = (Array.isArray(t.paths) ? t.paths : defaultPaths).slice(0, 2).map((path, index) => ({
      ...defaultPaths[index],
      ...(path || {}),
      nodes: Array.isArray(path?.nodes) && path.nodes.length >= 2 ? path.nodes.slice(0, 5) : defaultPaths[index].nodes,
    }));
    const positions = [
      { x: 18, y: 28 }, { x: 78, y: 70 }, { x: 52, y: 15 },
      { x: 22, y: 72 }, { x: 82, y: 30 }, { x: 50, y: 86 },
      { x: 12, y: 50 }, { x: 88, y: 51 }, { x: 50, y: 50 }, { x: 68, y: 49 },
    ];

    showMessage('');
    clearTextOverlay();
    syncViewportVars();
    threadScreen.style.display = 'flex';
    threadScreen.className = 'thread-screen';
    threadNodes.innerHTML = '';
    threadPath.setAttribute('points', '');
    threadRecovered.classList.remove('is-visible');
    threadCaption.textContent = t.intro || 'Some things still belong together.';
    threadWhisper.textContent = 'draw through the pieces that belong.';
    fadeIn();

    for (const bg of getBgFiles(config)) {
      const a = makeAudio(sceneAssetUrl(sceneId, `audio/${bg}`));
      a.loop = shouldLoopBackground(config, bg, true); a.volume = 0.45; a.play().catch(() => {}); activeBgAudios.push(a);
    }

    let positionIndex = 0;
    const nodeButtons = [];
    paths.forEach((path, pathIndex) => {
      path.nodes.forEach((label, nodeIndex) => {
        const pos = positions[positionIndex++ % positions.length];
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'thread-node';
        button.textContent = label;
        button.dataset.path = String(pathIndex);
        button.dataset.node = String(nodeIndex);
        button.dataset.x = String(pos.x);
        button.dataset.y = String(pos.y);
        button.style.left = `${pos.x}%`;
        button.style.top = `${pos.y}%`;
        threadNodes.appendChild(button);
        nodeButtons.push(button);
      });
    });

    let drawing = false;
    let completed = false;
    let activePath = -1;
    let crossedPath = false;
    let selected = [];
    const selectedKeys = new Set();
    const later = (fn, ms) => setTimeout(() => { if (currentSceneId === sceneId) fn(); }, ms);

    const renderThread = (livePoint = null) => {
      const points = selected.map(node => `${node.dataset.x},${node.dataset.y}`);
      if (livePoint) points.push(`${livePoint.x},${livePoint.y}`);
      threadPath.setAttribute('points', points.join(' '));
    };
    const resetThread = (message) => {
      drawing = false;
      threadField.classList.add('is-releasing');
      if (message) threadWhisper.textContent = message;
      later(() => {
        for (const node of selected) node.classList.remove('is-threaded', 'is-uncertain');
        selected = [];
        selectedKeys.clear();
        activePath = -1;
        crossedPath = false;
        threadPath.setAttribute('points', '');
        threadField.classList.remove('is-drawing', 'is-releasing');
        threadWhisper.textContent = 'draw through the pieces that belong.';
      }, 620);
    };
    const finishPath = (pathIndex) => {
      completed = true;
      drawing = false;
      const chosen = paths[pathIndex];
      threadScreen.classList.add('is-recovered');
      threadField.classList.remove('is-drawing');
      threadPath.classList.add('is-complete');
      for (const node of nodeButtons) {
        node.classList.toggle('is-chosen', Number(node.dataset.path) === pathIndex);
        node.classList.toggle('is-left-behind', Number(node.dataset.path) !== pathIndex);
      }
      playHaptic('heartbeat');
      threadCaption.textContent = t.foundText || 'this is the part you kept.';
      threadWhisper.textContent = chosen.title || '';
      threadRecovered.classList.add('is-visible');
      if (chosen.fragment) {
        fetch('/api/memory/unlock', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game: gameId || undefined, fragment: chosen.fragment }),
        }).catch(() => {});
        recordRecovery(chosen.fragment, sceneId);
      }
      if (chosen.signal === 'caution' || chosen.signal === 'risk') {
        fetch('/api/behavior/signal', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game: gameId || undefined, signal: chosen.signal, scene: sceneId }),
        }).catch(() => {});
      }
      later(() => {
        threadCaption.textContent = t.carryText || 'take it back to him.';
        threadWhisper.textContent = '';
      }, 1700);
      later(() => setupAfterTrigger(config), 3700);
    };
    const addNode = (node) => {
      if (!node || completed) return;
      const pathIndex = Number(node.dataset.path);
      const key = `${pathIndex}:${node.dataset.node}`;
      if (selectedKeys.has(key)) return;
      if (activePath < 0) activePath = pathIndex;
      if (pathIndex !== activePath) {
        crossedPath = true;
        node.classList.add('is-uncertain');
        threadWhisper.textContent = 'those pieces remember different things.';
        return;
      }
      selectedKeys.add(key);
      selected.push(node);
      node.classList.add('is-threaded');
      playHaptic('tap');
      renderThread();
    };
    const pointerPosition = (event) => {
      const rect = threadField.getBoundingClientRect();
      return { x: ((event.clientX - rect.left) / rect.width) * 100, y: ((event.clientY - rect.top) / rect.height) * 100 };
    };
    const onPointerDown = (event) => {
      const node = event.target.closest('.thread-node');
      if (!node || completed) return;
      event.preventDefault();
      drawing = true;
      threadField.classList.add('is-drawing');
      threadField.setPointerCapture?.(event.pointerId);
      addNode(node);
    };
    const onPointerMove = (event) => {
      if (!drawing || completed) return;
      const beneath = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.thread-node');
      if (beneath && threadNodes.contains(beneath)) addNode(beneath);
      renderThread(pointerPosition(event));
    };
    const onPointerUp = () => {
      if (!drawing || completed) return;
      const needed = paths[activePath]?.nodes.length || Infinity;
      if (!crossedPath && selected.length >= needed) finishPath(activePath);
      else resetThread(crossedPath ? 'try another thread.' : 'the thread slips loose.');
    };
    threadField.onpointerdown = onPointerDown;
    threadField.onpointermove = onPointerMove;
    threadField.onpointerup = onPointerUp;
    threadField.onpointercancel = onPointerUp;
  }

  // ─── Memory Words scene ─────────────────────────────────────────────────────
  // Live Eli in the words screen: a second, small Rive instance with its own
  // input map, so his mouth can lip-sync while the main canvas stays unused.
  let wordsEliRiveInstance = null;
  let wordsEliRiveInputs = new Map();
  let wordsLipFrame = null;
  let wordsLipInterval = null;
  let activeWordsVoice = null;

  function wordsSetInput(name, value) {
    const input = wordsEliRiveInputs.get(name);
    if (!input) return;
    try {
      if (typeof value === 'boolean') input.value = value;
      else if (input.type === 3) input.fire();
      else input.value = Number(value);
    } catch {}
  }

  function cleanupWordsEliRive() {
    if (wordsLipFrame) { cancelAnimationFrame(wordsLipFrame); wordsLipFrame = null; }
    if (wordsLipInterval) { clearInterval(wordsLipInterval); wordsLipInterval = null; }
    if (activeWordsVoice) { activeWordsVoice.pause(); activeWordsVoice = null; }
    if (wordsEliRiveInstance) { try { wordsEliRiveInstance.cleanup(); } catch {} wordsEliRiveInstance = null; }
    wordsEliRiveInputs = new Map();
    document.getElementById('wordsEliCanvas')?.remove();
  }

  function mountWordsEliRive(sceneId, eliRive) {
    if (!wordsEli || typeof rive === 'undefined' || !rive.Rive) return;
    let eliCanvas = document.getElementById('wordsEliCanvas');
    if (!eliCanvas) {
      eliCanvas = document.createElement('canvas');
      eliCanvas.id = 'wordsEliCanvas';
      wordsEli.appendChild(eliCanvas);
    }
    if (wordsEliImg) wordsEliImg.style.display = 'none';
    wordsEli.style.display = '';
    const dpr = window.devicePixelRatio || 1;
    const cssSize = Math.round(Math.min(window.innerWidth * 0.38, 220));
    eliCanvas.width = cssSize * dpr;
    eliCanvas.height = cssSize * dpr;
    // Style inline so a stale cached stylesheet can never blow up the layout
    const eliMask = 'radial-gradient(circle, #000 55%, transparent 72%)';
    Object.assign(eliCanvas.style, {
      display: 'block',
      margin: '0 auto',
      width: `${cssSize}px`,
      height: `${cssSize}px`,
      borderRadius: '50%',
      webkitMaskImage: eliMask,
      maskImage: eliMask,
    });
    const path = eliRive === 'shared' ? './public/rive/eli.riv' : sceneAssetUrl(sceneId, eliRive);
    const sharedSmNames = ['EliState', 'EliBody', 'FacialState', 'EmotionState', 'AyesMovements'];
    getRiveBuffer(path).then(buffer => {
      let rediscovered = false;
      const init = (names) => new rive.Rive({
        buffer,
        canvas: eliCanvas,
        autoplay: true,
        fit: rive.Fit.Contain,
        alignment: rive.Alignment?.Center,
        useOffscreenRenderer: true,
        ...(names.length ? { stateMachines: names } : {}),
        // setTimeout(0) so this always runs after wordsEliRiveInstance is assigned
        onLoad: () => setTimeout(() => {
          const inst = wordsEliRiveInstance;
          if (!inst) return;
          const available = names.length ? names : (inst.stateMachineNames || []);
          if (!names.length && available.length && !rediscovered) {
            // Bare load told us the real state machine names — reload with them live
            rediscovered = true;
            try { inst.cleanup(); } catch {}
            wordsEliRiveInstance = init(available);
            return;
          }
          wordsEliRiveInputs = collectInputsFrom(inst, available);
          try { inst.resizeDrawingSurfaceToCanvas?.(); } catch {}
          wordsSetInput('mouth_shape', 0);
          wordsSetInput('is_speaking', false);
          console.log('[words] Eli mounted', { path, stateMachines: available, inputs: [...wordsEliRiveInputs.keys()] });
        }, 0),
        onLoadError: () => {
          console.error('[words] Eli rive failed to load', { path, stateMachines: names });
          if (names.length) {
            // Configured state-machine names are stale — retry bare so at
            // least Eli's artwork shows, then discover the real names
            try { wordsEliRiveInstance?.cleanup?.(); } catch {}
            wordsEliRiveInstance = init([]);
          }
        },
      });
      wordsEliRiveInstance = init(eliRive === 'shared' ? sharedSmNames : []);
    }).catch((err) => console.error('[words] Eli rive fetch failed', path, err));
  }

  // Play one of Eli's word-reaction lines, driving his mouth from lip sync
  // markers when a .lipsync.json exists, or a gentle auto-flap when it doesn't.
  function playWordsEliLine(sceneId, voiceFile, markers, onEnded) {
    if (wordsLipFrame) { cancelAnimationFrame(wordsLipFrame); wordsLipFrame = null; }
    if (wordsLipInterval) { clearInterval(wordsLipInterval); wordsLipInterval = null; }
    if (activeWordsVoice) activeWordsVoice.pause();

    const audio = makeAudio(sceneAssetUrl(sceneId, `audio/${voiceFile}`));
    activeWordsVoice = audio;
    const closeMouth = () => { wordsSetInput('mouth_shape', 0); wordsSetInput('is_speaking', false); };
    const finish = () => {
      if (wordsLipFrame) { cancelAnimationFrame(wordsLipFrame); wordsLipFrame = null; }
      if (wordsLipInterval) { clearInterval(wordsLipInterval); wordsLipInterval = null; }
      closeMouth();
      if (onEnded) onEnded();
    };
    audio.onended = finish;

    const hasMarkers = Array.isArray(markers) && markers.length;
    let nextMarker = 0;
    const tick = () => {
      if (!audio || audio.ended || audio !== activeWordsVoice) return;
      if (!audio.paused) {
        const t = audio.currentTime;
        while (nextMarker < markers.length && t >= markers[nextMarker].time) {
          const m = markers[nextMarker];
          if (Number.isFinite(m.mouth_shape))   { wordsSetInput('mouth_shape', m.mouth_shape); wordsSetInput('is_speaking', m.mouth_shape > 0); }
          if (Number.isFinite(m.emotion_state)) { wordsSetInput('emotion_state', m.emotion_state); wordsSetInput('eyes_state', m.emotion_state); }
          if (Number.isFinite(m.head_movement)) { wordsSetInput('head_movement', m.head_movement); wordsSetInput('head_state', m.head_movement); }
          nextMarker++;
        }
      }
      wordsLipFrame = requestAnimationFrame(tick);
    };

    audio.play().then(() => {
      if (hasMarkers) {
        wordsLipFrame = requestAnimationFrame(tick);
      } else if (wordsEliRiveInputs.size) {
        // No lip sync file — simple mouth flapping in speech rhythm
        wordsSetInput('is_speaking', true);
        wordsLipInterval = setInterval(() => {
          wordsSetInput('mouth_shape', 1 + Math.floor(Math.random() * 3));
        }, 110);
      }
    }).catch(finish);
    return audio;
  }

  async function playWordsScene(config) {
    if (!wordsScreen || !wordsCaption || !wordsMemories || !wordsCurrent || !wordsWheel || !wordsLetters || !wordsPath || !wordsReveal || !wordsRecovered) {
      fadeIn(); showMessage('Memory Words UI is missing.', true); return;
    }
    const sceneId = config.id;
    const w = config.words || {};
    const letters = String(w.letters || 'MOTHER').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 12).split('');
    const defaults = [
      { word: 'HOME', reveal: 'wet shoes beside the door' },
      { word: 'OTHER', reveal: 'a voice in the next room' },
      { word: 'MOTHER', reveal: 'someone saying his name softly' },
    ];
    const memories = (Array.isArray(w.memories) ? w.memories : defaults).slice(0, 3).map((memory, index) => ({
      ...defaults[index], ...(memory || {}), word: String(memory?.word || defaults[index].word).toUpperCase(),
    })).filter(memory => memory.word);
    const found = new Set();
    let selected = [];
    let selectedIndexes = new Set();
    let drawing = false;
    let complete = false;
    let failedAttempts = 0;

    showMessage(''); clearTextOverlay(); syncViewportVars();
    wordsScreen.style.display = 'flex';
    wordsScreen.className = 'words-screen';
    wordsCaption.textContent = w.intro || 'His memories are hiding in the letters.';
    wordsReveal.textContent = 'swipe through the letters.';
    wordsReveal.classList.remove('is-hint');
    wordsCurrent.textContent = '';
    wordsRecovered.classList.remove('is-visible');
    wordsRecovered.innerHTML = '';
    wordsPath.setAttribute('points', '');
    // Eli watching over the puzzle: a live Rive Eli with lip sync (words.eliRive),
    // or a static portrait (words.eliImage), or nothing.
    cleanupWordsEliRive();
    if (wordsEli && wordsEliImg) {
      wordsEli.classList.remove('is-speaking');
      if (w.eliRive) {
        try { mountWordsEliRive(sceneId, w.eliRive); }
        catch (err) { console.error('words Eli mount failed:', err); wordsEli.style.display = 'none'; }
      } else if (w.eliImage) {
        wordsEliImg.src = sceneAssetUrl(sceneId, `audio/${w.eliImage}`);
        wordsEliImg.style.display = '';
        wordsEli.style.display = '';
      } else {
        wordsEli.style.display = 'none';
      }
    }
    // Pre-fetch lip sync markers for every word voice so mouths sync instantly
    const wordsVoiceData = new Map();
    for (const memory of memories) {
      if (memory.voice) {
        fetchLipSyncData(sceneId, memory.voice)
          .then(d => wordsVoiceData.set(memory.word, d))
          .catch(() => {});
      }
    }
    fadeIn();
    for (const bg of getBgFiles(config)) {
      const a = makeAudio(sceneAssetUrl(sceneId, `audio/${bg}`)); a.loop = shouldLoopBackground(config, bg, true); a.volume = .45; a.play().catch(() => {}); activeBgAudios.push(a);
    }

    const buildCrossword = () => {
      const cells = new Map();
      const placements = [];
      const key = (x, y) => `${x},${y}`;
      const ordered = [...memories].sort((a, b) => b.word.length - a.word.length);
      const place = (memory, x, y, direction) => {
        const dx = direction === 'across' ? 1 : 0;
        const dy = direction === 'down' ? 1 : 0;
        const placement = { memory, x, y, direction, cells: [] };
        for (let i = 0; i < memory.word.length; i++) {
          const cx = x + dx * i, cy = y + dy * i, cellKey = key(cx, cy);
          let cell = cells.get(cellKey);
          if (!cell) { cell = { x: cx, y: cy, letter: memory.word[i], words: new Set() }; cells.set(cellKey, cell); }
          cell.words.add(memory.word); placement.cells.push(cell);
        }
        placements.push(placement);
      };
      const canPlace = (memory, x, y, direction) => {
        const dx = direction === 'across' ? 1 : 0, dy = direction === 'down' ? 1 : 0;
        for (let i = 0; i < memory.word.length; i++) {
          const existing = cells.get(key(x + dx * i, y + dy * i));
          if (existing && existing.letter !== memory.word[i]) return false;
        }
        return true;
      };
      if (ordered[0]) place(ordered[0], 0, 0, 'across');
      for (const memory of ordered.slice(1)) {
        let placed = false;
        for (const existingPlacement of placements) {
          for (let wi = 0; wi < memory.word.length && !placed; wi++) {
            for (let ei = 0; ei < existingPlacement.memory.word.length && !placed; ei++) {
              if (memory.word[wi] !== existingPlacement.memory.word[ei]) continue;
              const crossing = existingPlacement.cells[ei];
              const direction = existingPlacement.direction === 'across' ? 'down' : 'across';
              const x = crossing.x - (direction === 'across' ? wi : 0);
              const y = crossing.y - (direction === 'down' ? wi : 0);
              if (canPlace(memory, x, y, direction)) { place(memory, x, y, direction); placed = true; }
            }
          }
          if (placed) break;
        }
        if (!placed) {
          const maxY = Math.max(0, ...[...cells.values()].map(cell => cell.y));
          place(memory, 0, maxY + 2, 'across');
        }
      }
      const values = [...cells.values()];
      const minX = Math.min(0, ...values.map(cell => cell.x));
      const minY = Math.min(0, ...values.map(cell => cell.y));
      const maxX = Math.max(0, ...values.map(cell => cell.x));
      const maxY = Math.max(0, ...values.map(cell => cell.y));
      return { cells: values, cols: maxX - minX + 1, rows: maxY - minY + 1, minX, minY };
    };
    const crossword = buildCrossword();
    const renderMemorySlots = (newWord = null) => {
      wordsMemories.style.setProperty('--words-cols', String(crossword.cols));
      wordsMemories.style.setProperty('--words-rows', String(crossword.rows));
      const byPosition = new Map(crossword.cells.map(cell => [`${cell.x - crossword.minX},${cell.y - crossword.minY}`, cell]));
      let html = '';
      let newIndex = 0;   // stagger: the found word writes itself across the grid
      for (let y = 0; y < crossword.rows; y++) {
        for (let x = 0; x < crossword.cols; x++) {
          const cell = byPosition.get(`${x},${y}`);
          if (!cell) { html += '<span class="words-tile words-tile--empty"></span>'; continue; }
          const revealed = [...cell.words].some(word => found.has(word));
          const isNew = newWord && cell.words.has(newWord);
          const delay = isNew ? ` style="animation-delay:${newIndex++ * 70}ms"` : '';
          html += `<span class="words-tile ${revealed ? 'is-revealed' : ''}${isNew ? ' is-new' : ''}"${delay}><span>${revealed ? cell.letter : ''}</span></span>`;
        }
      }
      wordsMemories.innerHTML = html;
    };
    renderMemorySlots();

    wordsLetters.innerHTML = '';
    const letterButtons = [];
    const radius = letters.length > 9 ? 42 : 38;
    wordsWheel.style.setProperty('--words-letter-size', letters.length > 9 ? '38px' : letters.length > 7 ? '44px' : '52px');
    wordsWheel.style.setProperty('--words-letter-font', letters.length > 9 ? '19px' : letters.length > 7 ? '22px' : '25px');
    letters.forEach((letter, index) => {
      const angle = (-Math.PI / 2) + (Math.PI * 2 * index / letters.length);
      const x = 50 + Math.cos(angle) * radius;
      const y = 50 + Math.sin(angle) * radius;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'words-letter'; button.textContent = letter;
      button.dataset.index = String(index); button.dataset.x = String(x); button.dataset.y = String(y);
      button.style.left = `${x}%`; button.style.top = `${y}%`;
      wordsLetters.appendChild(button); letterButtons.push(button);
    });

    const later = (fn, ms) => setTimeout(() => { if (currentSceneId === sceneId) fn(); }, ms);
    const renderSelection = (live = null) => {
      const points = selected.map(button => `${button.dataset.x},${button.dataset.y}`);
      if (live) points.push(`${live.x},${live.y}`);
      wordsPath.setAttribute('points', points.join(' '));
      wordsCurrent.textContent = selected.map(button => button.textContent).join('');
    };
    const clearSelection = () => {
      for (const button of selected) button.classList.remove('is-selected');
      selected = []; selectedIndexes.clear(); wordsPath.setAttribute('points', ''); wordsCurrent.textContent = '';
    };
    const finishGame = () => {
      complete = true;
      playHaptic('heartbeat');
      if (w.fragment) {
        fetch('/api/memory/unlock', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({game:gameId||undefined,fragment:w.fragment}) }).catch(()=>{});
        recordRecovery(w.fragment, sceneId);
      }
      const dest = (config.after && config.after.next) || nextInSequence(sceneId);

      // Let the player's work become one carried memory before leaving the
      // puzzle. The recovered words orbit the ember, gather into it, and then
      // travel forward into the next scene.
      wordsCaption.textContent = w.foundText || 'You found the words he could not say.';
      wordsReveal.textContent = w.carryText || 'Take them back to Eli.';
      wordsReveal.classList.remove('is-hint');
      wordsRecovered.innerHTML = `
        <span class="words-recovered__core"></span>
        ${memories.map((memory, index) =>
          `<span class="words-recovered__word" style="--word-delay:${index * .42}s">${memory.word.charAt(0)}${memory.word.slice(1).toLowerCase()}</span>`
        ).join('')}`;
      wordsScreen.classList.add('is-recovered');
      wordsRecovered.classList.add('is-visible');

      // When this is currently the last authored scene, preserve the victory
      // tableau. As soon as a next scene is added, the same ending naturally
      // becomes a transition without further configuration.
      if (!dest) {
        later(() => playHaptic('soft'), 850);
        setupAfterTrigger(config);
        return;
      }

      later(() => {
        playHaptic('strong');
        wordsScreen.classList.add('is-departing');
      }, 3200);
      later(() => loadScene(dest), 4200);
    };
    const submitWord = () => {
      drawing = false;
      const word = selected.map(button => button.textContent).join('');
      const memory = memories.find(item => item.word === word);
      if (memory && !found.has(word)) {
        failedAttempts = 0;
        wordsReveal.classList.remove('is-hint');
        found.add(word); playHaptic('double'); wordsReveal.textContent = memory.reveal; renderMemorySlots(word);
        wordsScreen.classList.add('has-new-word'); later(() => wordsScreen.classList.remove('has-new-word'), 700);
        // Let the traced word swell gold and release before it clears —
        // the little dopamine beat of "I got it"
        for (const button of selected) button.classList.remove('is-selected');
        selected = []; selectedIndexes.clear(); wordsPath.setAttribute('points', '');
        wordsCurrent.classList.add('is-committing');
        later(() => { wordsCurrent.classList.remove('is-committing'); wordsCurrent.textContent = ''; }, 560);
        // Eli reacts out loud when a word is recovered (memory.voice),
        // lip-syncing if a live Rive Eli is mounted
        if (memory.voice) {
          if (wordsEli) wordsEli.classList.add('is-speaking');
          const isFinal = found.size === memories.length;
          let finished = false;
          const go = () => { if (!finished) { finished = true; finishGame(); } };
          const markers = wordsVoiceData.get(memory.word)?.markers || [];
          playWordsEliLine(sceneId, memory.voice, markers, () => {
            if (wordsEli) wordsEli.classList.remove('is-speaking');
            if (isFinal) later(go, 500);   // let the line land before the finale
          });
          if (isFinal) later(go, 10000);   // safety cap if audio never ends
          return;
        }
        if (found.size === memories.length) later(finishGame, 850);
      } else {
        wordsCurrent.classList.add('is-dissolving');
        if (found.has(word)) {
          wordsReveal.classList.remove('is-hint');
          wordsReveal.textContent = 'you already found that memory.';
        } else {
          failedAttempts++;
          const hintAfter = Math.max(1, Number(w.hintAfter) || 3);
          const remaining = memories.filter(item => !found.has(item.word));
          if (failedAttempts >= hintAfter && remaining.length) {
            const hintIndex = Math.floor((failedAttempts - hintAfter) / 2) % remaining.length;
            const hintWord = remaining[hintIndex].word;
            wordsReveal.classList.add('is-hint');
            wordsReveal.textContent = `hint: one memory starts with “${hintWord.charAt(0)}” and has ${hintWord.length} letters.`;
          } else {
            wordsReveal.classList.remove('is-hint');
            wordsReveal.textContent = 'the word slips away.';
          }
        }
        later(() => { wordsCurrent.classList.remove('is-dissolving'); clearSelection(); }, 450);
      }
    };
    const addLetter = (button) => {
      if (!button || complete) return;
      const index = Number(button.dataset.index);
      if (selectedIndexes.has(index)) return;
      selectedIndexes.add(index); selected.push(button); button.classList.add('is-selected'); playHaptic('tap'); renderSelection();
    };
    const pointerPos = event => { const rect=wordsWheel.getBoundingClientRect(); return {x:(event.clientX-rect.left)/rect.width*100,y:(event.clientY-rect.top)/rect.height*100}; };
    wordsWheel.onpointerdown = event => {
      const button = event.target.closest('.words-letter'); if (!button || complete) return;
      event.preventDefault(); drawing = true; wordsWheel.setPointerCapture?.(event.pointerId); addLetter(button);
    };
    wordsWheel.onpointermove = event => {
      if (!drawing || complete) return;
      const button = document.elementFromPoint(event.clientX,event.clientY)?.closest?.('.words-letter');
      if (button && wordsLetters.contains(button)) addLetter(button);
      renderSelection(pointerPos(event));
    };
    wordsWheel.onpointerup = () => { if (drawing && !complete) submitWord(); };
    wordsWheel.onpointercancel = () => { if (drawing && !complete) submitWord(); };
  }

  // ─── Pairs (memory game) scene ───────────────────────────────────────────────
  // A proven match-the-pairs loop reskinned as remembering: every matched pair
  // is a fragment of Eli's memory. Winning reports the scene's fragment to the
  // server so Eli's chat brain can reference it, then follows FALLBACK.
  const PAIRS_GLYPHS = ['☾', '☂', '✉', '⌛', '♪', '❀', '✶', '☁', '⚘', '✂', '☕', '⚷'];

  function pairsDayKey(sceneId) {
    return `eli.pairs.${gameId || 'default'}.${sceneId}`;
  }

  // A mini-game win leaves a short-lived "just recovered" record so the next
  // chat scene can open with Eli noticing it (Beat 5). Consumed on read.
  function recoveredKey() {
    return `eli.recovered.${gameId || 'default'}`;
  }
  function recordRecovery(fragment, sceneId) {
    try { localStorage.setItem(recoveredKey(), JSON.stringify({ fragment, sceneId, ts: Date.now() })); } catch {}
  }
  function consumeRecovery(maxAgeMs = 30 * 60 * 1000) {
    try {
      const raw = localStorage.getItem(recoveredKey());
      if (!raw) return null;
      localStorage.removeItem(recoveredKey());
      const rec = JSON.parse(raw);
      return rec && rec.fragment && (Date.now() - rec.ts) < maxAgeMs ? rec : null;
    } catch { return null; }
  }

  // Read without consuming: the Give ritual may look at the carried fragment,
  // but only Eli's first chat response is allowed to spend it.
  function peekRecovery(maxAgeMs = 30 * 60 * 1000) {
    try {
      const raw = localStorage.getItem(recoveredKey());
      if (!raw) return null;
      const rec = JSON.parse(raw);
      return rec && rec.fragment && (Date.now() - rec.ts) < maxAgeMs ? rec : null;
    } catch { return null; }
  }

  async function playPairsScene(config) {
    if (!pairsScreen || !pairsBoard) { fadeIn(); showMessage('Pairs UI is missing.', true); return; }
    const sceneId = config.id;
    const p = config.pairs || {};
    showMessage('');
    clearTextOverlay();
    syncViewportVars();
    pairsScreen.style.display = 'flex';
    pairsScreen.classList.remove('is-recovered');
    pairsBoard.innerHTML = '';
    pairsFound.textContent = '';
    fadeIn();

    // Timers die with the scene — a stray flip-back or win advance from a
    // previous board must never fire into the scene that replaced it.
    const later = (fn, ms) => setTimeout(() => { if (currentSceneId === sceneId) fn(); }, ms);

    // Background audio (same file roles as every other scene)
    for (const bg of getBgFiles(config)) {
      const a = makeAudio(sceneAssetUrl(sceneId, `audio/${bg}`));
      a.loop = shouldLoopBackground(config, bg, true); a.volume = 0.5;
      a.play().catch(() => {});
      activeBgAudios.push(a);
    }

    // Once-per-day lock (off unless the editor enables it; previews bypass it)
    const today = new Date().toISOString().slice(0, 10);
    let locked = false;
    if (p.daily === true && !devMode) {
      try { locked = localStorage.getItem(pairsDayKey(sceneId)) === today; } catch {}
    }
    if (locked) {
      pairsCaption.textContent = p.lockText || 'He’s resting now... come back tomorrow.';
      pairsCaption.classList.add('is-visible');
      return;
    }

    pairsCaption.textContent = p.intro || 'Help him remember...';
    pairsCaption.classList.add('is-visible');

    // Card faces: uploaded images with the "card" role, else built-in glyphs
    const files = config.files || {};
    const cardImgs = Object.keys(files).filter(f => files[f] === 'card');
    const count = Math.max(2, Math.min(12, Math.round(Number(p.count)) || 6));
    const faces = cardImgs.length >= count
      ? cardImgs.slice(0, count).map(f => ({ img: sceneAssetUrl(sceneId, `audio/${f}`) }))
      : PAIRS_GLYPHS.slice(0, count).map(g => ({ glyph: g }));

    const deck = faces.flatMap((face, key) => [{ face, key }, { face, key }]);
    for (let i = deck.length - 1; i > 0; i--) {          // Fisher–Yates shuffle
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    const cols = deck.length <= 8 ? 3 : 4;
    pairsBoard.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

    let first = null;         // first flipped card this turn
    let inputLocked = false;  // during the mismatch flip-back
    let matched = 0;
    let mismatches = 0;
    let choices = 0;
    let lastChoiceAt = performance.now();
    let totalChoiceMs = 0;

    function onWin() {
      playHaptic('heartbeat');
      pairsScreen.classList.add('is-recovered');
      pairsCaption.textContent = p.foundText || 'you found something he lost.';
      pairsCaption.classList.add('is-visible');
      pairsFound.innerHTML = '<span class="pairs-recovered-ember" aria-hidden="true"></span>';
      if (p.daily === true && !devMode) { try { localStorage.setItem(pairsDayKey(sceneId), today); } catch {} }
      if (p.fragment) {
        fetch('/api/memory/unlock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game: gameId || undefined, fragment: p.fragment }),
        }).catch(() => {});
        recordRecovery(p.fragment, sceneId);
      }
      // Temporary extraction proxy: quick uncertain guesses lean risk; slower,
      // accurate observation leans caution. Only the aggregate reaches Eli.
      const averageChoiceMs = choices ? totalChoiceMs / choices : 0;
      const signal = mismatches >= 3 || averageChoiceMs < 900 ? 'risk' : 'caution';
      fetch('/api/behavior/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game: gameId || undefined, signal, scene: sceneId }),
      }).catch(() => {});
      later(() => {
        pairsCaption.textContent = p.carryText || 'take it back to him.';
      }, 1550);
      later(() => setupAfterTrigger(config), 3500);
    }

    for (const card of deck) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pairs-card';
      btn.innerHTML = `
        <span class="pairs-card__inner">
          <span class="pairs-card__back"></span>
          <span class="pairs-card__face">${card.face.img
            ? `<img src="${card.face.img}" alt="" draggable="false" />`
            : `<span class="pairs-card__glyph">${card.face.glyph}</span>`}</span>
        </span>`;
      btn.addEventListener('click', () => {
        if (inputLocked || btn.classList.contains('is-flipped') || btn.classList.contains('is-matched')) return;
        ensureMumbleUnlocked();
        const choiceAt = performance.now();
        totalChoiceMs += choiceAt - lastChoiceAt;
        lastChoiceAt = choiceAt;
        choices++;
        btn.classList.add('is-flipped');
        playHaptic('tap');
        if (!first) { first = { btn, key: card.key }; return; }

        if (first.key === card.key) {
          btn.classList.add('is-matched');
          first.btn.classList.add('is-matched');
          first = null;
          matched++;
          playHaptic('double');
          pairsFound.textContent = matched < count ? (p.progressText || 'something is taking shape') : '';
          if (matched === count) later(onWin, 650);
        } else {
          mismatches++;
          const a = first.btn;
          first = null;
          inputLocked = true;
          later(() => {
            a.classList.remove('is-flipped');
            btn.classList.remove('is-flipped');
            inputLocked = false;
          }, 750);
        }
      });
      pairsBoard.appendChild(btn);
    }
  }

  // ─── Jigsaw (photo restoration) scene ────────────────────────────────────────
  // A proven jigsaw loop reskinned as reconstructing a memory: the photo is
  // shuffled into tiles, tap two to swap. Solving it reveals the picture,
  // reports the scene's fragment to the server so Eli's chat brain can
  // reference it, then follows FALLBACK.
  function jigsawDayKey(sceneId) {
    return `eli.jigsaw.${gameId || 'default'}.${sceneId}`;
  }

  // Grid shape per piece count — kept in sync with the editor's options.
  const JIGSAW_GRIDS = { 4: [2, 2], 6: [3, 2], 9: [3, 3], 12: [3, 4], 16: [4, 4] };  // pieces → [cols, rows]

  // No photo uploaded yet → draw a placeholder in the game's look so the
  // scene stays testable before art exists (same spirit as the pairs glyphs).
  function jigsawPlaceholder() {
    const c = document.createElement('canvas');
    c.width = 600; c.height = 800;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0d0a07';
    ctx.fillRect(0, 0, 600, 800);
    const glow = ctx.createRadialGradient(300, 430, 40, 300, 430, 360);
    glow.addColorStop(0, 'rgba(150, 30, 12, 0.5)');
    glow.addColorStop(1, 'rgba(150, 30, 12, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 600, 800);
    ctx.font = '200px Schoolbell, cursive';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#C1A376';
    ctx.shadowColor = 'rgba(193, 163, 118, 0.5)';
    ctx.shadowBlur = 30;
    ctx.fillText('☾', 300, 400);
    return c.toDataURL('image/png');
  }

  async function playJigsawScene(config) {
    if (!jigsawScreen || !jigsawBoard) { fadeIn(); showMessage('Jigsaw UI is missing.', true); return; }
    const sceneId = config.id;
    const j = config.jigsaw || {};
    showMessage('');
    clearTextOverlay();
    syncViewportVars();
    jigsawScreen.style.display = 'flex';
    jigsawBoard.innerHTML = '';
    jigsawBoard.classList.remove('is-solved', 'is-winwave', 'is-bloom', 'is-alive');
    jigsawCaption.classList.remove('is-win');
    jigsawPlaced.textContent = '';
    fadeIn();

    // Timers die with the scene — a stray win advance from a previous board
    // must never fire into the scene that replaced it.
    const later = (fn, ms) => setTimeout(() => { if (currentSceneId === sceneId) fn(); }, ms);

    // Background audio (same file roles as every other scene)
    for (const bg of getBgFiles(config)) {
      const a = makeAudio(sceneAssetUrl(sceneId, `audio/${bg}`));
      a.loop = shouldLoopBackground(config, bg, true); a.volume = 0.5;
      a.play().catch(() => {});
      activeBgAudios.push(a);
    }

    // Once-per-day lock (off unless the editor enables it; previews bypass it)
    const today = new Date().toISOString().slice(0, 10);
    let locked = false;
    if (j.daily === true && !devMode) {
      try { locked = localStorage.getItem(jigsawDayKey(sceneId)) === today; } catch {}
    }
    if (locked) {
      jigsawCaption.textContent = j.lockText || 'He’s resting now... come back tomorrow.';
      jigsawCaption.classList.add('is-visible');
      return;
    }

    jigsawCaption.textContent = j.intro || 'Put it back together...';
    jigsawCaption.classList.add('is-visible');

    // The photo: uploaded image with the "photo" role, else the placeholder
    const files = config.files || {};
    const photoFile = Object.keys(files).find(f => files[f] === 'photo') || null;
    const photoUrl = photoFile ? sceneAssetUrl(sceneId, `audio/${photoFile}`) : jigsawPlaceholder();

    const pieces = JIGSAW_GRIDS[Number(j.pieces)] ? Number(j.pieces) : 9;
    const [cols, rows] = JIGSAW_GRIDS[pieces];
    jigsawBoard.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    jigsawBoard.style.setProperty('--jigsaw-aspect', `${cols} / ${rows}`);

    // Shuffle slot order (Fisher–Yates), re-shuffling if it lands solved
    let order;
    do {
      order = Array.from({ length: pieces }, (_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const k = Math.floor(Math.random() * (i + 1));
        [order[i], order[k]] = [order[k], order[i]];
      }
    } while (order.every((v, i) => v === i));

    let selected = null;      // first tapped tile this turn
    let solvedLock = false;   // input freeze during the win reveal

    const countPlaced = () =>
      [...jigsawBoard.children].filter((el, slot) => Number(el.dataset.piece) === slot).length;

    function updatePlaced() {
      const placed = countPlaced();
      jigsawPlaced.textContent = `${placed} / ${pieces}`;
      return placed;
    }

    // Golden dust motes drifting up from the restored photo — the reward particles
    function spawnJigsawSparks() {
      for (let i = 0; i < 28; i++) {
        const s = document.createElement('span');
        s.className = 'jigsaw-spark';
        s.style.left = `${6 + Math.random() * 88}%`;
        s.style.top  = `${25 + Math.random() * 70}%`;
        s.style.setProperty('--spark-delay', `${(Math.random() * 1.8).toFixed(2)}s`);
        s.style.setProperty('--spark-drift', `${(Math.random() * 44 - 22).toFixed(0)}px`);
        s.style.setProperty('--spark-size',  `${(2 + Math.random() * 3.5).toFixed(1)}px`);
        jigsawBoard.appendChild(s);
        setTimeout(() => s.remove(), 5200);
      }
    }

    function onWin() {
      solvedLock = true;
      jigsawCaption.textContent = '';
      jigsawCaption.classList.remove('is-visible');
      jigsawPlaced.textContent = '';

      // Win sequence: cascade wave → seams melt → bloom flash + shine + sparks → photo breathes
      const cx = (cols - 1) / 2, cy = (rows - 1) / 2;
      [...jigsawBoard.children].forEach(tile => {
        const slot = Number(tile.dataset.slot);
        if (!Number.isFinite(slot)) return;
        const dist = Math.hypot((slot % cols) - cx, Math.floor(slot / cols) - cy);
        tile.style.setProperty('--wave-delay', `${Math.round(dist * 95)}ms`);
      });
      jigsawBoard.classList.add('is-winwave');           // 0s — golden pulse ripples out from the center
      playHaptic('tap');
      later(() => jigsawBoard.classList.add('is-solved'), 700);    // seams melt — the photo becomes whole
      later(() => {                                                // impact beat
        jigsawBoard.classList.add('is-bloom');
        playHaptic('heartbeat');
        spawnJigsawSparks();
        // Win audio — any file given the "Win audio" role in the editor
        const winFile = Object.keys(config.files || {}).find(f => (config.files || {})[f] === 'win');
        if (winFile) {
          const a = makeAudio(sceneAssetUrl(sceneId, `audio/${winFile}`));
          a.volume = 0.9;
          a.play().catch(() => {});
        }
      }, 1250);
      later(() => jigsawBoard.classList.add('is-alive'), 2000);    // slow Ken Burns — the memory comes alive

      if (j.daily === true && !devMode) { try { localStorage.setItem(jigsawDayKey(sceneId), today); } catch {} }
      if (j.fragment) {
        fetch('/api/memory/unlock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game: gameId || undefined, fragment: j.fragment }),
        }).catch(() => {});
        recordRecovery(j.fragment, sceneId);
      }
      // Win text appears in the caption slot ABOVE the photo — never over it
      later(() => {
        jigsawCaption.textContent = j.winText || 'I remember this...';
        jigsawCaption.classList.add('is-visible', 'is-win');
      }, 2700);
      later(() => setupAfterTrigger(config), 6200);
    }

    // Tiles live in fixed grid slots; swapping exchanges which photo piece a
    // slot shows (data-piece + background-position) — no DOM reordering.
    const pieceBgPos = (piece) => {
      const px = piece % cols, py = Math.floor(piece / cols);
      return `${cols === 1 ? 0 : (px / (cols - 1)) * 100}% ${rows === 1 ? 0 : (py / (rows - 1)) * 100}%`;
    };

    function setPiece(tile, piece) {
      tile.dataset.piece = String(piece);
      tile.style.backgroundPosition = pieceBgPos(piece);
      tile.classList.toggle('is-placed', Number(tile.dataset.slot) === piece);
    }

    order.forEach((piece, slot) => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'jigsaw-tile';
      tile.dataset.slot = String(slot);
      tile.style.backgroundImage = `url("${photoUrl}")`;
      tile.style.backgroundSize = `${cols * 100}% ${rows * 100}%`;
      setPiece(tile, piece);
      tile.addEventListener('click', () => {
        if (solvedLock) return;
        ensureMumbleUnlocked();
        if (selected === tile) {          // tap again to deselect
          tile.classList.remove('is-selected');
          selected = null;
          return;
        }
        playHaptic('tap');
        if (!selected) {
          selected = tile;
          tile.classList.add('is-selected');
          return;
        }
        // Swap the two pieces
        const a = selected;
        selected = null;
        a.classList.remove('is-selected');
        const pa = Number(a.dataset.piece);
        const pb = Number(tile.dataset.piece);
        setPiece(a, pb);
        setPiece(tile, pa);
        a.classList.remove('is-swapped'); tile.classList.remove('is-swapped');
        void a.offsetWidth;               // restart the pulse animation
        a.classList.add('is-swapped'); tile.classList.add('is-swapped');
        const placedNow = a.classList.contains('is-placed') || tile.classList.contains('is-placed');
        playHaptic(placedNow ? 'double' : 'soft');
        if (updatePlaced() === pieces) later(onWin, 500);
      });
      jigsawBoard.appendChild(tile);
    });
    updatePlaced();
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

    // Timed captions authored in the editor (config.captions: [{t, text, d}]).
    // Each shows at its time and holds until its duration — or until the next
    // caption if no duration is set (5s fallback on the last one).
    const captions = (Array.isArray(config.captions) ? config.captions : [])
      .filter(c => c && Number.isFinite(Number(c.t)) && String(c.text || '').trim())
      .map(c => ({ t: Number(c.t), d: Number(c.d) || 0, text: String(c.text).trim() }))
      .sort((a, b) => a.t - b.t);
    let capIdx = -1;
    sceneVideo.ontimeupdate = captions.length ? () => {
      const now = sceneVideo.currentTime;
      let idx = -1;
      for (let i = 0; i < captions.length; i++) if (captions[i].t <= now) idx = i;
      if (idx === capIdx) return;
      capIdx = idx;
      if (idx < 0) return;
      const c = captions[idx];
      const holdFor = c.d > 0 ? c.d : (captions[idx + 1] ? Math.max(1, captions[idx + 1].t - c.t) : 5);
      showTextOverlay(c.text, holdFor, { fontSize: 22, color: '#e6d3ae', position: 'bottom', fontWeight: '700', lipSync: false });
    } : null;

    const skipNext = () => {
      sceneVideo.pause();
      sceneVideo.ontimeupdate = null;
      clearTextOverlay();
      const after = config.after || {};
      if (after.next) loadScene(after.next);
    };

    sceneVideo.onended = skipNext;

    const skipBtn = document.getElementById('videoSkip');
    if (skipBtn) skipBtn.onclick = skipNext;

    fadeIn();
    try {
      await sceneVideo.play();
      showMessage('');
    } catch {
      requestPlaybackTap('touch to stay with him', async () => { await sceneVideo.play(); });
    }
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
    const hasVoice = getVoiceFile(config);
    const waitingRecovery = peekRecovery();

    // Treat beat: a recovered fragment must be deliberately held into Eli's
    // heart before the Notice beat can begin. Segmented scenes can explicitly
    // opt in by defining `give`, allowing an authored finale after the ritual.
    const shouldGive = waitingRecovery && (config.give || (!hasSegments && !hasVoice && config.give !== false));
    if (shouldGive) {
      await playGiveRitual(config.give || {});
      if (currentSceneId !== config.id) return;
      // Segment/voice finales provide their own authored Notice line, so they
      // spend the recovery here. Open chat remains the consumer otherwise.
      if (hasSegments || hasVoice) consumeRecovery();
    }

    if (hasSegments) {
      playSegment(config, 0);
    } else {
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
        showTextOverlay(reply, 8, { fontSize: 28, color: '#C1A376', position: 'caption', fontWeight: '700', hold: true });
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

    // If the player just recovered a memory in a mini-game, Eli speaks first
    // and notices it — the payoff is the noticing, not a reward screen.
    // Skipped for segment/voice scenes so it can't talk over authored lines.
    if (!hasSegments && !getVoiceFile(config)) {
      const rec = consumeRecovery();
      if (rec) {
        const memoryId = String(rec.fragment).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
        const authoredLine = config.recoveredLines?.[memoryId];
        if (authoredLine) {
          chatMessages.push({ role: 'assistant', content: authoredLine });
          setInput('emotion_state', 6);
          setInput('heart_state', 5);
          setInput('body_movement', 3);
          showTextOverlay(authoredLine, 8, { fontSize: 28, color: '#C1A376', position: 'caption', fontWeight: '700', hold: true });
        } else {
          sendMessage(`[The player just completed the remembering ritual and helped you recover a memory: "${rec.fragment}". The fog has lifted a little — you feel slightly clearer, slightly steadier, and it is because of them. Open by noticing this yourself: reference that memory specifically, with quiet wonder, as if it just surfaced. Do not thank them like a game reward and do not mention any game — the memory itself is the gift. Use emotion "remembering" and body "heart_glow" in this reply.]`);
        }
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

  function playGiveRitual(rawConfig) {
    const ritual = document.getElementById('giveRitual');
    const ember = document.getElementById('giveEmber');
    const heart = document.getElementById('giveHeart');
    const glow = document.getElementById('giveGlow');
    const whisper = document.getElementById('giveWhisper');
    if (!ritual || !ember || !heart || !glow || !whisper) return Promise.resolve();

    const holdMs = Math.max(800, Number(rawConfig.holdMs) || 3200);
    const hint = rawConfig.hint || "he can't take it himself.";
    const timers = [];
    let frame = null;
    let startedAt = 0;
    let earlyReleases = 0;
    let complete = false;
    let settled = false;
    let resolveRitual;
    const done = new Promise(resolve => { resolveRitual = resolve; });
    const later = (fn, ms) => { const id = setTimeout(fn, ms); timers.push(id); return id; };

    const setProgress = (value) => {
      const p = Math.max(0, Math.min(1, value));
      ritual.style.setProperty('--give-progress', String(p));
      setInput('give_progress', p * 100);
    };
    const resetVisuals = () => {
      ritual.classList.remove('is-holding');
      ritual.classList.add('was-released');
      setProgress(0);
      setInput('heart_state', 6);
      setInput('body_movement', 0);
      later(() => ritual.classList.remove('was-released'), 420);
    };
    const cancelHold = () => {
      if (complete || !startedAt) return;
      startedAt = 0;
      if (frame) cancelAnimationFrame(frame);
      frame = null;
      earlyReleases++;
      resetVisuals();
      if (earlyReleases === 2) {
        later(() => {
          whisper.textContent = rawConfig.retryHint || 'gently. all the way.';
          whisper.classList.add('is-visible');
        }, 2000);
      }
    };
    const finish = () => {
      complete = true;
      startedAt = 0;
      if (frame) cancelAnimationFrame(frame);
      frame = null;
      ritual.classList.remove('is-holding');
      ritual.classList.add('is-complete');
      setProgress(1);
      playHaptic('soft');
      setInput('heart_state', 5);
      later(() => setInput('emotion_state', 6), 400);
      later(() => setInput('body_movement', 15), 800);
      later(() => setInput('body_movement', 3), 1600);
      later(() => { whisper.textContent = '...'; whisper.classList.add('is-visible'); }, 2200);
      later(() => {
        ritual.classList.add('is-exiting');
        later(cleanup, 320);
      }, 3000);
    };
    const update = () => {
      if (!startedAt || complete) return;
      const progress = Math.min(1, (performance.now() - startedAt) / holdMs);
      setProgress(progress);
      if (progress >= 1) finish();
      else frame = requestAnimationFrame(update);
    };
    const startHold = (event) => {
      if (complete || startedAt) return;
      event.preventDefault();
      heart.setPointerCapture?.(event.pointerId);
      startedAt = performance.now();
      ritual.classList.remove('was-released');
      ritual.classList.add('is-holding');
      setInput('heart_state', 1);
      setInput('body_movement', 3);
      playHaptic('tap');
      playHaptic('heartbeat');
      later(() => { if (startedAt && !complete) playHaptic('heartbeat'); }, 1200);
      later(() => { if (startedAt && !complete) playHaptic('heartbeat'); }, 2400);
      update();
    };
    const onVisibility = () => { if (document.hidden) cancelHold(); };
    const cleanup = () => {
      if (settled) return;
      settled = true;
      for (const id of timers) clearTimeout(id);
      if (frame) cancelAnimationFrame(frame);
      heart.removeEventListener('pointerdown', startHold);
      heart.removeEventListener('pointerup', cancelHold);
      heart.removeEventListener('pointercancel', cancelHold);
      heart.removeEventListener('lostpointercapture', cancelHold);
      document.removeEventListener('visibilitychange', onVisibility);
      ritual.className = 'give-ritual';
      ritual.setAttribute('aria-hidden', 'true');
      whisper.classList.remove('is-visible');
      setProgress(0);
      activeGiveCleanup = null;
      resolveRitual();
    };

    activeGiveCleanup = cleanup;
    ritual.className = 'give-ritual is-active';
    ritual.setAttribute('aria-hidden', 'false');
    whisper.textContent = '';
    setProgress(0);
    setInput('heart_state', 6);
    heart.addEventListener('pointerdown', startHold);
    heart.addEventListener('pointerup', cancelHold);
    heart.addEventListener('pointercancel', cancelHold);
    heart.addEventListener('lostpointercapture', cancelHold);
    document.addEventListener('visibilitychange', onVisibility);
    later(() => {
      whisper.textContent = hint;
      whisper.classList.add('is-visible');
    }, 2000);
    later(() => {
      if (!startedAt && !complete) {
        whisper.classList.remove('is-visible');
        later(() => { whisper.textContent = hint; whisper.classList.add('is-visible'); }, 500);
      }
    }, 12000);
    return done;
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
    if (threadScreen) threadScreen.style.display = 'none';
    if (wordsScreen) wordsScreen.style.display = 'none';
    if (pairsScreen) pairsScreen.style.display = 'none';
    if (jigsawScreen) jigsawScreen.style.display = 'none';
  }

  function showMessage(text, isError = false) {
    messageEl.onclick = null;
    messageEl.style.pointerEvents = 'none';
    messageEl.textContent  = text;
    messageEl.style.display = text ? 'block' : 'none';
    messageEl.classList.toggle('is-error', !!isError);
  }

  function requestPlaybackTap(text, onStart) {
    showMessage(text, false);
    messageEl.style.pointerEvents = 'auto';
    messageEl.style.cursor = 'pointer';
    messageEl.onclick = async () => {
      messageEl.onclick = null;
      messageEl.style.pointerEvents = 'none';
      try {
        await onStart();
        showMessage('');
      } catch {
        requestPlaybackTap(text, onStart);
      }
    };
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
