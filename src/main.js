(function () {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────────
  const params    = new URLSearchParams(window.location.search);
  const startScene = params.get('scene') || null;  // ?scene=id forces a specific scene
  const isPreview  = params.get('preview') === '1';

  let sequence        = null;   // sequence.json
  let currentSceneId  = null;
  let riveInstance    = null;
  let inputByName     = new Map();
  let navPollFrame    = null;   // RAF id for boolean-input polling
  let activeLipSyncAudio  = null;
  let activeLipSyncFrame  = null;
  let segmentCleanup  = null;
  let activeSegmentBg = null;
  let riveBufferCache = new Map();
  let chatMemory      = {};
  let chatMessages    = [];

  // ─── DOM refs ────────────────────────────────────────────────────────────────
  const stage       = document.getElementById('stage');
  const canvas      = document.getElementById('canvas');
  const videoScreen = document.getElementById('videoScreen');
  const sceneVideo  = document.getElementById('sceneVideo');
  const chatScreen  = document.getElementById('chatScreen');
  const chatCanvas  = document.getElementById('chatCanvas');
  const chatThread  = document.getElementById('chatThread');
  const chatForm    = document.getElementById('chatForm');
  const chatInput   = document.getElementById('chatInput');
  const messageEl   = document.getElementById('message');
  const fadeEl      = document.getElementById('fade');

  // ─── Boot ────────────────────────────────────────────────────────────────────
  window.addEventListener('load', boot);

  async function boot() {
    showMessage('Loading…');
    try {
      const res = await fetch(`./sequence.json?v=${Date.now()}`, { cache: 'no-store' });
      sequence = res.ok ? await res.json() : { scenes: [], start: null };
    } catch { sequence = { scenes: [], start: null }; }

    const first = startScene || sequence.start || (sequence.scenes && sequence.scenes[0]) || null;
    if (!first) { showMessage('No scenes yet. Open the editor to get started.', true); return; }
    await loadScene(first);
  }

  // ─── Scene loader ────────────────────────────────────────────────────────────
  async function loadScene(id) {
    // Cancel any running input-poll loop or segment trigger from the previous scene
    if (navPollFrame) { cancelAnimationFrame(navPollFrame); navPollFrame = null; }
    if (segmentCleanup) { segmentCleanup(); segmentCleanup = null; }
    if (activeSegmentBg) { activeSegmentBg.pause(); activeSegmentBg = null; }
    currentSceneId = id;
    await fadeOut();

    let config = null;
    try {
      const res = await fetch(`./scenes/${id}/scene.json?v=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) config = await res.json();
    } catch {}

    if (!config) { showMessage(`Scene "${id}" not found.`, true); return; }

    hideAll();

    if (config.type === 'rive')  await playRiveScene(config);
    if (config.type === 'video') await playVideoScene(config);
    if (config.type === 'chat')  await playChatScene(config);
  }

  // ─── Rive scene ──────────────────────────────────────────────────────────────
  async function playRiveScene(config) {
    stage.style.display = 'block';
    showMessage('Loading…');

    if (!config.rive) {
      fadeIn(); showMessage('No Rive file set for this scene. Upload one in the editor.', true); return;
    }

    const rivePath = config.rive === 'shared'
      ? './public/rive/eli.riv'
      : `./scenes/${config.id}/${config.rive}`;

    // Fetch and cache the .riv buffer so shared files only download once
    let buffer = riveBufferCache.get(rivePath);
    if (!buffer) {
      try {
        const res = await fetch(`${rivePath}?v=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) { fadeIn(); showMessage(`Rive file "${config.rive}" not found — upload it in the editor.`, true); return; }
        buffer = await res.arrayBuffer();
        riveBufferCache.set(rivePath, buffer);
      } catch (err) {
        fadeIn(); showMessage(`Failed to load Rive file: ${err.message}`, true); return;
      }
    }

    if (riveInstance) { try { riveInstance.cleanup(); } catch {} riveInstance = null; }

    if (typeof rive === 'undefined' || !rive.Rive) {
      fadeIn();
      showMessage('Error: Rive script failed to load. Check your internet connection and reload.', true);
      return;
    }

    const smNames = Array.isArray(config.stateMachines) && config.stateMachines.length
      ? config.stateMachines
      : ['EliState', 'EliBody', 'FacialState', 'EmotionState'];

    // Set canvas dimensions before init
    canvas.width  = window.innerWidth  * devicePixelRatio;
    canvas.height = window.innerHeight * devicePixelRatio;

    let riveLoaded = false;
    const riveTimeout = setTimeout(() => {
      if (!riveLoaded) {
        fadeIn();
        showMessage('Rive is taking too long — check the browser console for errors.', true);
      }
    }, 15000);

    const artboard  = config.artboard  || undefined;
    const fitMode   = config.fit === 'cover' ? rive.Fit.Cover : rive.Fit.Contain;

    try {
      riveInstance = new rive.Rive({
        buffer,
        canvas,
        ...(artboard ? { artboard } : {}),
        autoplay: true,
        fit: fitMode,
        alignment: rive.Alignment.Center,
        useOffscreenRenderer: true,
        stateMachines: smNames,
        onLoad: () => {
          riveLoaded = true;
          clearTimeout(riveTimeout);
          resizeCanvas();
          inputByName = collectInputs(smNames);
          fadeIn();
          playVoiceLines(config);

          // Listen for named Rive Events (output events fired from state machine actions)
          if (riveInstance.on && rive.EventType?.RiveEvent) {
            riveInstance.on(rive.EventType.RiveEvent, (event) => {
              const name = event?.data?.name;
              if (!name) return;
              handleRiveEvent(name, config);
            });
          }

          // Poll nav inputs — explicit routes + nav_* convention + legacy after.trigger
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
          if (routeNames.length) {
            let didNavigate = false;
            const pollNav = () => {
              // Pause nav polling during lip sync so body markers don't trigger navigation
              if (activeLipSyncAudio && !activeLipSyncAudio.paused && !activeLipSyncAudio.ended) {
                navPollFrame = requestAnimationFrame(pollNav);
                return;
              }
              for (const name of routeNames) {
                const inp = getInputByRouteName(name);
                if (isNavigationInputActive(inp)) {
                  didNavigate = true;
                  navPollFrame = null;
                  handleRiveEvent(name, config);
                  return;
                }
              }
              if (didNavigate) return;
              navPollFrame = requestAnimationFrame(pollNav);
            };
            navPollFrame = requestAnimationFrame(pollNav);
          }
        },
        onLoadError: (err) => {
          riveLoaded = true;
          clearTimeout(riveTimeout);
          fadeIn();
          showMessage(`Rive error: ${err?.message || err?.type || JSON.stringify(err) || 'unknown — check browser console'}`, true);
        },
      });
    } catch (err) {
      clearTimeout(riveTimeout);
      fadeIn();
      showMessage(`Rive init failed: ${err?.message || err}`, true);
    }

    if (config.after?.trigger === 'tap_heart') {
      canvas.addEventListener('pointerup', () => {
        handleInteraction('tap_heart', config);
      }, { once: true });
    }
  }

  function collectInputs(smNames) {
    const map = new Map();
    if (!riveInstance) return map;
    const names = smNames || riveInstance.stateMachineNames || [];
    for (const sm of names) {
      try {
        for (const input of (riveInstance.stateMachineInputs(sm) || [])) {
          map.set(input.name, input);
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
    // Segments mode: play a chain of voice clips with triggers between them
    if (Array.isArray(config.segments) && config.segments.length) {
      // Background audio plays once at the start
      for (const bg of getBgFiles(config)) {
        const bgAudio = new Audio(`./scenes/${config.id}/audio/${bg}`);
        bgAudio.volume = 0.65;
        bgAudio.play().catch(() => {});
      }
      playSegment(config, 0);
      return;
    }

    // Legacy single-voice mode
    const voiceFile = getVoiceFile(config);
    if (!voiceFile) {
      setupAfterTrigger(config);
      return;
    }

    const bgFiles = getBgFiles(config);
    const baseName = voiceFile.replace(/\.[^.]+$/, '');
    const audioUrl = `./scenes/${config.id}/audio/${voiceFile}`;
    const jsonUrl  = `./scenes/${config.id}/audio/${baseName}.lipsync.json`;

    let markers = [];
    try {
      const res = await fetch(`${jsonUrl}?v=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) markers = sanitizeMarkers((await res.json()).markers);
    } catch {}

    const audio = new Audio(audioUrl);
    audio.preload = 'auto';
    activeLipSyncAudio = audio;

    for (const bg of bgFiles) {
      const bgAudio = new Audio(`./scenes/${config.id}/audio/${bg}`);
      bgAudio.volume = 0.65;
      bgAudio.play().catch(() => {});
    }

    audio.onended = () => {
      stopLipSync();
      setInput('mouth_shape', 0);
      setInput('is_speaking', false);
      setInput('body_movement', 0);
      setupAfterTrigger(config);
    };

    try {
      await audio.play();
      showMessage('');
      applyLipSyncMarkers(audio, markers);
    } catch (err) {
      showMessage('Tap to play.', false);
      canvas.addEventListener('pointerup', async () => {
        await audio.play();
        showMessage('');
        applyLipSyncMarkers(audio, markers);
      }, { once: true });
    }
  }

  // ─── Segment playback ───────────────────────────────────────────────────────
  const segmentChatEl   = document.getElementById('segmentChat');
  const segChatThread   = document.getElementById('segChatThread');
  const segChatForm     = document.getElementById('segChatForm');
  const segChatInput    = document.getElementById('segChatInput');
  const segChatContinue = document.getElementById('segChatContinue');

  function hideSegmentChat() {
    if (segmentChatEl) segmentChatEl.style.display = 'none';
    if (segChatThread) segChatThread.innerHTML = '';
    if (segChatContinue) segChatContinue.style.display = 'none';
  }

  async function playSegment(config, index) {
    if (segmentCleanup) { segmentCleanup(); segmentCleanup = null; }
    if (activeSegmentBg) { activeSegmentBg.pause(); activeSegmentBg = null; }
    hideSegmentChat();

    if (index >= config.segments.length) {
      setupAfterTrigger(config);
      return;
    }

    const seg = config.segments[index];
    const isLast = index === config.segments.length - 1;

    // Segment background audio
    if (seg.bg) {
      const bgAudio = new Audio(`./scenes/${config.id}/audio/${seg.bg}`);
      bgAudio.loop = true;
      bgAudio.volume = 0.5;
      bgAudio.play().catch(() => {});
      activeSegmentBg = bgAudio;
    }

    // Chat segment
    if (seg.type === 'chat') {
      playChatSegment(config, index);
      return;
    }

    // Voice segment (default)
    const voiceFile = seg.voice;

    if (!voiceFile) {
      if (isLast) { setupAfterTrigger(config); return; }
      waitForSegmentTrigger(config, index);
      return;
    }

    const baseName = voiceFile.replace(/\.[^.]+$/, '');
    const audioUrl = `./scenes/${config.id}/audio/${voiceFile}`;
    const jsonUrl  = `./scenes/${config.id}/audio/${baseName}.lipsync.json`;

    let markers = [];
    try {
      const res = await fetch(`${jsonUrl}?v=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) markers = sanitizeMarkers((await res.json()).markers);
    } catch {}

    const audio = new Audio(audioUrl);
    audio.preload = 'auto';
    activeLipSyncAudio = audio;

    audio.onended = () => {
      stopLipSync();
      setInput('mouth_shape', 0);
      setInput('is_speaking', false);
      setInput('body_movement', 0);
      if (isLast) { setupAfterTrigger(config); return; }
      waitForSegmentTrigger(config, index);
    };

    try {
      await audio.play();
      showMessage('');
      applyLipSyncMarkers(audio, markers);
    } catch (err) {
      showMessage('Tap to play.', false);
      canvas.addEventListener('pointerup', async () => {
        await audio.play();
        showMessage('');
        applyLipSyncMarkers(audio, markers);
      }, { once: true });
    }
  }

  function advanceSegment(config, index) {
    const seg = config.segments[index];
    // Play tap sound effect if configured
    if (seg.sfx) {
      const sfx = new Audio(`./scenes/${config.id}/audio/${seg.sfx}`);
      sfx.play().catch(() => {});
    }
    playSegment(config, index + 1);
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
      const handler = () => advanceSegment(config, index);
      canvas.addEventListener('pointerup', handler, { once: true });
      segmentCleanup = () => canvas.removeEventListener('pointerup', handler);
      return;
    }

    // Poll a Rive input (e.g. nav_heart)
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
    const maxExchanges = seg.max_exchanges || 0; // 0 = unlimited
    let exchangeCount = 0;
    let localMessages = [];

    segmentChatEl.style.display = 'flex';
    segChatThread.innerHTML = '';
    segChatContinue.style.display = 'none';

    // Show Eli's opening line
    if (seg.opening) {
      addSegChatBubble(seg.opening, 'eli');
      localMessages.push({ role: 'assistant', content: seg.opening });
    }

    function finishChat() {
      hideSegmentChat();
      if (isLast) { setupAfterTrigger(config); return; }
      waitForSegmentTrigger(config, index);
    }

    function showContinueButton() {
      segChatContinue.style.display = '';
      segChatInput.closest('form').style.display = 'none';
    }

    // Continue button ends the chat segment
    const continueHandler = () => finishChat();
    segChatContinue.addEventListener('click', continueHandler, { once: true });
    segmentCleanup = () => {
      segChatContinue.removeEventListener('click', continueHandler);
      hideSegmentChat();
    };

    async function sendChatMessage(text) {
      if (!text) return;
      segChatInput.value = '';
      removeSegSuggestions();
      addSegChatBubble(text, 'player');
      localMessages.push({ role: 'user', content: text });
      exchangeCount++;

      addSegTyping();
      try {
        const extra = seg.context_hint ? `\n\nCONTEXT HINT FOR THIS MOMENT: ${seg.context_hint}` : '';
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: localMessages, context_hint: extra }),
        });
        removeSegTyping();
        const data = res.ok ? await res.json() : { reply: '...' };
        const reply = data.reply || '...';
        localMessages.push({ role: 'assistant', content: reply });
        addSegChatBubble(reply, 'eli');
        if (data.vitals) applyVitals(data.vitals);
        if (data.emotion) applyEmotion(data.emotion);
        if (data.body) applyBody(data.body);

        // Check if max exchanges reached
        if (maxExchanges > 0 && exchangeCount >= maxExchanges) {
          showContinueButton();
          return;
        }

        if (data.suggested_responses?.length) {
          showSegSuggestions(data.suggested_responses, sendChatMessage);
        }
      } catch { removeSegTyping(); addSegChatBubble('...', 'eli'); }
    }

    // Bind form submit
    const formHandler = (e) => {
      e.preventDefault();
      sendChatMessage(segChatInput.value.trim());
    };
    segChatForm.addEventListener('submit', formHandler);
    const oldCleanup = segmentCleanup;
    segmentCleanup = () => {
      segChatForm.removeEventListener('submit', formHandler);
      if (oldCleanup) oldCleanup();
    };

    // If no opening line, show suggestions to start
    if (!seg.opening && seg.suggested_starters?.length) {
      showSegSuggestions(seg.suggested_starters, sendChatMessage);
    }
  }

  function addSegChatBubble(text, who) {
    const div = document.createElement('div');
    div.className = `chat-bubble chat-bubble--${who}`;
    div.textContent = text;
    segChatThread.appendChild(div);
    segChatThread.scrollTop = segChatThread.scrollHeight;
  }

  function addSegTyping() {
    const div = document.createElement('div');
    div.className = 'chat-bubble chat-bubble--eli chat-typing';
    div.textContent = '...';
    div.id = 'segTyping';
    segChatThread.appendChild(div);
    segChatThread.scrollTop = segChatThread.scrollHeight;
  }

  function removeSegTyping() {
    const el = document.getElementById('segTyping');
    if (el) el.remove();
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

  function setupAfterTrigger(config) {
    const after = config.after || {};
    if (after.trigger === 'auto' || after.trigger === 'ended' || after.trigger === 'never' || !after.trigger) {
      if (after.next) {
        loadScene(after.next);
      } else if (after.message) {
        showMessage(after.message, false);
      }
      return;
    }
    // tap_heart or any interaction — show message and wait
    showMessage(after.message || 'Tap to continue.', false);
    canvas.addEventListener('pointerup', () => {
      if (after.next) loadScene(after.next);
    }, { once: true });
  }

  function handleRiveEvent(name, config) {
    const ctaDest = getCtaDestination(name, config);
    if (ctaDest) {
      loadScene(ctaDest);
      return;
    }
    if (name === 'tap_heart' || name === 'hit_heart') {
      handleInteraction('tap_heart', config);
      return;
    }
    if (name.startsWith('goto_')) {
      loadScene(name.slice(5));
      return;
    }
    // If the event name matches the after.trigger, advance
    const after = config.after || {};
    if (after.trigger && name === after.trigger) {
      const dest = after.next || nextInSequence(config.id);
      if (dest) { loadScene(dest); return; }
    }
    // If the event name matches a scene id in the sequence, go there
    if (sequence && sequence.scenes && sequence.scenes.includes(name)) {
      loadScene(name);
    }
  }

  function nextInSequence(id) {
    const scenes = sequence?.scenes || [];
    const idx = scenes.indexOf(id);
    return idx >= 0 && idx + 1 < scenes.length ? scenes[idx + 1] : null;
  }

  function handleInteraction(type, config) {
    const ctaDest = getCtaDestination(type, config);
    if (ctaDest) {
      loadScene(ctaDest);
      return;
    }
    const after = config.after || {};
    if (after.trigger === type && after.next) {
      loadScene(after.next);
    }
  }

  function getCtaRoutes(config) {
    const result = [];
    // New format: config.routes = { "nav_eli": "eli", ... }
    const routes = config.routes && typeof config.routes === 'object' ? config.routes : {};
    for (const [name, next] of Object.entries(routes)) {
      if (name && next) result.push({ name: String(name).trim(), next: String(next).trim() });
    }
    // Legacy format: config.ctaRoutes = [{ name: "nav_eli", next: "eli" }, ...]
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
    // 1. Explicit routes wired in the editor
    const match = getCtaRoutes(config).find(r => normalizeRouteKey(r.name) === key);
    if (match) return match.next;
    // 2. Convention: nav_<scene_id> → that scene (zero-config if names match)
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
  function applyLipSyncMarkers(audio, markers) {
    if (activeLipSyncFrame) { cancelAnimationFrame(activeLipSyncFrame); activeLipSyncFrame = null; }
    if (!markers.length) return;

    let applied = new Set();
    function tick() {
      if (!audio || audio.paused || audio.ended) return;
      const t = audio.currentTime;
      for (let i = 0; i < markers.length; i++) {
        if (applied.has(i)) continue;
        const m = markers[i];
        if (t >= m.time) {
          if (Number.isFinite(m.mouth_shape))   { setInput('mouth_shape', m.mouth_shape); setInput('is_speaking', m.mouth_shape > 0); }
          if (Number.isFinite(m.emotion_state))   setInput('emotion_state', m.emotion_state);
          if (Number.isFinite(m.body_movement))   { setInput('body_movement', m.body_movement); setInput('nav_heart', m.body_movement); }
          applied.add(i);
        }
      }
      activeLipSyncFrame = requestAnimationFrame(tick);
    }
    activeLipSyncFrame = requestAnimationFrame(tick);
  }

  function stopLipSync() {
    if (activeLipSyncFrame) { cancelAnimationFrame(activeLipSyncFrame); activeLipSyncFrame = null; }
  }

  function sanitizeMarkers(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(m => m && Number.isFinite(m.time) && m.time >= 0 &&
      (Number.isFinite(m.mouth_shape) || Number.isFinite(m.emotion_state) || Number.isFinite(m.body_movement))
    ).sort((a, b) => a.time - b.time);
  }

  // ─── Video scene ─────────────────────────────────────────────────────────────
  async function playVideoScene(config) {
    videoScreen.style.display = 'flex';
    const files = config.files || {};
    const videoFile = Object.keys(files).find(f => files[f] === 'video') || null;
    if (!videoFile) { showMessage('No video file set for this scene.', true); return; }

    sceneVideo.src = `./scenes/${config.id}/audio/${videoFile}`;
    sceneVideo.load();

    sceneVideo.onended = () => {
      const after = config.after || {};
      if (after.next) loadScene(after.next);
    };

    fadeIn();
    try { await sceneVideo.play(); } catch { showMessage('Tap to play video.'); }
  }

  // ─── Chat scene ──────────────────────────────────────────────────────────────
  async function playChatScene(config) {
    chatScreen.style.display = 'flex';

    // Load Rive in the chat canvas (reuses cached buffer)
    const chatRivePath = config.rive === 'shared'
      ? './public/rive/eli.riv'
      : config.rive ? `./scenes/${config.id}/${config.rive}` : null;

    if (chatRivePath && riveInstance) { try { riveInstance.cleanup(); } catch {} riveInstance = null; }

    if (chatRivePath) {
      let chatBuffer = riveBufferCache.get(chatRivePath);
      if (!chatBuffer) {
        try {
          const res = await fetch(`${chatRivePath}?v=${Date.now()}`, { cache: 'no-store' });
          if (res.ok) { chatBuffer = await res.arrayBuffer(); riveBufferCache.set(chatRivePath, chatBuffer); }
        } catch {}
      }
      if (chatBuffer) {
        const chatSmNames = Array.isArray(config.stateMachines) && config.stateMachines.length
          ? config.stateMachines
          : ['EliState', 'EliBody', 'FacialState', 'EmotionState'];
        riveInstance = new rive.Rive({
          buffer: chatBuffer,
          canvas: chatCanvas,
          autoplay: true,
          stateMachines: chatSmNames,
          onLoad: () => { inputByName = collectInputs(chatSmNames); resizeChatCanvas(); },
        });
      }
    }

    fadeIn();
    chatThread.innerHTML = '';
    chatMessages = [];

    async function sendMessage(text) {
      if (!text) return;
      chatInput.value = '';
      removeSuggestions();
      addChatBubble(text, 'player');
      chatMessages.push({ role: 'user', content: text });

      addTypingIndicator();
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: chatMessages }),
        });
        removeTypingIndicator();
        const data = res.ok ? await res.json() : { reply: '...' };
        const reply = data.reply || '...';
        chatMessages.push({ role: 'assistant', content: reply });
        addChatBubble(reply, 'eli');
        if (data.vitals) applyVitals(data.vitals);
        if (data.emotion) applyEmotion(data.emotion);
        if (data.body) applyBody(data.body);
        if (data.suggested_responses?.length) showSuggestions(data.suggested_responses, sendMessage);
      } catch { removeTypingIndicator(); addChatBubble('...', 'eli'); }
    }

    chatForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      sendMessage(chatInput.value.trim());
    });
  }

  function addChatBubble(text, who) {
    const div = document.createElement('div');
    div.className = `chat-bubble chat-bubble--${who}`;
    div.textContent = text;
    chatThread.appendChild(div);
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function addTypingIndicator() {
    const div = document.createElement('div');
    div.className = 'chat-bubble chat-bubble--eli chat-typing';
    div.textContent = '...';
    div.id = 'typingIndicator';
    chatThread.appendChild(div);
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function removeTypingIndicator() {
    const el = document.getElementById('typingIndicator');
    if (el) el.remove();
  }

  function showSuggestions(options, onSelect) {
    removeSuggestions();
    const wrap = document.createElement('div');
    wrap.className = 'chat-suggestions';
    wrap.id = 'chatSuggestions';
    for (const text of options) {
      const btn = document.createElement('button');
      btn.className = 'chat-suggestion';
      btn.textContent = text;
      btn.addEventListener('click', () => onSelect(text));
      wrap.appendChild(btn);
    }
    chatThread.appendChild(wrap);
    chatThread.scrollTop = chatThread.scrollHeight;
  }

  function removeSuggestions() {
    const el = document.getElementById('chatSuggestions');
    if (el) el.remove();
  }

  const EMOTION_MAP = { neutral: 0, sad: 1, happy: 2, angry: 3, surprised: 5, confused: 6 };
  const BODY_MAP    = { idle: 0, heart_glow: 1, heart_pain: 2 };

  function applyVitals(vitals) {
    if (Number.isFinite(vitals.bpm))  setInput('heart_pulse', vitals.bpm);
    if (Number.isFinite(vitals.mood)) setInput('emotion_state', vitals.mood);
  }

  function applyEmotion(emotion) {
    const val = EMOTION_MAP[emotion];
    if (val !== undefined) setInput('emotion_state', val);
  }

  function applyBody(body) {
    const val = BODY_MAP[body];
    if (val !== undefined) { setInput('body_movement', val); setInput('nav_heart', val); }
  }

  // ─── UI helpers ───────────────────────────────────────────────────────────────
  function hideAll() {
    stage.style.display       = 'none';
    videoScreen.style.display = 'none';
    chatScreen.style.display  = 'none';
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
    canvas.width  = window.innerWidth  * devicePixelRatio;
    canvas.height = window.innerHeight * devicePixelRatio;
    riveInstance.resizeToCanvas();
  }

  function resizeChatCanvas() {
    if (!riveInstance) return;
    chatCanvas.width  = chatCanvas.offsetWidth  * devicePixelRatio;
    chatCanvas.height = chatCanvas.offsetHeight * devicePixelRatio;
    riveInstance.resizeToCanvas();
  }

  window.addEventListener('resize', () => { resizeCanvas(); resizeChatCanvas(); });
}());
