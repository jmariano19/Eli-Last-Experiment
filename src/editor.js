(function () {
  'use strict';

  // ─── Rive preview ───────────────────────────────────────────────────────────
  let rivePreview  = null;
  let riveInputMap = new Map();
  let previewNavPollFrame = null;

  function getRiveSrc(config) {
    if (!config || !config.rive) return null;
    return config.rive === 'shared' ? '/public/rive/eli.riv' : `/games/${st.game}/scenes/${config.id}/${config.rive}`;
  }

  // In-memory .riv cache. Panel re-renders re-create the preview constantly;
  // without this every re-render re-downloaded and re-parsed the file.
  // Cleared whenever a .riv is uploaded so replacements show immediately.
  const rivBufferCache = new Map();   // path → Promise<ArrayBuffer>
  let previewInitToken = 0;

  function getRivBuffer(path) {
    if (!rivBufferCache.has(path)) {
      rivBufferCache.set(path, fetch(`${path}?v=${Date.now()}`).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      }).catch(err => { rivBufferCache.delete(path); throw err; }));
    }
    return rivBufferCache.get(path);
  }

  function initRivePreview(config, bare = false) {
    const canvas = document.getElementById('previewCanvas');
    if (!canvas) return;
    const src = getRiveSrc(config);
    if (!src) return;
    const hint = document.getElementById('previewHint');
    if (hint) hint.textContent = 'Loading…';

    if (artboardDetectTimer) { clearTimeout(artboardDetectTimer); artboardDetectTimer = null; }
    if (rivePreview) { try { rivePreview.cleanup(); } catch {} rivePreview = null; }
    if (previewNavPollFrame) { cancelAnimationFrame(previewNavPollFrame); previewNavPollFrame = null; }
    riveInputMap = new Map();

    // For the shared eli.riv, use the known Eli SM names so triggers work.
    // For scene-specific files (custom .riv uploads), don't force SM names —
    // the file may have different state machines, and specifying wrong names
    // can prevent the file from loading in some runtime versions.
    const isShared = config && config.rive === 'shared';
    const smNames  = Array.isArray(config && config.stateMachines) && config.stateMachines.length
      ? config.stateMachines
      : isShared ? ['EliState', 'EliBody', 'FacialState', 'EmotionState', 'AyesMovements'] : [];

    if (typeof rive === 'undefined' || !rive.Rive) {
      if (hint) hint.textContent = 'Error: Rive script did not load. Check your network connection.';
      return;
    }

    // Long-press context menu would interrupt hold interactions in the preview
    canvas.oncontextmenu = (ev) => ev.preventDefault();

    // Set canvas dimensions before init so Rive has a real surface
    canvas.width  = (canvas.offsetWidth  || 300) * devicePixelRatio;
    canvas.height = (canvas.offsetHeight || 300) * devicePixelRatio;

    const artboard = (config && config.artboard) || undefined;
    const initToken = ++previewInitToken;
    getRivBuffer(src).then((buffer) => {
      if (initToken !== previewInitToken) return;   // superseded by a newer init
      try {
      rivePreview = new rive.Rive({
        buffer,
        canvas,
        // bare mode: drop artboard + state machine names entirely — used as a
        // fallback when the configured names no longer exist in the file
        ...(!bare && artboard ? { artboard } : {}),
        autoplay: true,
        fit: rive.Fit.Contain,
        alignment: rive.Alignment.Center,
        ...(!bare && smNames.length ? { stateMachines: smNames } : {}),
        onLoad: () => {
          const activeSMs = bare ? (rivePreview.stateMachineNames || []) : smNames;
          for (const sm of activeSMs) {
            try {
              for (const input of (rivePreview.stateMachineInputs(sm) || [])) {
                riveInputMap.set(input.name, input);
                // Tolerate stray trailing colons/whitespace typed in Rive
                // Studio (e.g. "is_speaking:") — alias the cleaned name too.
                const cleaned = input.name.trim().replace(/[:\s]+$/, '');
                if (cleaned && cleaned !== input.name && !riveInputMap.has(cleaned)) riveInputMap.set(cleaned, input);
              }
            } catch {}
          }
          applyPoseToPreview(config);
          canvas.width  = (canvas.offsetWidth  || 300) * devicePixelRatio;
          canvas.height = (canvas.offsetHeight || 300) * devicePixelRatio;
          rivePreview.resizeToCanvas();
          if (hint) hint.textContent = bare
            ? '⚠ Loaded without your Artboard / State machines — those names aren\'t in this file anymore. Pick the new names below, then Save.'
            : '';
          populateTriggerSelect(config);
          populateConnectionsSection(config);
          populateRiveFileInfo(config);
          setupPreviewCtaRouting(config, canvas);
        },
        onLoadError: (err) => {
          // Stale artboard/state-machine names abort the whole load — retry
          // bare so the art still shows and the detected names populate.
          if (!bare) { initRivePreview(config, true); return; }
          const h = document.getElementById('previewHint');
          if (h) h.textContent = `Rive error: ${err?.message || err?.type || JSON.stringify(err) || 'check browser console'}`;
        },
      });
      } catch (err) {
        if (hint) hint.textContent = `Rive init failed: ${err?.message || err}`;
      }
    }).catch((err) => {
      if (hint) hint.textContent = `Could not load the .riv file (${err.message}) — re-upload it.`;
    });
  }

  // Read the .riv file's real contents via the Rive runtime — artboards and
  // state machines exactly as named in Rive Studio. contents can populate a
  // moment after onLoad, so retry briefly before giving up.
  let artboardDetectTimer = null;

  function populateRiveFileInfo(config, attempt = 0) {
    let artboards = [];
    try {
      const contents = rivePreview && rivePreview.contents;
      if (contents && Array.isArray(contents.artboards)) artboards = contents.artboards;
    } catch {}

    if (!artboards.length) {
      if (attempt < 6) {
        clearTimeout(artboardDetectTimer);
        artboardDetectTimer = setTimeout(() => populateRiveFileInfo(config, attempt + 1), 350);
      }
      return;
    }

    const names = artboards.map(a => a.name).filter(Boolean);

    // Autocomplete suggestions while typing
    const dl = document.getElementById('artboardOptions');
    if (dl) dl.innerHTML = names.map(n => `<option value="${esc(n)}"></option>`).join('');

    // Clickable chips with the detected names — one click applies it
    const chipRow = document.getElementById('artboardDetectedRow');
    const chips   = document.getElementById('artboardDetected');
    if (chipRow && chips) {
      const current = config.artboard || '';
      const unknown = current && !names.includes(current);
      chips.innerHTML = 'In this file: '
        + names.map(n => `<button type="button" class="chip${n === current ? ' chip--active' : ''}" data-ab="${esc(n)}">${esc(n)}</button>`).join('')
        + (unknown ? ` <span class="chip-warn">⚠ "${esc(current)}" not found in this file</span>` : '');
      chipRow.style.display = '';
      chips.querySelectorAll('[data-ab]').forEach(b => {
        b.addEventListener('click', () => {
          const input = document.getElementById('fieldArtboard');
          if (input) input.value = b.dataset.ab;
          config.artboard = b.dataset.ab;
          st.dirty = true;
          initRivePreview(config);
        });
      });
    }

    // State machines that actually exist on the active artboard
    const ab  = artboards.find(a => a.name === config.artboard) || artboards[0];
    const sms = (ab && Array.isArray(ab.stateMachines) ? ab.stateMachines : [])
      .map(sm => (typeof sm === 'string' ? sm : sm && sm.name)).filter(Boolean);

    const hintRow = document.getElementById('smAvailableRow');
    const hintEl  = document.getElementById('smAvailable');
    if (hintRow && hintEl) {
      hintEl.textContent = sms.length ? `In "${ab.name}": ${sms.join(', ')}` : '';
      hintRow.style.display = sms.length ? '' : 'none';
    }

    // Nothing configured yet → adopt the file's real state machines so the
    // player drives what's actually there, then reload the preview with them
    if (sms.length && !(config.stateMachines || []).length) {
      config.stateMachines = sms;
      const smInput = document.getElementById('fieldStateMachines');
      if (smInput) smInput.value = sms.join(', ');
      st.dirty = true;
      initRivePreview(config);
    }

    runRiveContractCheck(config, sms);
  }

  // Diff what the scene config + player expect against what the loaded .riv
  // actually contains (see RIVE-CONTRACT.md). Renames in Rive Studio otherwise
  // break scenes silently — this surfaces them as soon as the scene is opened.
  function runRiveContractCheck(config, fileSMs) {
    const row = document.getElementById('riveCheckRow');
    const out = document.getElementById('riveCheck');
    if (!row || !out) return;

    const problems = [];
    const notes    = [];

    const missingSMs = (config.stateMachines || []).filter(sm => !fileSMs.includes(sm));
    if (missingSMs.length) {
      problems.push(`state machine${missingSMs.length > 1 ? 's' : ''} not in this file: ${missingSMs.join(', ')}`);
    }

    // Scenes with voice audio drive the lip-sync inputs every frame
    const hasVoice = (Array.isArray(config.segments) && config.segments.some(s => s && s.voice))
      || Object.values(config.files || {}).includes('voice');
    if (hasVoice) {
      const missingInputs = ['mouth_shape', 'is_speaking'].filter(n => !riveInputMap.has(n));
      if (missingInputs.length) {
        problems.push(`voice scene but input${missingInputs.length > 1 ? 's' : ''} missing: ${missingInputs.join(', ')}`);
      }
    }

    // nav_<sceneId> bool/trigger inputs navigate automatically unless remapped
    // in SCENE CONNECTIONS — flag ones pointing at scenes that don't exist
    const sceneIds   = st.sequence.scenes || [];
    const routeNames = getCtaRoutes(config).map(r => r.name);
    const deadNavs   = [...riveInputMap.entries()]
      .filter(([name, inp]) => name.startsWith('nav_')
        && typeof inp.value !== 'number'
        && !routeNames.includes(name)
        && !sceneIds.includes(name.slice(4)))
      .map(([name]) => name);
    if (deadNavs.length) {
      problems.push(`${deadNavs.join(', ')} → no scene with that id (add it in SCENE CONNECTIONS or rename the input)`);
    }

    const staticTriggers = ['never', 'auto', 'ended', 'tap_heart', ''];
    const trig = config.after && config.after.trigger;
    if (trig && !staticTriggers.includes(trig) && !riveInputMap.has(trig)) {
      notes.push(`fallback trigger "${trig}" isn't an input — it must be a Rive event with exactly that name`);
    }

    row.style.display = '';
    if (problems.length) {
      out.innerHTML = problems.map(p => `<span class="rive-check-warn">⚠ ${esc(p)}</span>`).join('<br>')
        + (notes.length ? '<br>' + notes.map(n => `<span>ℹ ${esc(n)}</span>`).join('<br>') : '');
    } else {
      out.innerHTML = '<span class="rive-check-ok">✓ File matches this scene\'s config</span>'
        + (notes.length ? '<br>' + notes.map(n => `<span>ℹ ${esc(n)}</span>`).join('<br>') : '');
    }

    // Surface the result on the collapsed RIVE SETUP summary + status pill,
    // and auto-expand when something needs attention.
    st.riveIssueCount = problems.length;
    const badge = document.getElementById('riveSetupBadge');
    if (badge) {
      badge.className = `rive-setup__badge ${problems.length ? 'is-warn' : 'is-ok'}`;
      badge.textContent = problems.length ? `⚠ ${problems.length} issue${problems.length > 1 ? 's' : ''}` : '✓';
    }
    const details = document.getElementById('riveSetupDetails');
    if (details && problems.length && !details.open) { details.open = true; st.riveSetupOpen = true; }
    updateScenePill();
  }

  function setupPreviewCtaRouting(config, canvas) {
    const routes = getCtaRoutes(config);
    if (!routes.length) return;

    if (rivePreview.on && rive.EventType?.RiveEvent) {
      rivePreview.on(rive.EventType.RiveEvent, (event) => {
        const name = event?.data?.name;
        const dest = getCtaDestination(name, config);
        if (dest) navigatePreviewToScene(dest);
      });
    }

    const pollPreviewNav = () => {
      for (const route of routes) {
        const input = getPreviewInputByRouteName(route.name);
        if (isPreviewNavigationInputActive(input)) {
          previewNavPollFrame = null;
          navigatePreviewToScene(route.next);
          return;
        }
      }
      previewNavPollFrame = requestAnimationFrame(pollPreviewNav);
    };
    previewNavPollFrame = requestAnimationFrame(pollPreviewNav);

  }

  function navigatePreviewToScene(sceneId) {
    if (!sceneId || !st.sequence.scenes.includes(sceneId)) return;
    showToast(`Opening ${st.configs[sceneId]?.title || sceneId}…`);
    selectScene(sceneId);
  }

  function setPreviewInput(name, value) {
    const input = riveInputMap.get(name);
    if (!input) return;
    if (typeof value === 'boolean') input.value = value;
    else if (input.type === 3) input.fire();
    else input.value = Number(value);
  }

  function applyPoseToPreview(config) {
    const segment = Array.isArray(config?.segments) ? config.segments[st.activeSegmentIndex] : null;
    const pose = { ...(config?.pose || {}), ...(segment?.pose || {}) };
    if (Number.isFinite(pose.mouth_shape))   { setPreviewInput('mouth_shape', pose.mouth_shape); setPreviewInput('is_speaking', pose.mouth_shape > 0); }
    if (Number.isFinite(pose.emotion_state)) { setPreviewInput('emotion_state', pose.emotion_state); setPreviewInput('eyes_state', pose.emotion_state); }
    if (Number.isFinite(pose.body_movement)) { setPreviewInput('body_movement', pose.body_movement); setPreviewInput('nav_heart', pose.body_movement); }
    if (Number.isFinite(pose.head_movement)) { setPreviewInput('head_movement', pose.head_movement); setPreviewInput('head_state', pose.head_movement); }
    if (Number.isFinite(pose.heart_state))   setPreviewInput('heart_state', pose.heart_state);
  }

  function bindExpressionPreviewButtons(root = document, onPoseChange = null) {
    root.querySelectorAll('.mouth-btn').forEach(btn => {
      btn.onclick = () => {
        const value = Number(btn.dataset.mouth);
        setPreviewInput('mouth_shape', value);
        setPreviewInput('is_speaking', value > 0);
        if (onPoseChange) onPoseChange('mouth_shape', value);
      };
    });
    root.querySelectorAll('.emotion-btn').forEach(btn => {
      btn.onclick = () => {
        const value = Number(btn.dataset.emotion);
        setPreviewInput('emotion_state', value);
        setPreviewInput('eyes_state', value);
        if (onPoseChange) onPoseChange('emotion_state', value);
      };
    });
    root.querySelectorAll('.body-btn').forEach(btn => {
      btn.onclick = () => {
        const value = Number(btn.dataset.body);
        setPreviewInput('body_movement', value);
        setPreviewInput('nav_heart', value);
        if (onPoseChange) onPoseChange('body_movement', value);
      };
    });
    root.querySelectorAll('.head-btn').forEach(btn => {
      btn.onclick = () => {
        const value = Number(btn.dataset.head);
        setPreviewInput('head_movement', value);
        setPreviewInput('head_state', value);
        if (onPoseChange) onPoseChange('head_movement', value);
      };
    });
    root.querySelectorAll('.heart-btn').forEach(btn => {
      btn.onclick = () => {
        const value = Number(btn.dataset.heart);
        setPreviewInput('heart_state', value);
        if (onPoseChange) onPoseChange('heart_state', value);
      };
    });
  }

  function getPreviewInputByRouteName(name) {
    const exact = riveInputMap.get(name);
    if (exact) return exact;
    const key = normalizeRouteKey(name);
    for (const [inputName, input] of riveInputMap) {
      if (normalizeRouteKey(inputName) === key) return input;
    }
    return null;
  }

  function isPreviewNavigationInputActive(input) {
    if (!input) return false;
    if (input.value === true) return true;
    return typeof input.value === 'number' && input.value > 0;
  }

  function getCtaRoutes(config) {
    const result = [];
    const routes = config && config.routes && typeof config.routes === 'object' ? config.routes : {};
    for (const [name, next] of Object.entries(routes)) {
      if (name && next) result.push({ name: String(name).trim(), next: String(next).trim() });
    }
    for (const r of sanitizeCtaRoutes(config && config.ctaRoutes)) {
      if (!result.find(x => normalizeRouteKey(x.name) === normalizeRouteKey(r.name))) {
        result.push(r);
      }
    }
    return result;
  }

  function getCtaDestination(name, config) {
    const key = normalizeRouteKey(name);
    if (!key) return null;
    const route = getCtaRoutes(config).find(r => normalizeRouteKey(r.name) === key);
    return route ? route.next : null;
  }

  function normalizeRouteKey(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  // ─── State ──────────────────────────────────────────────────────────────────
  const st = {
    game:          'main',   // active game id
    games:         [],       // [{ id, title }] from /api/games
    defaultGame:   'main',   // the game the deployed player serves
    sequence:      { version: '1', title: "Eli's Last Experiment", start: null, scenes: [] },
    configs:       {},       // { sceneId: scene.json }
    files:         {},       // { sceneId: [filenames] }
    activeId:      null,
    lanBase:       null,     // first LAN URL from server (for mobile testing)

    // Lip sync
    audio:               new Audio(),
    markers:             [],
    markersVersion:      0,
    activeVoiceFile:     '',
    isPlaying:           false,
    tapMode:             false,
    selectedMarkerIdx:   -1,
    pauseAfterMark:      false,
    activeSegmentIndex:  0,
    dirty:               false,

    // Text cues
    textCues:            [],
    selectedTextCueIdx:  -1,

    // Waveform + undo
    waveformPeaks:       null,   // peak amplitudes for drawing
    waveformEnv:         null,   // 10ms RMS envelope for auto lip-sync
    _undo:               [],     // marker/text-cue history (Cmd+Z)

    audioFilesOpen:      false,  // AUDIO FILES accordion state
    sectionOpen:         {},     // FALLBACK / CTA / HEART TOUCH accordion states
  };

  const MOUTH_LABELS = ['Idle','A E I','B M P','C D G K','CH SH J','EE','F V','L','O','Q W','R','TH','U','Smile','Sad','Angry','Laugh','Surprised','Confused'];
  // Eyes movements track — Rive state machine AyesMovements. Values 0–9 match
  // the original emotion set (existing markers + AI chat stay valid); 10–13
  // are the gaze directions. Markers keep the emotion_state key, and both
  // emotion_state and eyes_state inputs are driven, so either name works.
  const EMOTION_LABELS = ['Idle','Sad','Smile','Angry','Surprised','Confused','Remembering','Scared','Tired','Eyes Closed','Look Up','Look Down','Look Left','Look Right'];
  // Haptic presets — vibration patterns in ms [vibrate, pause, vibrate…]
  const HAPTIC_PRESETS = {
    tap:       { label: 'Tap',       pattern: [20],              hint: 'Tiny tick (20ms)' },
    soft:      { label: 'Soft',      pattern: [50],              hint: 'Soft pulse (50ms)' },
    strong:    { label: 'Strong',    pattern: [140],             hint: 'Strong pulse (140ms)' },
    double:    { label: 'Double',    pattern: [45, 70, 45],      hint: 'Two quick pulses' },
    heartbeat: { label: 'Heartbeat', pattern: [35, 80, 55, 320], hint: 'Lub-dub, like a heart' },
    buzz:      { label: 'Buzz',      pattern: [400],             hint: 'Long rumble (400ms)' },
  };

  // heart_state Rive input (own "heart" state machine), states 0–8
  const HEART_LABELS = ['Idle','Glow','Fast','Pain','Slow','Warm','Flicker','Race','Stop'];

  // head_movement Rive input, states 0–8. 1–4 were Look Up/Down/Left/Right —
  // those moved to the Eyes track; the gaps keep Nod=5…Turn Away=8 stable so
  // existing markers don't change meaning.
  const HEAD_LABELS = ['Idle','','','','','Nod (Yes)','Shake (No)','Tilt','Turn Away'];
  const BODY_LABELS = ['Idle','','','Breathe','Shiver','Reach','Curl','Float','Shake','Lean In','Lean Back','Twitch','Pulse','Sway','Collapse','Rise','Tremble','Move Left Arm'];  // 1–2 were Heart Glow/Pain — now on the heart_state track
  // ─── DOM ────────────────────────────────────────────────────────────────────
  const sceneList       = document.getElementById('sceneList');
  const editorEmpty     = document.getElementById('editorEmpty');
  const editorPanel     = document.getElementById('editorPanel');
  const addSceneModal   = document.getElementById('addSceneModal');
  const newSceneName    = document.getElementById('newSceneName');
  const btnAddScene     = document.getElementById('btnAddScene');
  const btnAddSceneCreate = document.getElementById('btnAddSceneCreate');
  const btnAddSceneCancel = document.getElementById('btnAddSceneCancel');
  const btnSave         = document.getElementById('btnSave');
  const btnTestScene    = document.getElementById('btnTestScene');
  const btnTestAll      = document.getElementById('btnTestAll');
  const btnPublish      = document.getElementById('btnPublish');
  const btnPublishFooter= document.getElementById('btnPublishFooter');
  const btnOpenAIStatus = document.getElementById('btnOpenAIStatus');
  const toast           = document.getElementById('toast');
  const gameSwitcher    = document.getElementById('gameSwitcher');
  const btnNewGame      = document.getElementById('btnNewGame');
  const btnDeleteGame   = document.getElementById('btnDeleteGame');
  const deleteGameModal = document.getElementById('deleteGameModal');

  let selectedModalType = 'rive';

  // Append the active game to an API query string
  function gq() { return `game=${encodeURIComponent(st.game)}`; }

  // The server must speak the same API version — otherwise a stale server
  // process is running and everything would fail in confusing ways.
  const REQUIRED_SERVER_VERSION = 5;

  async function ensureServerVersion() {
    let version = null;
    try {
      const res = await fetch('/api/version');
      if (res.ok) version = (await res.json()).version;
    } catch {}
    if (version === REQUIRED_SERVER_VERSION) return true;
    editorEmpty.hidden = false;
    editorPanel.hidden = true;
    const why = version === null
      ? 'An old server process is still running — it doesn\'t match this editor.'
      : `The server (v${version}) doesn't match this editor (v${REQUIRED_SERVER_VERSION}).`;
    editorEmpty.innerHTML = `
      <div class="server-mismatch">
        <h2>Restart the server</h2>
        <p>${why}</p>
        <p>In the project folder, run <code>npm start</code> — it now stops stale
           servers automatically and reopens the editor for you.</p>
        <button class="btn btn--save" id="btnRetryVersion">Retry</button>
      </div>`;
    document.getElementById('btnRetryVersion')?.addEventListener('click', () => location.reload());
    return false;
  }

  // ─── Boot ───────────────────────────────────────────────────────────────────
  window.addEventListener('load', async () => {
    wireButtons();
    if (!(await ensureServerVersion())) return;
    // Fetch LAN IP for mobile test links (non-blocking)
    fetch('/api/server-info').then(r => r.json()).then(info => {
      st.lanBase = (info.lanUrls || [])[0] || null;
      updateMobileButtons();
    }).catch(() => {});
    await loadGames();
    await loadSequence();
    checkAIStatus();
    startRivWatch();
  });

  // ─── Live .riv reload ─────────────────────────────────────────────────────────
  // The server watches the Rive folders; when Rive exports a new .riv this
  // reloads the preview automatically — no upload, no manual refresh.
  function startRivWatch() {
    if (!window.EventSource) return;
    const es = new EventSource('/api/watch/riv');   // auto-reconnects on its own
    es.onmessage = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      if (!data.path) return;
      rivBufferCache.clear();
      const config = st.configs[st.activeId];
      if (!config) return;
      const src = getRiveSrc(config);
      if (!src || src !== `/${data.path}`) return;   // change is for a different scene's file
      const name = data.path.split('/').pop();
      if (previewTestMode) {
        try { document.getElementById('previewTestFrame')?.contentWindow.location.reload(); } catch {}
      } else {
        initRivePreview(config);
      }
      showToast(`${name} updated — preview reloaded.`);
    };
  }

  // ─── Games (multi-game support) ───────────────────────────────────────────────
  async function loadGames() {
    try {
      const res  = await fetch('/api/games');
      const data = await res.json();
      st.games       = data.games || [];
      st.defaultGame = data.default || 'main';
    } catch {
      st.games = [];
      // /api/games only exists on the current server build — reaching this
      // means an outdated server process is still holding the port.
      const emptyEl = document.querySelector('#editorEmpty p');
      if (emptyEl) emptyEl.textContent = 'The server is running old code. Stop it (Ctrl+C in its terminal, or: lsof -ti :4179 | xargs kill), run "npm start" again, then reload this page.';
      showToast('Old server detected — restart it, then reload this page.', true);
    }
    if (!st.games.length) st.games = [{ id: 'main', title: 'Main' }];
    const saved = localStorage.getItem('elia.activeGame');
    st.game = st.games.some(g => g.id === saved) ? saved
            : st.games.some(g => g.id === st.defaultGame) ? st.defaultGame
            : st.games[0].id;
    renderGameSwitcher();
  }

  function renderGameSwitcher() {
    if (!gameSwitcher) return;
    gameSwitcher.innerHTML = st.games.map(g => {
      const star = g.id === st.defaultGame ? ' ★' : '';
      return `<option value="${esc(g.id)}" ${g.id === st.game ? 'selected' : ''}>${esc(g.title || g.id)}${star}</option>`;
    }).join('');
  }

  async function switchGame(id) {
    if (id === st.game) return;
    if (st.dirty) await saveAll();          // never lose work when switching
    st.game = id;
    localStorage.setItem('elia.activeGame', id);
    st.configs = {};
    st.files = {};
    st.activeId = null;
    st.activeVoiceFile = '';
    st.markers = [];
    st.textCues = [];
    st.activeSegmentIndex = 0;
    stopAudio();
    showEmpty();
    await loadSequence();
    const g = st.games.find(x => x.id === id);
    showToast(`Switched to "${g?.title || id}".`);
  }

  async function createGame() {
    const title = prompt('Name for the new game:');
    if (!title || !title.trim()) return;
    try {
      const res  = await fetch('/api/games/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim() }),
      });
      const data = await res.json();
      if (!data.ok) { showToast(`Could not create game: ${data.error || 'unknown error'}`, true); return; }
      await loadGames();
      renderGameSwitcher();
      await switchGame(data.id);
      showToast(`Game "${title.trim()}" created — add your first scene.`);
    } catch (err) {
      showToast(`Could not create game: ${err.message}`, true);
    }
  }

  function openDeleteGameModal() {
    if (st.games.length <= 1) {
      showToast("You can't delete your only game — create another one first.", true);
      return;
    }
    const g = st.games.find(x => x.id === st.game);
    const nameEl = document.getElementById('deleteGameName');
    if (nameEl) nameEl.textContent = `"${g?.title || st.game}"`;
    deleteGameModal.classList.add('is-open');
  }

  function closeDeleteGameModal() {
    if (deleteGameModal) deleteGameModal.classList.remove('is-open');
  }

  async function confirmDeleteGame() {
    closeDeleteGameModal();
    const deletedId = st.game;
    const deletedTitle = st.games.find(x => x.id === deletedId)?.title || deletedId;
    try {
      const res  = await fetch('/api/games/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: deletedId }),
      });
      const data = await res.json();
      if (!data.ok) { showToast(`Delete failed: ${data.error || 'unknown error'}`, true); return; }

      // Reset editor state and land on the remaining default game
      st.dirty = false;
      st.configs = {};
      st.files = {};
      st.activeId = null;
      st.activeVoiceFile = '';
      stopAudio();
      localStorage.removeItem('elia.activeGame');
      await loadGames();
      localStorage.setItem('elia.activeGame', st.game);
      await loadSequence();
      showToast(`"${deletedTitle}" deleted.`);
    } catch (err) {
      showToast(`Delete failed: ${err.message}`, true);
    }
  }

  async function loadSequence() {
    try {
      const res = await fetch(`/api/sequence?${gq()}&v=${Date.now()}`);
      st.sequence = res.ok ? await res.json() : { version: '1', title: st.game, start: null, scenes: [] };
    } catch {}
    renderSceneList();
    if (st.sequence.scenes.length) selectScene(st.sequence.scenes[0]);
    else showEmpty();

    // Fill in the remaining scene configs in the background — one batched
    // request no matter how many scenes the game has.
    (async () => {
      const missing = (st.sequence.scenes || []).filter(id => !st.configs[id]);
      if (!missing.length) return;
      let batched = false;
      try {
        const res = await fetch(`/api/scenes/full?${gq()}`);
        if (res.ok) {
          const data = await res.json();
          for (const cfg of (data.scenes || [])) {
            if (cfg && cfg.id && !st.configs[cfg.id]) st.configs[cfg.id] = cfg;
          }
          batched = true;
        }
      } catch {}
      if (!batched) {
        await Promise.all(missing.map(async (id) => {
          try {
            const res = await fetch(`/api/scene?id=${encodeURIComponent(id)}&${gq()}`);
            if (res.ok) st.configs[id] = await res.json();
          } catch {}
        }));
      }
      renderSceneList();
    })();
  }

  // ─── Wire buttons ────────────────────────────────────────────────────────────
  function wireButtons() {
    btnAddScene.onclick     = () => openAddSceneModal();
    btnAddSceneCancel.onclick = () => closeAddSceneModal();
    btnAddSceneCreate.onclick = () => createScene();

    btnSave.onclick         = () => saveAll().catch(() => {});
    btnTestScene.onclick    = () => testThisScene(false);
    btnTestAll.onclick      = () => testAll(false);
    document.getElementById('btnTestSceneMobile')?.addEventListener('click', () => testThisScene(true));
    document.getElementById('btnTestAllMobile')?.addEventListener('click', () => testAll(true));
    btnPublish.onclick      = () => publish();
    if (btnPublishFooter) btnPublishFooter.onclick = () => publish();   // removed from the footer — header only

    btnOpenAIStatus.onclick = () => checkAIStatus();

    const sceneFilter = document.getElementById('sceneFilter');
    if (sceneFilter) {
      sceneFilter.addEventListener('input', () => {
        st.sceneFilter = sceneFilter.value;
        renderSceneList();
      });
    }

    if (gameSwitcher) gameSwitcher.addEventListener('change', () => switchGame(gameSwitcher.value));
    if (btnNewGame)   btnNewGame.addEventListener('click', () => createGame());

    // Delete game (confirmation modal)
    if (btnDeleteGame) btnDeleteGame.addEventListener('click', () => openDeleteGameModal());
    document.getElementById('btnDeleteGameCancel')?.addEventListener('click', () => closeDeleteGameModal());
    document.getElementById('btnDeleteGameConfirm')?.addEventListener('click', () => confirmDeleteGame());
    if (deleteGameModal) {
      deleteGameModal.addEventListener('click', (e) => {
        if (e.target === deleteGameModal) closeDeleteGameModal();
      });
    }

    // Unsaved-changes indicator on the Save button — only touch the DOM when
    // the dirty state actually flips (this ticks forever, keep it free).
    let lastDirtyShown = null;
    setInterval(() => {
      const dirty = !!st.dirty;
      if (dirty === lastDirtyShown) return;
      lastDirtyShown = dirty;
      btnSave.classList.toggle('has-changes', dirty);
      btnSave.textContent = dirty ? 'Save •' : 'Save';
      updateScenePill();
    }, 400);

    // Don't let an accidental tab close lose unsaved work
    window.addEventListener('beforeunload', (e) => {
      if (st.dirty) { e.preventDefault(); e.returnValue = ''; }
    });

    // Click outside the modal closes it
    addSceneModal.addEventListener('click', (e) => {
      if (e.target === addSceneModal) closeAddSceneModal();
    });

    // Modal type picker
    addSceneModal.querySelectorAll('.modal-type').forEach(btn => {
      btn.onclick = () => {
        addSceneModal.querySelectorAll('.modal-type').forEach(b => b.classList.remove('is-selected'));
        btn.classList.add('is-selected');
        selectedModalType = btn.dataset.type;
      };
    });

    newSceneName.addEventListener('keydown', e => { if (e.key === 'Enter') createScene(); });

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveAll().catch(() => {}); }
      if (e.key === 'Escape') { closeAddSceneModal(); closeDeleteGameModal(); }
    });
  }

  // ─── Scene list ──────────────────────────────────────────────────────────────
  function renderSceneList() {
    sceneList.innerHTML = '';
    const scenes = st.sequence.scenes || [];
    const filter = (st.sceneFilter || '').trim().toLowerCase();
    let shown = 0;
    scenes.forEach((id, idx) => {
      if (filter) {
        const cfg = st.configs[id];
        const hay = `${cfg?.title || ''} ${id} ${cfg?.type || ''}`.toLowerCase();
        if (!hay.includes(filter)) return;
      }
      shown++;
      const config = st.configs[id];
      const title  = config ? config.title : id;
      const type   = config ? config.type  : '?';

      const li = document.createElement('li');
      li.className = `scene-item${id === st.activeId ? ' is-active' : ''}`;
      li.draggable = !filter;   // reordering a filtered list would be misleading
      li.dataset.sceneId = id;
      const isStart = st.sequence.start === id;
      li.innerHTML = `
        <span class="scene-item__grip" title="Drag to reorder" aria-hidden="true">⠿</span>
        <span class="scene-item__order${isStart ? ' scene-item__order--start' : ''}" title="${isStart ? 'Start scene — the game begins here' : `Scene ${idx + 1}`}">${isStart ? '▶' : idx + 1}</span>
        <span class="scene-item__title">${esc(title)}</span>
        <span class="scene-item__badge scene-item__badge--${type}">${type}</span>
        <div class="scene-item__controls">
          ${idx > 0 ? '<button class="scene-ctrl" data-action="up" title="Move up">↑</button>' : ''}
          ${idx < scenes.length - 1 ? '<button class="scene-ctrl" data-action="down" title="Move down">↓</button>' : ''}
          <button class="scene-ctrl" data-action="duplicate" title="Duplicate scene">⧉</button>
          <button class="scene-ctrl scene-ctrl--delete" data-action="delete" title="Delete scene">×</button>
        </div>
      `;
      li.addEventListener('click', (e) => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (action === 'up')          moveScene(id, -1);
        else if (action === 'down')      moveScene(id, 1);
        else if (action === 'duplicate') duplicateScene(id);
        else if (action === 'delete')    deleteScene(id);
        else selectScene(id);
      });

      // Drag & drop reordering
      li.addEventListener('dragstart', (e) => {
        dragSceneId = id;
        li.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      li.addEventListener('dragend', () => {
        dragSceneId = null;
        sceneList.querySelectorAll('.scene-item').forEach(el => el.classList.remove('is-dragging', 'drag-over'));
      });
      li.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (dragSceneId && dragSceneId !== id) li.classList.add('drag-over');
      });
      li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        li.classList.remove('drag-over');
        if (!dragSceneId || dragSceneId === id) return;
        const arr  = st.sequence.scenes;
        const from = arr.indexOf(dragSceneId);
        let to     = arr.indexOf(id);
        if (from < 0 || to < 0) return;
        arr.splice(from, 1);
        to = arr.indexOf(id);
        arr.splice(from < to + 1 ? to + 1 : to, 0, dragSceneId);
        fetch('/api/scenes/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenes: arr, game: st.game }) })
          .then(r => { if (!r.ok) showToast('Reorder was not saved — check the server.', true); })
          .catch(() => showToast('Reorder was not saved — check the server.', true));
        renderSceneList();
      });
      sceneList.appendChild(li);
    });

    const label = document.querySelector('.editor-sidebar__label');
    if (label) {
      label.textContent = !scenes.length ? 'SEQUENCE'
        : filter ? `SEQUENCE · ${shown}/${scenes.length}`
        : `SEQUENCE · ${scenes.length}`;
    }
    if (filter && !shown) {
      sceneList.innerHTML = '<li class="scene-list__empty">No scenes match.</li>';
    }
  }

  let dragSceneId = null;

  async function duplicateScene(id) {
    try {
      const res  = await fetch('/api/scenes/duplicate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, game: st.game }) });
      const data = await res.json();
      if (!data.ok) { showToast(`Duplicate failed: ${data.error || 'unknown error'}`, true); return; }
      st.configs[data.id] = data.config;
      const idx = st.sequence.scenes.indexOf(id);
      st.sequence.scenes.splice(idx >= 0 ? idx + 1 : st.sequence.scenes.length, 0, data.id);
      renderSceneList();
      selectScene(data.id);
      showToast(`Duplicated as "${data.config.title}".`);
    } catch (err) {
      showToast(`Duplicate failed: ${err.message}`, true);
    }
  }

  async function restoreSceneBackup(config) {
    try {
      const listRes = await fetch(`/api/scene/backups?id=${encodeURIComponent(config.id)}&${gq()}`);
      const { backups = [] } = await listRes.json();
      if (!backups.length) { showToast('No saved versions yet — backups are created each time you Save.'); return; }
      const when = backups[0].replace(/^scene\.json\./, '').replace(/\.bak$/, '').replace(/T/, ' ').replace(/-(\d{2})-(\d{2})-\d{3}Z?$/, ':$1:$2');
      if (!confirm(`Restore the previous version saved at ${when}? Your current version is backed up first.`)) return;
      const res  = await fetch('/api/scene/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: config.id, game: st.game }) });
      const data = await res.json();
      if (!data.ok) { showToast(`Restore failed: ${data.error || 'unknown error'}`, true); return; }
      st.configs[config.id] = data.config;
      st.dirty = false;
      renderSceneList();
      renderPanel();
      showToast('Previous version restored.');
    } catch (err) {
      showToast(`Restore failed: ${err.message}`, true);
    }
  }

  async function selectScene(id) {
    // Autosave the scene being left so switching never loses work
    if (st.dirty && st.activeId && st.activeId !== id) await saveAll();

    st.activeId = id;
    st.riveIssueCount = 0;   // stale warnings don't carry over; the contract check re-runs
    renderSceneList();

    // Load config if not cached
    if (!st.configs[id]) {
      try {
        const res = await fetch(`/api/scene?id=${encodeURIComponent(id)}&${gq()}`);
        if (res.ok) st.configs[id] = await res.json();
        else st.configs[id] = { id, title: id, type: 'rive', files: {}, after: { trigger: 'tap_heart', message: '', next: null } };
      } catch { return; }
    }

    // Load file list
    await loadSceneFiles(id);
    reconcileSceneFiles(st.configs[id], st.files[id]);

    // Re-render scene list now that config is loaded (fixes "?" badge)
    renderSceneList();
    renderPanel();
  }

  async function loadSceneFiles(id) {
    try {
      const res = await fetch(`/api/scene/files?id=${encodeURIComponent(id)}&${gq()}`);
      st.files[id] = res.ok ? (await res.json()).files || [] : [];
    } catch { st.files[id] = []; }
  }

  // Scene configs can point at audio files that no longer exist on disk
  // (renamed or deleted outside the editor). Stale entries used to hijack the
  // lip-sync section — it tried to load a 404 file and looked broken with no
  // explanation. Drop them and say so.
  function reconcileSceneFiles(config, files) {
    if (!config || !Array.isArray(files)) return;
    const disk = new Set(files);
    const removed = [];

    for (const f of Object.keys(config.files || {})) {
      if (!disk.has(f)) { removed.push(f); delete config.files[f]; }
    }
    if (Array.isArray(config.segments)) {
      for (const seg of config.segments) {
        if (!seg || seg.type === 'chat') continue;
        if (seg.voice && !disk.has(seg.voice)) { removed.push(seg.voice); seg.voice = ''; }
        if (Array.isArray(seg.bgs)) seg.bgs = seg.bgs.filter(f => disk.has(f));
        if (seg.sfx && !disk.has(seg.sfx)) seg.sfx = '';
      }
    }

    const unique = [...new Set(removed)];
    if (unique.length) {
      st.dirty = true;
      showToast(`Cleared ${unique.length} reference${unique.length > 1 ? 's' : ''} to missing audio: ${unique.join(', ')} — re-assign a voice file or generate a new one.`, true);
    }
  }

  function moveScene(id, dir) {
    const arr = st.sequence.scenes;
    const i   = arr.indexOf(id);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    fetch('/api/scenes/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenes: arr, game: st.game }) })
      .then(r => { if (!r.ok) showToast('Reorder was not saved — check the server.', true); })
      .catch(() => showToast('Reorder was not saved — check the server.', true));
    renderSceneList();
  }

  async function deleteScene(id) {
    if (!confirm(`Delete scene "${st.configs[id]?.title || id}"? This cannot be undone.`)) return;
    await fetch('/api/scenes/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, game: st.game }) });
    st.sequence.scenes = st.sequence.scenes.filter(s => s !== id);
    delete st.configs[id];
    delete st.files[id];
    st.activeId = null;
    renderSceneList();
    showEmpty();
    showToast('Scene deleted.');
  }

  // ─── Add scene modal ─────────────────────────────────────────────────────────
  function openAddSceneModal() {
    selectedModalType = 'rive';
    addSceneModal.querySelectorAll('.modal-type').forEach(b => b.classList.remove('is-selected'));
    addSceneModal.querySelector('[data-type="rive"]').classList.add('is-selected');
    newSceneName.value = '';
    addSceneModal.classList.add('is-open');
    setTimeout(() => newSceneName.focus(), 50);
  }

  function closeAddSceneModal() {
    addSceneModal.classList.remove('is-open');
  }

  async function createScene() {
    const title = newSceneName.value.trim();
    if (!title) { newSceneName.focus(); return; }
    closeAddSceneModal();

    const res = await fetch('/api/scenes/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, type: selectedModalType, game: st.game }),
    });
    const data = await res.json();
    if (!data.ok) { showToast('Could not create scene.', true); return; }

    st.configs[data.id]  = data.config;
    st.files[data.id]    = [];
    const seq = await (await fetch(`/api/sequence?${gq()}`)).json();
    st.sequence = seq;
    renderSceneList();
    selectScene(data.id);
    showToast(`Scene "${title}" created.`);
  }

  // ─── Panel renderer ──────────────────────────────────────────────────────────
  const DEFAULT_EMPTY_HTML = `
        <div class="editor-empty__inner">
          <div class="editor-empty__icon" aria-hidden="true">🎬</div>
          <h2 class="editor-empty__title">No scene selected</h2>
          <p class="editor-empty__text">Pick a scene from the sidebar, or create a new one to start building your story.</p>
          <button class="btn btn--save" id="btnEmptyAdd">＋ Create a scene</button>
        </div>`;

  // Delegated so it keeps working after the empty state's HTML is swapped
  editorEmpty.addEventListener('click', (e) => {
    if (e.target.closest('#btnEmptyAdd')) openAddSceneModal();
  });

  function showEmpty() {
    editorEmpty.innerHTML = DEFAULT_EMPTY_HTML;
    editorEmpty.hidden = false;
    editorPanel.hidden = true;
  }

  // ─── Workflow strip ──────────────────────────────────────────────────────────
  // The scene-building path at a glance: Voice → Lip sync → Fallback.
  // Each step shows its completion state and clicks scroll to its section.
  function renderWorkflowStrip(config) {
    if (config.type === 'video') return '';
    const files = st.files[config.id] || [];
    const hasSegments = Array.isArray(config.segments) && config.segments.length;
    const voiceFiles = hasSegments
      ? config.segments.filter(s => s && s.type !== 'chat' && s.voice).map(s => s.voice)
      : Object.keys(config.files || {}).filter(f => config.files[f] === 'voice');
    const hasVoice   = voiceFiles.length > 0;
    const hasLipSync = voiceFiles.some(f => files.includes(f.replace(/\.[^.]+$/, '') + '.lipsync.json'));
    const routeCount = Object.keys(config.routes || {}).length + (Array.isArray(config.ctaRoutes) ? config.ctaRoutes.length : 0);
    const hasFallback = !!(config.after && config.after.next) || routeCount > 0;

    const steps = [
      { done: hasVoice,    label: 'Voice',    hint: hasVoice ? `${voiceFiles.length} line${voiceFiles.length > 1 ? 's' : ''}` : 'No voice yet',       target: '.panel-section--files' },
      { done: hasLipSync,  label: 'Lip sync', hint: hasLipSync ? 'Markers saved' : hasVoice ? 'Ready for lip sync' : 'Needs a voice line',            target: '.panel-section--lipsync' },
      { done: hasFallback, label: 'Fallback', hint: hasFallback ? (config.after?.next ? `→ ${config.after.next}` : `${routeCount} route${routeCount > 1 ? 's' : ''}`) : 'No next scene', target: '.panel-section--after' },
    ];
    return `
      <div class="workflow-strip" id="workflowStrip">
        ${steps.map((s, i) => `
          <button type="button" class="workflow-step ${s.done ? 'is-done' : 'is-pending'}" data-wf-target="${s.target}" title="Jump to this section">
            <span class="workflow-step__dot">${s.done ? '✓' : i + 1}</span>
            <span class="workflow-step__label">${s.label}</span>
            <span class="workflow-step__hint">${esc(s.hint)}</span>
          </button>${i < steps.length - 1 ? '<span class="workflow-strip__arrow" aria-hidden="true">→</span>' : ''}`).join('')}
      </div>`;
  }

  // Scene status pill next to the title: Rive issues win, then dirty state.
  function updateScenePill() {
    const pill = document.getElementById('scenePill');
    if (!pill) return;
    const issues = st.riveIssueCount || 0;
    const state = issues ? 'issue' : st.dirty ? 'unsaved' : 'saved';
    if (pill.dataset.state === state) return;
    pill.dataset.state = state;
    pill.className = `scene-pill scene-pill--${state}`;
    pill.textContent = issues ? `⚠ Rive issue${issues > 1 ? 's' : ''}` : st.dirty ? '● Unsaved' : '✓ Saved';
    pill.title = issues ? 'Open RIVE SETUP to see what doesn\'t match this scene\'s file' : st.dirty ? 'Unsaved changes — ⌘S to save' : 'All changes saved';
  }

  function renderPanel() {
    const config = st.configs[st.activeId];
    if (!config) { showEmpty(); return; }

    previewTestMode = false;   // a full re-render always lands on the Canvas preview
    editorEmpty.hidden = true;
    editorPanel.hidden = false;

    const type = config.type || 'rive';

    editorPanel.innerHTML = `
      <div class="panel-section panel-section--meta">
        <div class="field-row">
          <label class="field-label">Title</label>
          <input class="field-input" id="fieldTitle" type="text" value="${esc(config.title || '')}" maxlength="64" />
          <span class="scene-pill" id="scenePill"></span>
        </div>
        <div class="field-row">
          <label class="field-label">Type</label>
          <span class="type-badge type-badge--${type}">${type}</span>
          ${st.sequence.start === config.id
            ? '<span class="start-flag" title="The game begins at this scene">▶ Game starts here</span>'
            : '<button class="btn btn--ghost btn--small" id="btnSetStart" title="Make the game begin at this scene">▶ Set as start</button>'}
          <button class="btn btn--ghost btn--small" id="btnRestoreBackup" title="Restore the previous saved version of this scene" style="margin-left:auto">↺ Restore previous save</button>
        </div>
        ${type !== 'video' ? `
        <details class="rive-setup" id="riveSetupDetails" ${st.riveSetupOpen ? 'open' : ''}>
        <summary class="rive-setup__summary">
          <span class="rive-setup__chev" aria-hidden="true">▸</span>
          RIVE SETUP
          <span class="rive-setup__badge" id="riveSetupBadge"></span>
        </summary>
        <div class="field-row field-row--rive">
          <label class="field-label">Rive file</label>
          <div class="rive-picker">
            <label class="rive-option">
              <input type="radio" name="riveSource" value="shared" ${config.rive === 'shared' ? 'checked' : ''} />
              Shared eli.riv
            </label>
            <label class="rive-upload-btn btn btn--ghost" id="sharedRiveUploadLabel" style="${config.rive !== 'shared' ? 'display:none' : ''}">
              ↑ Upload shared eli.riv
              <input type="file" id="sharedRiveInput" accept=".riv" hidden />
            </label>
            <label class="rive-option">
              <input type="radio" name="riveSource" value="scene" ${config.rive && config.rive !== 'shared' ? 'checked' : ''} />
              ${config.rive && config.rive !== 'shared' ? `<span class="rive-filename">${esc(config.rive)}</span>` : 'Scene file'}
            </label>
            <label class="rive-upload-btn btn btn--ghost" id="riveUploadLabel" style="${config.rive === 'shared' ? 'display:none' : ''}">
              ${config.rive && config.rive !== 'shared' ? 'Replace' : '↑ Upload .riv'}
              <input type="file" id="riveFileInput" accept=".riv" hidden />
            </label>
          </div>
        </div>
        <div class="field-row">
          <label class="field-label" for="fieldArtboard">Artboard</label>
          <input class="field-input field-input--sm" id="fieldArtboard" type="text" list="artboardOptions" autocomplete="off"
            placeholder="type the artboard name, or pick a detected one below"
            value="${esc(config.artboard || '')}" />
          <datalist id="artboardOptions"></datalist>
        </div>
        <div class="field-row" id="artboardDetectedRow" style="display:none">
          <label class="field-label"></label>
          <span class="panel-hint panel-hint--inline" id="artboardDetected"></span>
        </div>
        <div class="field-row">
          <label class="field-label" for="fieldStateMachines">State machines</label>
          <input class="field-input field-input--sm" id="fieldStateMachines" type="text"
            placeholder="e.g. TitleState, EliBody"
            value="${esc((config.stateMachines || []).join(', '))}" />
        </div>
        <div class="field-row" id="smAvailableRow" style="display:none">
          <label class="field-label"></label>
          <span class="panel-hint panel-hint--inline" id="smAvailable"></span>
        </div>
        <div class="field-row" id="riveCheckRow" style="display:none">
          <label class="field-label">Rive check</label>
          <span class="panel-hint panel-hint--inline" id="riveCheck"></span>
        </div>
        </details>
        ` : ''}
      </div>
      ${renderWorkflowStrip(config)}

      ${type === 'rive' ? `
        <div class="preview-lipsync-split">
          <div class="preview-lipsync-split__preview">
            ${renderPreviewSection(config)}
            ${renderConnectionsSection(config)}
          </div>
          <div class="preview-lipsync-split__editor">
            ${renderFilesSection(config)}
            ${renderLipSyncSection(config)}
            ${renderMemorySection()}
          </div>
        </div>
      ` : type === 'chat' ? `
        <div class="preview-lipsync-split">
          <div class="preview-lipsync-split__preview">
            ${renderPreviewSection(config)}
            ${renderConnectionsSection(config)}
          </div>
          <div class="preview-lipsync-split__editor">
            ${renderFilesSection(config)}
            ${renderLipSyncSection(config)}
            ${renderChatSection(config)}
            ${renderMemorySection()}
          </div>
        </div>
      ` : `
        ${renderFilesSection(config)}
      `}
      ${renderAfterSection(config)}
    `;

    bindPanelEvents(config);
    populateTtsControls();
    if (type === 'rive' || type === 'chat') { initRivePreview(config); loadMemorySection(); }
  }

  // ─── Eli's memory section ─────────────────────────────────────────────────────
  // What Eli remembers about the player across chats (per game, stored in
  // games/<id>/data/). Read-only view + a reset button.
  function renderMemorySection() {
    return `
      <div class="panel-section">
        <div class="panel-section__header">ELI'S MEMORY
          <span class="connections-hint-inline">what Eli remembers across chats — per game</span>
        </div>
        <div class="memory-body" id="memoryBody">Loading…</div>
      </div>
    `;
  }

  async function loadMemorySection() {
    const body = document.getElementById('memoryBody');
    if (!body) return;
    let state, summary;
    try {
      const res = await fetch(`/api/chat/memory?game=${encodeURIComponent(st.game)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ({ state, summary } = await res.json());
    } catch (err) {
      body.textContent = `Could not load memory (${err.message}).`;
      return;
    }

    const fresh = !state.conversation_count && !state.player_name;
    body.innerHTML = `
      ${fresh ? '<div class="memory-row memory-row--empty">Fresh slate — Eli hasn\'t met the player yet.</div>' : `
      <div class="memory-row"><span class="memory-label">Bond</span>${state.bond_level}/10 · chapter ${state.chapter} · feeling ${esc(state.emotional_state)}</div>
      <div class="memory-row"><span class="memory-label">Player</span>${state.player_name ? esc(state.player_name) : '<i>name unknown</i>'}${state.things_player_shared.length ? ` — ${esc(state.things_player_shared.slice(-5).join(' · '))}` : ''}</div>
      <div class="memory-row"><span class="memory-label">Unlocked</span>${state.memories_unlocked.length ? esc(state.memories_unlocked.join(', ')) : '<i>no memories yet</i>'} (${state.memories_available.length} left)</div>
      ${state.open_thread ? `<div class="memory-row"><span class="memory-label">Thread</span>"${esc(state.open_thread)}" — Eli picks this up next visit</div>` : ''}
      ${summary ? `<details class="memory-summary"><summary>Long-term summary</summary><div>${esc(summary)}</div></details>` : ''}
      `}
      <div class="memory-actions">
        <button class="btn btn--ghost btn--small" id="btnForgetMemory" ${fresh ? 'disabled' : ''}>⟲ Forget the player</button>
      </div>
    `;

    const btn = document.getElementById('btnForgetMemory');
    if (btn) btn.addEventListener('click', async () => {
      if (!confirm('Eli will forget everything about the player — bond, name, unlocked memories, conversation history. This cannot be undone.')) return;
      try {
        const res = await fetch('/api/chat/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game: st.game }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast('Eli\'s memory wiped — fresh slate.');
        loadMemorySection();
      } catch (err) {
        showToast(`Could not reset memory (${err.message})`, true);
      }
    });
  }

  // ─── Scene connections section ────────────────────────────────────────────────
  function renderConnectionsSection(config) {
    const scenes = (st.sequence?.scenes || []).filter(s => s !== config.id);
    const sceneOptions = scenes.map(s =>
      `<option value="${esc(s)}">${esc(st.configs[s]?.title || s)}</option>`
    ).join('');
    return `
      <div class="panel-section panel-section--connections">
        <div class="panel-section__header">SCENE CONNECTIONS</div>
        <div class="connections-list" id="connectionsList"></div>
        <div class="connections-add-row">
          <input class="field-input" id="connNewName" type="text"
                 placeholder="Rive event name (e.g. nav_next_scene)"
                 list="ctaInputNames" style="flex:1;min-width:0" />
          <datalist id="ctaInputNames"></datalist>
          <span class="connection-arrow">→</span>
          <select class="field-select" id="connNewScene" style="flex:1;min-width:0">
            <option value="">— pick scene —</option>
            ${sceneOptions}
          </select>
          <button class="btn btn--ghost" id="btnAddConn" style="white-space:nowrap;flex-shrink:0">+ Add</button>
        </div>
      </div>
    `;
  }

  function renderRouteRows(config) {
    const list = document.getElementById('connectionsList');
    if (!list) return;
    const routes = config.routes || {};
    const scenes = (st.sequence?.scenes || []).filter(s => s !== config.id);

    if (!Object.keys(routes).length) {
      list.innerHTML = '<p class="connections-empty">No connections yet — add one below.</p>';
    } else {
      list.innerHTML = Object.entries(routes).map(([inputName, dest]) => `
        <div class="connection-row">
          <span class="connection-input">${esc(inputName)}</span>
          <span class="connection-arrow">→</span>
          <select class="connection-scene field-select" data-conn-input="${esc(inputName)}">
            <option value="">— no action —</option>
            ${scenes.map(s => {
              const t = st.configs[s]?.title || s;
              return `<option value="${esc(s)}" ${dest === s ? 'selected' : ''}>${esc(t)}</option>`;
            }).join('')}
          </select>
          <span class="connection-dot ${dest ? 'is-wired' : ''}">●</span>
          <button class="btn btn--ghost connection-remove" data-conn-input="${esc(inputName)}"
                  title="Remove" style="flex-shrink:0;padding:0 6px">×</button>
        </div>
      `).join('');
    }

    list.querySelectorAll('.connection-scene').forEach(sel => {
      sel.addEventListener('change', () => {
        if (!config.routes) config.routes = {};
        const key = sel.dataset.connInput;
        if (sel.value) config.routes[key] = sel.value;
        else delete config.routes[key];
        const dot = sel.closest('.connection-row')?.querySelector('.connection-dot');
        if (dot) dot.classList.toggle('is-wired', !!sel.value);
        st.dirty = true;
      });
    });

    list.querySelectorAll('.connection-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        if (config.routes) delete config.routes[btn.dataset.connInput];
        st.dirty = true;
        renderRouteRows(config);
      });
    });
  }

  function populateConnectionsSection(config) {
    renderRouteRows(config);

    // Populate datalist with all inputs/events detected from the running Rive preview
    const ctaList = document.getElementById('ctaInputNames');
    if (ctaList) {
      ctaList.innerHTML = '';
      for (const [name] of riveInputMap) {
        const opt = document.createElement('option');
        opt.value = name;
        ctaList.appendChild(opt);
      }
    }

    const btnAdd = document.getElementById('btnAddConn');
    if (btnAdd) {
      btnAdd.addEventListener('click', () => {
        const nameInput  = document.getElementById('connNewName');
        const sceneSelect = document.getElementById('connNewScene');
        const name  = nameInput?.value.trim();
        const scene = sceneSelect?.value;
        if (!name || !scene) { showToast('Enter a Rive event name and pick a scene.', true); return; }
        if (!config.routes) config.routes = {};
        config.routes[name] = scene;
        st.dirty = true;
        if (nameInput)   nameInput.value  = '';
        if (sceneSelect) sceneSelect.value = '';
        renderRouteRows(config);
      });
    }
  }

  // ─── Files section ───────────────────────────────────────────────────────────
  function renderFilesSection(config) {
    const type  = config.type;
    const files = st.files[config.id] || [];
    const roles = config.files || {};
    const audioFiles = files.filter(f => !f.endsWith('.lipsync.json'));
    const label = type === 'video' ? 'VIDEO FILE' : 'AUDIO FILES';
    const accept = type === 'video' ? 'video/*' : 'audio/*';

    const rowsHtml = audioFiles.map(f => renderFileRow(f, roles[f] || 'unset', type, config.id)).join('');

    // With more than two files, tuck the list into an accordion so the panel
    // stays scannable. A summary line shows what's inside at a glance.
    let listHtml;
    if (audioFiles.length > 2) {
      const voiceCount = audioFiles.filter(f => roles[f] === 'voice').length;
      const bgCount    = audioFiles.filter(f => roles[f] === 'bg').length;
      const videoCount = audioFiles.filter(f => roles[f] === 'video').length;
      const unsetCount = audioFiles.length - voiceCount - bgCount - videoCount;
      const metaParts  = [];
      if (voiceCount) metaParts.push(`${voiceCount} voice`);
      if (bgCount)    metaParts.push(`${bgCount} background`);
      if (videoCount) metaParts.push(`${videoCount} video`);
      if (unsetCount) metaParts.push(`${unsetCount} without a role`);
      listHtml = `
        <details class="files-accordion" id="filesAccordion" ${st.audioFilesOpen ? 'open' : ''}>
          <summary class="files-accordion__summary">
            <span class="files-accordion__chev" aria-hidden="true">▸</span>
            <span class="files-accordion__count">${audioFiles.length} files</span>
            <span class="files-accordion__meta">${esc(metaParts.join(' · '))}</span>
          </summary>
          <div class="file-list" id="fileList">${rowsHtml}</div>
        </details>`;
    } else {
      listHtml = `<div class="file-list" id="fileList">${rowsHtml}</div>`;
    }

    return `
      <div class="panel-section panel-section--files">
        <div class="panel-section__header">${label}</div>
        ${listHtml}
        <label class="upload-zone" id="uploadZone">
          <span class="upload-zone__text">↑ Upload ${type === 'video' ? 'video' : 'audio'}</span>
          <input type="file" id="fileUpload" accept="${accept}" multiple hidden />
        </label>
        ${type !== 'video' ? renderTtsBlock() : ''}
        <div class="upload-status" id="uploadStatus"></div>
      </div>
    `;
  }

  // ─── Text-to-speech authoring ────────────────────────────────────────────────
  // Type a line, get an audio file in this scene — no recording needed.
  // Kokoro and say run locally; Gemini uses the Google API when configured.
  let ttsStatus = null;   // { say, kokoro, gemini, sayVoices, kokoroVoices, geminiVoices } from /api/tts-status

  function renderTtsBlock() {
    return `
      <div class="tts-block" id="ttsBlock">
        <div class="tts-block__title">⌨ Generate Eli voice <span class="mumble-tune__scope">(Google)</span></div>
        <div class="tts-workflow" aria-label="Eli voice workflow">
          <span class="tts-workflow__step">Write line</span>
          <span class="tts-workflow__step">Direct performance</span>
          <span class="tts-workflow__step">Generate</span>
          <span class="tts-workflow__step">Edit lip sync</span>
        </div>
        <textarea class="field-textarea tts-block__text" id="ttsText" rows="2" maxlength="500"
          placeholder="Type the line Eli should say..."></textarea>
        <div class="tts-director__header">
          <span>Acting controls</span>
          <span class="tts-director__hint">Targets the selected words or cursor position</span>
        </div>
        <div class="tts-director">
          <button type="button" class="btn btn--ghost btn--small" data-tts-emphasis>Emphasis</button>
          <button type="button" class="btn btn--ghost btn--small" data-tts-pause="0.5">+0.5s</button>
          <button type="button" class="btn btn--ghost btn--small" data-tts-pause="1.0">+1s</button>
          <button type="button" class="btn btn--ghost btn--small" data-tts-pause="1.5">+1.5s</button>
          <button type="button" class="btn btn--ghost btn--small" data-tts-pause="2.0">+2s</button>
          <button type="button" class="btn btn--ghost btn--small" data-tts-pause="3.0">+3s</button>
          <input class="tts-director__slider" id="ttsPauseSlider" type="range" min="0.2" max="5" step="0.1" value="2" />
          <span class="tts-director__value" id="ttsPauseValue">2.0s</span>
          <button type="button" class="btn btn--ghost btn--small" data-tts-insert-pause>Insert</button>
        </div>
        <div class="tts-preview" id="ttsPreview" aria-live="polite"></div>
        <div class="tts-block__row">
          <span class="tts-block__voice-label">Eli voice</span>
          <button type="button" class="btn btn--save btn--small tts-generate-btn" id="ttsGenerateBtn">♪ Generate</button>
        </div>
        <div class="tts-block__status" id="ttsStatusMsg"></div>
      </div>`;
  }

  async function populateTtsControls() {
    if (!ttsStatus) {
      try { ttsStatus = await (await fetch('/api/tts-status')).json(); } catch { ttsStatus = { say: false, kokoro: false }; }
    }
    const btn = document.getElementById('ttsGenerateBtn');
    const msg = document.getElementById('ttsStatusMsg');
    if (!ttsStatus.gemini) {
      if (btn) btn.disabled = true;
      setTtsStatus('GEMINI_API_KEY is required for Eli voice.', 'error');
    } else {
      if (btn) btn.disabled = false;
      if (msg && msg.textContent === 'GEMINI_API_KEY is required for Eli voice.') setTtsStatus('', '');
    }
    updateTtsPreview();
  }

  function updateTtsPauseReadout() {
    const slider = document.getElementById('ttsPauseSlider');
    const value = document.getElementById('ttsPauseValue');
    if (slider && value) value.textContent = `${Number(slider.value || 2).toFixed(1)}s`;
  }

  function getTtsInput() {
    const input = document.getElementById('ttsText');
    return input instanceof HTMLTextAreaElement ? input : null;
  }

  function editTtsSelection(transform) {
    const input = getTtsInput();
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const selected = input.value.slice(start, end);
    const replacement = transform(selected);
    input.setRangeText(replacement, start, end, 'end');
    input.focus();
    updateTtsPreview();
  }

  function insertTtsToken(token) {
    const input = getTtsInput();
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const prefix = before && !/\s$/.test(before) ? ' ' : '';
    const suffix = after && !/^\s/.test(after) ? ' ' : '';
    input.setRangeText(`${prefix}${token}${suffix}`, start, end, 'end');
    input.focus();
    updateTtsPreview();
  }

  async function readJsonResponse(res) {
    try { return await res.json(); } catch { return { error: `HTTP ${res.status}` }; }
  }

  function renderTtsPreviewText(text) {
    const html = esc(text || '')
      .replace(/\*([^*\n]+)\*/g, '<span class="tts-preview__emphasis">$1</span>')
      .replace(/\[pause:\s*([0-9]+(?:\.[0-9]+)?)\]/gi, '<span class="tts-preview__pause">pause $1s</span>');
    return html || '<span class="tts-preview__empty">Preview will show emphasis and pauses here.</span>';
  }

  function updateTtsPreview() {
    const preview = document.getElementById('ttsPreview');
    const input = getTtsInput();
    if (preview) preview.innerHTML = renderTtsPreviewText(input?.value || '');
  }

  function setTtsStatus(message, tone = '') {
    const msg = document.getElementById('ttsStatusMsg');
    if (!msg) return;
    msg.className = `tts-block__status${tone ? ` is-${tone}` : ''}`;
    msg.textContent = message || '';
  }

  function setTtsError(message) {
    const msg = document.getElementById('ttsStatusMsg');
    if (!msg) return;
    msg.className = 'tts-block__status is-error';
    msg.innerHTML = `${esc(message)} <button type="button" class="btn btn--ghost btn--small tts-retry-btn" data-tts-retry>Retry</button>`;
  }

  function assignGeneratedVoice(config, filename) {
    config.files = config.files || {};
    if (!(Array.isArray(config.segments) && config.segments.length)) {
      Object.keys(config.files).forEach(f => { if (config.files[f] === 'voice') config.files[f] = 'bg'; });
    }
    config.files[filename] = 'voice';
    const seg = Array.isArray(config.segments) ? config.segments[st.activeSegmentIndex] : null;
    if (seg && seg.type !== 'chat' && !seg.voice) seg.voice = filename;
    st.dirty = true;
  }

  let ttsBusy = false;
  document.addEventListener('click', async (e) => {
    if (e.target instanceof Element && e.target.matches('[data-tts-retry]')) {
      document.getElementById('ttsGenerateBtn')?.click();
      return;
    }
    if (e.target instanceof Element && e.target.matches('[data-tts-emphasis]')) {
      const input = getTtsInput();
      if (!input) return;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      if (start === end) {
        input.setRangeText('**', start, end, 'end');
        input.setSelectionRange(start + 1, start + 1);
        input.focus();
        updateTtsPreview();
      } else {
        editTtsSelection((selected) => `*${selected}*`);
      }
      return;
    }
    if (e.target instanceof Element && e.target.matches('[data-tts-pause]')) {
      const seconds = Number(e.target.getAttribute('data-tts-pause') || 1).toFixed(1);
      insertTtsToken(`[pause: ${seconds}]`);
      return;
    }
    if (e.target instanceof Element && e.target.matches('[data-tts-insert-pause]')) {
      const slider = document.getElementById('ttsPauseSlider');
      const seconds = Number(slider?.value || 2).toFixed(1);
      insertTtsToken(`[pause: ${seconds}]`);
      return;
    }
    if (!(e.target instanceof Element) || e.target.id !== 'ttsGenerateBtn' || ttsBusy) return;
    const config = st.configs[st.activeId];
    const text   = (document.getElementById('ttsText')?.value || '').trim();
    if (!config || !text) { setTtsStatus('Type a line first.', 'error'); return; }
    ttsBusy = true;
    const btn = e.target;
    btn.textContent = '… generating';
    btn.disabled = true;
    setTtsStatus('Generating Eli voice...', 'pending');
    try {
      const res  = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          game: st.game, id: config.id, text,
          engine: 'gemini',
          voice:  'eli',
        }),
      });
      const data = await readJsonResponse(res);
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!st.files[config.id]) st.files[config.id] = [];
      if (!st.files[config.id].includes(data.filename)) st.files[config.id].push(data.filename);
      assignGeneratedVoice(config, data.filename);
      st.audioFilesOpen = true;
      await saveAll();
      setTtsStatus('Generated voice. Opening lip sync...', 'success');
      showToast(`Generated ${data.filename}`);
      await loadVoiceFile(data.filename, config);
    } catch (err) {
      setTtsError(`Google voice failed. ${err.message}`);
      showToast(`TTS failed: ${err.message}`, true);
    } finally {
      ttsBusy = false;
      const b = document.getElementById('ttsGenerateBtn');
      if (b) {
        b.textContent = '♪ Generate';
        b.disabled = !ttsStatus?.gemini;
      }
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target instanceof Element && e.target.id === 'ttsPauseSlider') updateTtsPauseReadout();
    if (e.target instanceof Element && e.target.id === 'ttsText') updateTtsPreview();
  });

  function renderFileRow(filename, role, sceneType, sceneId) {
    const isLipsyncable = sceneType === 'rive' && role === 'voice';
    const roleOptions = sceneType === 'video'
      ? [['video', 'Video']]
      : [['voice', 'Voice'], ['bg', 'Background']];

    return `
      <div class="file-row" data-filename="${esc(filename)}">
        <span class="file-row__name" title="${esc(filename)}">${esc(filename)}</span>
        <select class="file-row__role" data-file-role="${esc(filename)}">
          <option value="unset">— Role —</option>
          ${roleOptions.map(([v, l]) => `<option value="${v}" ${role === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        ${isLipsyncable ? `<button class="btn btn--edit-lipsync" data-lipsync-load="${esc(filename)}">Edit Lip Sync</button>` : ''}
        <button class="file-row__delete btn--icon" data-file-delete="${esc(filename)}" title="Remove">×</button>
      </div>
    `;
  }

  // ─── Lip sync section ────────────────────────────────────────────────────────
  // ─── Preview section ─────────────────────────────────────────────────────────
  function renderPreviewSection(config) {
    return `
      <div class="panel-section panel-section--preview">
        <div class="panel-section__header">PREVIEW
          <span class="preview-mode" id="previewModeCtl" role="group" aria-label="Preview mode">
            <button type="button" class="preview-mode__btn is-active" data-pmode="canvas" title="Pose & scrub the character directly">Canvas</button>
            <button type="button" class="preview-mode__btn" data-pmode="player" title="Run this scene exactly like the game player">Player</button>
          </span>
        </div>
        <div class="scene-preview" id="scenePreviewWrap">
          <canvas id="previewCanvas"></canvas>
          <div class="lipsync-preview__hint" id="previewHint">Loading…</div>
        </div>
      </div>
    `;
  }

  function renderExpressionPreviewControls(message = "No voice audio yet — use these controls to pose Eli's face in the preview.") {
    return `
      <div class="lipsync-layout lipsync-layout--pose">
        <div class="lipsync-controls lipsync-controls--pose" data-expression-preview="1">
          <p class="panel-hint panel-hint--pose">${message}</p>
          <div class="mouth-grid">
            ${MOUTH_LABELS.map((label, i) => `<button class="mouth-btn ${i === 0 ? 'mouth-btn--idle' : ''}" data-mouth="${i}" title="${label}">${i === 0 ? '✕' : label}</button>`).join('')}
          </div>
          <div class="emotion-row">
            <span class="row-label">Eyes</span>
            ${EMOTION_LABELS.map((l, i) => l ? `<button class="emotion-btn" data-emotion="${i}">${l}</button>` : '').join('')}
          </div>
          <div class="body-grid">
            <span class="row-label">Body</span>
            ${BODY_LABELS.map((l, i) => l ? `<button class="body-btn" data-body="${i}" title="${l}">${l}</button>` : '').join('')}
          </div>
          <div class="body-grid body-grid--head">
            <span class="row-label">Head</span>
            ${HEAD_LABELS.map((l, i) => l ? `<button class="head-btn" data-head="${i}" title="${l}">${l}</button>` : '').join('')}
          </div>
          <div class="body-grid body-grid--heart">
            <span class="row-label">Heart</span>
            ${HEART_LABELS.map((l, i) => `<button class="heart-btn" data-heart="${i}" title="${l}">${l}</button>`).join('')}
          </div>
        </div>
      </div>`;
  }

  // CTA rows shared by voice and chat segment editors. Empty label = no
  // button. Empty destination = advance to the next segment (scene fallback
  // on the last one).
  function renderSegmentCtaRows(config, seg) {
    const scenes = (st.sequence?.scenes || []).filter(s => s !== config.id);
    return `
          <div class="segment-editor__row segment-editor__row--full">
            <label class="segment-editor__label">CTA button</label>
            <input class="field-input" data-seg-field="cta_label" type="text" maxlength="40"
                   value="${esc(seg.cta_label || '')}" placeholder="e.g. Continue — empty for no button" />
          </div>
          <div class="segment-editor__row">
            <label class="segment-editor__label">CTA goes to</label>
            <select class="field-select" data-seg-field="cta_next">
              <option value="">— Next segment —</option>
              ${scenes.map(s => `<option value="${esc(s)}" ${seg.cta_next === s ? 'selected' : ''}>${esc(st.configs[s]?.title || s)}</option>`).join('')}
            </select>
          </div>
          <div class="segment-editor__row">
            <label class="segment-editor__label">CTA hold</label>
            <input type="checkbox" data-seg-field="cta_hold" ${seg.cta_hold === true ? 'checked' : ''} title="Press & hold ~1s instead of a tap" />
            <span style="opacity:.5;font-size:11px;margin-left:6px">hold to commit</span>
          </div>`;
  }

  function renderLipSyncSection(config) {
    const segments = config.segments;
    const hasSegments = Array.isArray(segments) && segments.length > 0;

    // Determine which voice file to show
    let voiceFile;
    if (hasSegments) {
      const idx = Math.min(st.activeSegmentIndex, segments.length - 1);
      st.activeSegmentIndex = idx;
      voiceFile = segments[idx]?.voice || '';
    } else {
      voiceFile = Object.keys(config.files || {}).find(f => config.files[f] === 'voice') || '';
    }

    const voiceFiles = Object.keys(config.files || {}).filter(f => config.files[f] === 'voice');

    if (st.activeVoiceFile !== voiceFile) {
      st.activeVoiceFile = '';
    }

    const isLoaded = voiceFile && st.activeVoiceFile === voiceFile;
    const dur = st.audio ? (isNaN(st.audio.duration) ? 0 : st.audio.duration) : 0;
    const cur = st.audio ? st.audio.currentTime : 0;

    // Segment picker
    let segmentPickerHtml = '';
    if (hasSegments) {
      segmentPickerHtml = `<div class="segment-picker">
        ${segments.map((seg, i) => {
          const isChat = seg.type === 'chat';
          const label  = isChat ? 'Chat' : (seg.voice ? seg.voice.replace(/\.[^.]+$/, '').slice(0, 16) : '(no audio)');
          const trig   = seg.trigger || 'ended';
          return `<button class="segment-tab ${i === st.activeSegmentIndex ? 'is-active' : ''} ${isChat ? 'segment-tab--chat' : ''}" data-seg-idx="${i}">
            <span class="segment-tab__num">${i + 1}</span>
            <span class="segment-tab__file">${esc(label)}</span>
            <span class="segment-tab__trigger">${esc(trig)}</span>
            <span class="segment-tab__delete" data-seg-delete="${i}" title="Delete segment">×</span>
          </button>`;
        }).join('')}
        <button class="segment-tab segment-tab--add" data-action="add-segment">+ Voice</button>
        <button class="segment-tab segment-tab--add segment-tab--chat-add" data-action="add-chat-segment">+ Chat</button>
      </div>`;
    }

    // Segment config (voice picker + trigger)
    let segmentConfigHtml = '';
    if (hasSegments) {
      const seg = segments[st.activeSegmentIndex] || {};
      const isLast = st.activeSegmentIndex === segments.length - 1;
      const allFiles = st.files[config.id] || [];
      const isChat = seg.type === 'chat';

      if (isChat) {
        segmentConfigHtml = `<div class="segment-editor segment-editor--chat">
          <div class="segment-editor__row segment-editor__row--full">
            <label class="segment-editor__label">Opening line</label>
            <input class="field-input" data-seg-field="opening" type="text" value="${esc(seg.opening || '')}" placeholder="What Eli says to start the conversation" />
          </div>
          <div class="segment-editor__row">
            <label class="segment-editor__label">Max exchanges</label>
            <input class="field-input" data-seg-field="max_exchanges" type="number" value="${seg.max_exchanges || 0}" min="0" style="width:70px" title="0 = unlimited" />
          </div>
          <div class="segment-editor__row segment-editor__row--full">
            <label class="segment-editor__label">BG music <span style="opacity:.5;font-size:11px">(pick multiple)</span></label>
            <div class="bg-checklist" data-seg-bgs="1">
              ${allFiles.filter(f => f.match(/\.(wav|mp3|ogg|m4a)$/i)).map(f => {
                const checked = (Array.isArray(seg.bgs) ? seg.bgs : (seg.bg ? [seg.bg] : [])).includes(f);
                return `<label class="bg-check-item"><input type="checkbox" class="bg-check" value="${esc(f)}" ${checked ? 'checked' : ''} />${esc(f)}</label>`;
              }).join('')}
            </div>
          </div>
          <div class="segment-editor__row segment-editor__row--full">
            <label class="segment-editor__label">Context hint</label>
            <input class="field-input" data-seg-field="context_hint" type="text" value="${esc(seg.context_hint || '')}" placeholder="e.g. Guide toward the cold_feeling memory" />
          </div>
          <div class="segment-editor__row">
            <label class="segment-editor__label">Trigger</label>
            <select class="field-select" data-seg-field="trigger" ${isLast ? 'disabled title="Last segment uses scene FALLBACK"' : ''}>
              <option value="ended" ${(seg.trigger || 'ended') === 'ended' ? 'selected' : ''}>After max exchanges</option>
              <option value="tap_heart" ${seg.trigger === 'tap_heart' ? 'selected' : ''}>Wait for tap</option>
              ${[...riveInputMap.keys()].filter(n => n.startsWith('nav_')).map(n =>
                `<option value="${esc(n)}" ${seg.trigger === n ? 'selected' : ''}>${esc(n)}</option>`
              ).join('')}
            </select>
          </div>
          <div class="segment-editor__row">
            <label class="segment-editor__label">Pause before next</label>
            <input class="field-input" data-seg-field="delay" type="number" value="${seg.delay || 0}" min="0" step="0.5" style="width:80px" title="Seconds to wait before playing the next segment" />
            <span style="opacity:.5;font-size:12px;margin-left:6px">sec</span>
          </div>
          <div class="segment-editor__row">
            <label class="segment-editor__label">Mumble sounds</label>
            <input type="checkbox" data-seg-field="mumble" ${seg.mumble === true ? 'checked' : ''} title="Play Eli's mumble voice with caption text" />
          </div>
          ${renderMumbleTune(seg)}
          ${renderSegmentCtaRows(config, seg)}
          <button class="btn btn--ghost btn--small segment-delete-btn" data-action="delete-segment">Delete</button>
        </div>`;
      } else {
        segmentConfigHtml = `<div class="segment-editor">
          <div class="segment-editor__row">
            <label class="segment-editor__label">Voice</label>
            <select class="field-select segment-voice-select" data-seg-field="voice">
              <option value="">— none —</option>
              ${[...new Set([...voiceFiles, ...allFiles.filter(f => f.match(/\.(wav|mp3|ogg|m4a)$/i))])]
                .map(f => `<option value="${esc(f)}" ${seg.voice === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}
            </select>
          </div>
          <div class="segment-editor__row segment-editor__row--full">
            <label class="segment-editor__label">BG music <span style="opacity:.5;font-size:11px">(pick multiple)</span></label>
            <div class="bg-checklist" data-seg-bgs="1">
              ${allFiles.filter(f => f.match(/\.(wav|mp3|ogg|m4a)$/i)).map(f => {
                const checked = (Array.isArray(seg.bgs) ? seg.bgs : (seg.bg ? [seg.bg] : [])).includes(f);
                return `<label class="bg-check-item"><input type="checkbox" class="bg-check" value="${esc(f)}" ${checked ? 'checked' : ''} />${esc(f)}</label>`;
              }).join('')}
            </div>
          </div>
          <div class="segment-editor__row">
            <label class="segment-editor__label">Tap SFX</label>
            <select class="field-select" data-seg-field="sfx">
              <option value="">— none —</option>
              ${allFiles.filter(f => f.match(/\.(wav|mp3|ogg|m4a)$/i)).map(f => `<option value="${esc(f)}" ${seg.sfx === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}
            </select>
          </div>
          <div class="segment-editor__row">
            <label class="segment-editor__label">Trigger</label>
            <select class="field-select" data-seg-field="trigger" ${isLast ? 'disabled title="Last segment uses scene FALLBACK"' : ''}>
              <option value="ended" ${(seg.trigger || 'ended') === 'ended' ? 'selected' : ''}>Auto (after audio)</option>
              <option value="tap_heart" ${seg.trigger === 'tap_heart' ? 'selected' : ''}>Wait for tap</option>
              ${[...riveInputMap.keys()].filter(n => n.startsWith('nav_')).map(n =>
                `<option value="${esc(n)}" ${seg.trigger === n ? 'selected' : ''}>${esc(n)}</option>`
              ).join('')}
            </select>
          </div>
          <div class="segment-editor__row">
            <label class="segment-editor__label">Pause before next</label>
            <input class="field-input" data-seg-field="delay" type="number" value="${seg.delay || 0}" min="0" step="0.5" style="width:80px" title="Seconds to wait before playing the next segment" />
            <span style="opacity:.5;font-size:12px;margin-left:6px">sec</span>
          </div>
          ${renderSegmentCtaRows(config, seg)}
          <button class="btn btn--ghost btn--small segment-delete-btn" data-action="delete-segment">Delete</button>
        </div>`;
      }
    }

    // Enable/disable segments toggle
    const toggleHtml = !hasSegments
      ? `<button class="btn btn--ghost btn--small" data-action="enable-segments" style="margin:6px 14px">Enable segments</button>`
      : '';

    return `
      <div class="panel-section panel-section--lipsync">
        <div class="panel-section__header">${hasSegments && segments[st.activeSegmentIndex]?.type === 'chat' ? 'SEGMENTS' : 'LIP SYNC'}
          <span class="lipsync-file-name">${voiceFile ? esc(voiceFile) : ''}</span>
        </div>
        ${toggleHtml}
        ${segmentPickerHtml}
        ${segmentConfigHtml}

        ${(hasSegments && segments[st.activeSegmentIndex]?.type === 'chat')
          ? `<div class="lipsync-layout">
              <div class="lipsync-controls" style="padding:10px 14px">
                <p class="panel-hint" style="padding:0 0 8px">Chat — preview Eli's animations below</p>
                <div class="mouth-grid">
                  ${MOUTH_LABELS.map((label, i) => `<button class="mouth-btn ${i === 0 ? 'mouth-btn--idle' : ''}" data-mouth="${i}" title="${label}">${i === 0 ? '✕' : label}</button>`).join('')}
                </div>
                <div class="emotion-row">
                  <span class="row-label">Eyes</span>
                  ${EMOTION_LABELS.map((l, i) => l ? `<button class="emotion-btn" data-emotion="${i}">${l}</button>` : '').join('')}
                </div>
                <div class="body-grid">
                  <span class="row-label">Body</span>
                  ${BODY_LABELS.map((l, i) => l ? `<button class="body-btn" data-body="${i}" title="${l}">${l}</button>` : '').join('')}
                </div>
                <div class="body-grid body-grid--head">
                  <span class="row-label">Head</span>
                  ${HEAD_LABELS.map((l, i) => l ? `<button class="head-btn" data-head="${i}" title="${l}">${l}</button>` : '').join('')}
                </div>
                <div class="body-grid body-grid--heart">
                  <span class="row-label">Heart</span>
                  ${HEART_LABELS.map((l, i) => `<button class="heart-btn" data-heart="${i}" title="${l}">${l}</button>`).join('')}
                </div>
              </div>
            </div>`
          : !voiceFile ? renderExpressionPreviewControls(hasSegments
              ? "No voice selected for this segment — pose Eli's expression in the preview, or pick a voice file above to add timed lip sync."
              : "No voice audio yet — pose Eli's expression in the preview, or generate Eli voice to add timed lip sync.") :
          !isLoaded ? `<button class="btn btn--edit-lipsync" data-lipsync-load="${esc(voiceFile)}">Load for editing</button>` : `

        <div class="lipsync-layout">
          <div class="lipsync-controls">
            <div class="scrubber-wrap">
              <div class="scrub-marks" id="scrubMarks"></div>
              <canvas class="waveform-canvas" id="waveformCanvas"></canvas>
              <input class="scrubber" id="scrubber" type="range" min="0" max="${dur.toFixed(3)}" step="0.001" value="${cur.toFixed(3)}" />
            </div>
            <div class="transport">
              <span class="transport__time" id="timeDisplay">${fmtTime(cur)} / ${fmtTime(dur)}</span>
              <button class="btn btn--icon" id="btnRestart" title="Restart">⏮</button>
              <button class="btn btn--icon" id="btnPlayPause" title="Play/Pause">${st.isPlaying ? '⏸' : '▶'}</button>
              <button class="btn btn--ghost btn--small" id="btnAutoSync" title="Generate mouth markers from the audio automatically">✨ Auto sync</button>
              <label class="transport__tap">
                <input type="checkbox" id="chkTapMode" ${st.tapMode ? 'checked' : ''} />
                Tap mode
              </label>
              <label class="transport__pause">
                <input type="checkbox" id="chkPauseAfter" ${st.pauseAfterMark ? 'checked' : ''} />
                Pause after mark
              </label>
            </div>

            <div class="mouth-grid">
              ${MOUTH_LABELS.map((label, i) => `<button class="mouth-btn ${i === 0 ? 'mouth-btn--idle' : ''}" data-mouth="${i}" title="${label}">${i === 0 ? '✕' : label}</button>`).join('')}
            </div>

            <div class="emotion-row">
              <span class="row-label">Eyes</span>
              ${EMOTION_LABELS.map((l, i) => l ? `<button class="emotion-btn" data-emotion="${i}">${l}</button>` : '').join('')}
            </div>

            <div class="body-grid">
              <span class="row-label">Body</span>
              ${BODY_LABELS.map((l, i) => l ? `<button class="body-btn" data-body="${i}" title="${l}">${l}</button>` : '').join('')}
            </div>
            <div class="body-grid body-grid--head">
              <span class="row-label">Head</span>
              ${HEAD_LABELS.map((l, i) => l ? `<button class="head-btn" data-head="${i}" title="${l}">${l}</button>` : '').join('')}
            </div>
            <div class="body-grid body-grid--heart">
              <span class="row-label">Heart</span>
              ${HEART_LABELS.map((l, i) => `<button class="heart-btn" data-heart="${i}" title="${l}">${l}</button>`).join('')}
            </div>

            <div class="body-grid body-grid--haptic">
              <span class="row-label">Haptic</span>
              ${Object.entries(HAPTIC_PRESETS).map(([k, p]) => `<button class="haptic-btn" data-haptic="${k}" title="${p.hint} — click to feel it & stamp a key at the playhead">📳 ${p.label}</button>`).join('')}
              <span class="haptic-note" title="The web Vibration API works on Android phones. iPhones don't support it — haptic keys are silently skipped there.">ⓘ Android phones only</span>
            </div>

            <div class="text-cue-controls">
              <span class="row-label">Text overlay</span>
              <div class="text-cue-input-row">
                <input class="field-input text-cue-input" id="textCueInput" type="text" placeholder="Type text to show on screen…" />
                <input class="field-input text-cue-duration" id="textCueDuration" type="number" min="0.5" step="0.5" value="3" title="Duration (sec)" style="width:55px;flex:none" />
                <button class="btn btn--ghost btn--small" id="btnAddTextCue">+ Text</button>
              </div>
              <div class="text-cue-style-row">
                <label class="text-cue-style-label">Size</label>
                <select class="field-select text-cue-style-field" id="textCueSize">
                  <option value="14">S</option>
                  <option value="18">M</option>
                  <option value="24" selected>L</option>
                  <option value="32">XL</option>
                  <option value="42">XXL</option>
                </select>
                <label class="text-cue-style-label">Color</label>
                <input class="text-cue-color" id="textCueColor" type="color" value="#C1A376" title="Text color" />
                <label class="text-cue-style-label">Pos</label>
                <select class="field-select text-cue-style-field" id="textCuePosition">
                  <option value="bottom">Bottom</option>
                  <option value="center">Center</option>
                  <option value="top">Top</option>
                  <option value="caption" selected>Caption</option>
                </select>
                <label class="text-cue-style-label">Weight</label>
                <select class="field-select text-cue-style-field" id="textCueWeight">
                  <option value="400">Normal</option>
                  <option value="600">Semi</option>
                  <option value="700" selected>Bold</option>
                </select>
                <label class="text-cue-style-label">Speed</label>
                <select class="field-select text-cue-style-field" id="textCueSpeed">
                  <option value="30">Fast</option>
                  <option value="60">Medium</option>
                  <option value="90" selected>Normal</option>
                  <option value="140">Slow</option>
                  <option value="220">Very Slow</option>
                </select>
                <label class="text-cue-style-label" style="margin-left:6px">
                  <input type="checkbox" id="textCueLipSync" checked /> Lip sync
                </label>
              </div>
            </div>
          </div>
        </div>

        <div class="text-cue-list" id="textCueList"></div>
        <div class="marker-list" id="markerList"></div>
        `}
      </div>
    `;
  }

  // ─── Chat section ────────────────────────────────────────────────────────────
  function renderChatSection(config) {
    return `
      <div class="panel-section">
        <div class="panel-section__header">AI PERSONA</div>
        <label class="field-label" style="padding:10px 14px 4px">System prompt</label>
        <div style="padding:0 14px 14px"><textarea class="field-textarea" id="fieldSystemPrompt" rows="8">${esc(config.system_prompt || '')}</textarea></div>
      </div>
      <div class="panel-section">
        <div class="panel-section__header">ANIMATION PREVIEW</div>
        <div style="padding:10px 14px">
          <div class="mouth-grid">
            ${MOUTH_LABELS.map((label, i) => `<button class="mouth-btn ${i === 0 ? 'mouth-btn--idle' : ''}" data-mouth="${i}" title="${label}">${i === 0 ? '✕' : label}</button>`).join('')}
          </div>
          <div class="emotion-row">
            <span class="row-label">Eyes</span>
            ${EMOTION_LABELS.map((l, i) => l ? `<button class="emotion-btn" data-emotion="${i}">${l}</button>` : '').join('')}
          </div>
          <div class="body-grid">
            <span class="row-label">Body</span>
            ${BODY_LABELS.map((l, i) => l ? `<button class="body-btn" data-body="${i}" title="${l}">${l}</button>` : '').join('')}
          </div>
          <div class="body-grid body-grid--head">
            <span class="row-label">Head</span>
            ${HEAD_LABELS.map((l, i) => l ? `<button class="head-btn" data-head="${i}" title="${l}">${l}</button>` : '').join('')}
          </div>
          <div class="body-grid body-grid--heart">
            <span class="row-label">Heart</span>
            ${HEART_LABELS.map((l, i) => `<button class="heart-btn" data-heart="${i}" title="${l}">${l}</button>`).join('')}
          </div>
        </div>
      </div>
    `;
  }

  // ─── Mumble voice tuning ──────────────────────────────────────────────────────
  // Sliders next to the Mumble checkbox. Game-wide (stored as `mumble` in
  // sequence.json, in percent), auto-saved on change, auditioned live using
  // the same sprite + prosody math as the game player.
  const MUMBLE_TUNE_DEFAULTS = { volume: 100, pitch: 100, expression: 100, variation: 100 };
  const MUMBLE_TUNE_LABELS = [
    ['volume',     'Volume',     0,  150, 'overall loudness'],
    ['pitch',      'Pitch',      80, 130, 'voice higher / lower'],
    ['expression', 'Expression', 0,  200, 'how melodic — flat monotone to sing-song'],
    ['variation',  'Variation',  0,  200, 'randomness — steady to shaky'],
  ];

  function getMumbleTune() {
    const t = { ...MUMBLE_TUNE_DEFAULTS };
    for (const k of Object.keys(t)) {
      const v = Number(st.sequence.mumble && st.sequence.mumble[k]);
      if (Number.isFinite(v)) t[k] = v;
    }
    return t;
  }

  function renderMumbleTune(seg) {
    const t = getMumbleTune();
    return `
          <div class="segment-editor__row segment-editor__row--full" data-mumble-tune-wrap="1" style="${seg.mumble === true ? '' : 'display:none'}">
            <label class="segment-editor__label">Voice tuning <span class="mumble-tune__scope">(whole game)</span></label>
            <div class="mumble-tune">
              ${MUMBLE_TUNE_LABELS.map(([key, label, min, max, hint]) => `
              <div class="mumble-tune__row" title="${hint}">
                <span class="mumble-tune__name">${label}</span>
                <input type="range" data-mumble-param="${key}" min="${min}" max="${max}" value="${t[key]}" />
                <span class="mumble-tune__val" data-mumble-val="${key}">${t[key]}%</span>
              </div>`).join('')}
              <div class="mumble-tune__actions">
                <button type="button" class="btn btn--ghost btn--small" data-mumble-test="1">▶ Test voice</button>
                <button type="button" class="btn btn--ghost btn--small" data-mumble-reset="1">Reset</button>
              </div>
            </div>
          </div>`;
  }

  let mumbleTuneSaveTimer = null;
  function scheduleMumbleTuneSave() {
    clearTimeout(mumbleTuneSaveTimer);
    mumbleTuneSaveTimer = setTimeout(async () => {
      try {
        await fetch('/api/sequence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...st.sequence, game: st.game }),
        });
      } catch { showToast('Could not save voice tuning — check the server.', true); }
    }, 600);
  }

  function refreshMumbleTuneUI() {
    const t = getMumbleTune();
    for (const [key] of MUMBLE_TUNE_LABELS) {
      const slider = document.querySelector(`[data-mumble-param="${key}"]`);
      const val    = document.querySelector(`[data-mumble-val="${key}"]`);
      if (slider) slider.value = t[key];
      if (val) val.textContent = `${t[key]}%`;
    }
  }

  // Audition player — mirrors playMumbleSample in src/main.js
  let auditionCtx = null, auditionBuf = null, auditionChunks = null, auditionTimer = null;

  async function ensureAuditionAudio() {
    if (auditionBuf) return;
    if (!auditionCtx) auditionCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (auditionCtx.state === 'suspended') await auditionCtx.resume();
    const [mf, wf] = await Promise.all([
      fetch('/public/audio/mumble/eli-mumble.json'),
      fetch('/public/audio/mumble/eli-mumble.wav'),
    ]);
    if (!mf.ok || !wf.ok) throw new Error('sprite missing');
    const manifest = await mf.json();
    auditionBuf    = await auditionCtx.decodeAudioData(await wf.arrayBuffer());
    auditionChunks = manifest.chunks || [];
  }

  async function playMumbleAudition() {
    try {
      await ensureAuditionAudio();
    } catch {
      showToast('Mumble sprite not found — run: node build-mumble-sprite.mjs <voice mp3s>', true);
      return;
    }
    const t      = getMumbleTune();
    const voiced = auditionChunks.filter(c => c.kind === 'voiced');
    if (!voiced.length) return;
    const n = 5;
    const expr = t.expression / 100, vari = t.variation / 100;
    let walk = 0, recent = [];
    for (let k = 0; k < n; k++) {
      const pool  = voiced.filter(c => !recent.includes(c));
      const chunk = (pool.length ? pool : voiced)[Math.floor(Math.random() * (pool.length || voiced.length))];
      recent = [chunk, ...recent].slice(0, 3);
      const prog = k / (n - 1);
      walk = Math.max(-0.05, Math.min(0.05, walk + (Math.random() * 0.036 - 0.018) * vari));
      let rate = t.pitch / 100;
      rate *= 1 + (0.05 - 0.10 * prog) * expr;
      rate *= 1 + walk * expr + (Math.random() * 0.02 - 0.01) * vari;
      const src = auditionCtx.createBufferSource();
      src.buffer = auditionBuf;
      src.playbackRate.value = rate;
      const g = auditionCtx.createGain();
      g.gain.value = 0.5 * (t.volume / 100) * (k === 0 ? 1.15 : 1 - 0.08 * vari + Math.random() * 0.16 * vari);
      src.connect(g);
      g.connect(auditionCtx.destination);
      src.start(auditionCtx.currentTime + 0.05 + k * 0.22, chunk.start, chunk.dur);
    }
  }

  function scheduleMumbleAudition() {
    clearTimeout(auditionTimer);
    auditionTimer = setTimeout(playMumbleAudition, 250);
  }

  // Delegated so the bindings survive panel re-renders
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || !el.dataset.mumbleParam) return;
    const t = getMumbleTune();
    t[el.dataset.mumbleParam] = Number(el.value);
    st.sequence.mumble = t;
    const val = document.querySelector(`[data-mumble-val="${el.dataset.mumbleParam}"]`);
    if (val) val.textContent = `${el.value}%`;
    scheduleMumbleTuneSave();
    scheduleMumbleAudition();
  });
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element && e.target.closest('[data-mumble-test],[data-mumble-reset]');
    if (!btn) return;
    if (btn.dataset.mumbleReset) {
      st.sequence.mumble = { ...MUMBLE_TUNE_DEFAULTS };
      refreshMumbleTuneUI();
      scheduleMumbleTuneSave();
    }
    playMumbleAudition();
  });
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el instanceof HTMLInputElement && el.dataset.segField === 'mumble') {
      const wrap = el.closest('.segment-editor')?.querySelector('[data-mumble-tune-wrap]');
      if (wrap) wrap.style.display = el.checked ? '' : 'none';
    }
  });

  // ─── After section ───────────────────────────────────────────────────────────
  function renderAfterSection(config) {
    const after   = config.after || {};
    const scenes  = st.sequence.scenes || [];

    return `
      <details class="panel-section panel-section--after panel-section--collapsible" data-collapse="fallback" ${st.sectionOpen.fallback ? 'open' : ''}>
        <summary class="panel-section__header panel-section__header--summary">
          <span class="rive-setup__chev" aria-hidden="true">▸</span>
          FALLBACK
          <span class="connections-hint-inline">${Array.isArray(config.segments) && config.segments.length ? 'after last segment ends' : 'if no CTA is tapped'}${config.after?.next ? ` · → ${esc(st.configs[config.after.next]?.title || config.after.next)}` : ''}</span>
        </summary>
        <div class="field-row">
          <label class="field-label">Then</label>
          <select class="field-select" id="fieldTrigger">
            <option value="never"  ${after.trigger === 'never'  || !after.trigger ? 'selected' : ''}>Do nothing (open-ended)</option>
            <option value="auto"   ${after.trigger === 'auto'   ? 'selected' : ''}>Auto-advance to next scene</option>
            <option value="tap_heart" ${after.trigger === 'tap_heart' ? 'selected' : ''}>Wait for canvas tap</option>
            <option value="ended"  ${after.trigger === 'ended'  ? 'selected' : ''}>After audio / video ends</option>
          </select>
        </div>
        <div class="field-row">
          <label class="field-label">Go to scene</label>
          <select class="field-select" id="fieldNextScene">
            <option value="">— End of game —</option>
            ${scenes.filter(s => s !== config.id).map(s => {
              const t = st.configs[s]?.title || s;
              return `<option value="${s}" ${after.next === s ? 'selected' : ''}>${esc(t)}</option>`;
            }).join('')}
          </select>
        </div>
        <div class="field-row">
          <label class="field-label">Message</label>
          <input class="field-input" id="fieldMessage" type="text" value="${esc(after.message || '')}" placeholder="Optional overlay text shown to player" />
        </div>
      </details>
      <details class="panel-section panel-section--cta panel-section--collapsible" data-collapse="cta" ${st.sectionOpen.cta ? 'open' : ''}>
        <summary class="panel-section__header panel-section__header--summary">
          <span class="rive-setup__chev" aria-hidden="true">▸</span>
          CTA BUTTON
          <span class="connections-hint-inline">${config.cta?.label ? `"${esc(config.cta.label)}"${config.cta.hold ? ' · hold' : ''}` : 'a tappable button at the bottom of the screen'}</span>
        </summary>
        <div class="field-row">
          <label class="field-label">Button text</label>
          <input class="field-input" id="fieldCtaLabel" type="text" maxlength="40"
                 value="${esc(config.cta?.label || '')}" placeholder="e.g. Continue — leave empty for no button" />
        </div>
        <div class="field-row">
          <label class="field-label">Goes to</label>
          <select class="field-select" id="fieldCtaNext">
            <option value="">— Next scene (follows FALLBACK) —</option>
            ${scenes.filter(s => s !== config.id).map(s => {
              const t = st.configs[s]?.title || s;
              return `<option value="${s}" ${config.cta?.next === s ? 'selected' : ''}>${esc(t)}</option>`;
            }).join('')}
          </select>
        </div>
        <div class="field-row">
          <label class="field-label">Hold to commit</label>
          <input type="checkbox" id="fieldCtaHold" ${config.cta?.hold ? 'checked' : ''} />
          <span class="panel-hint panel-hint--inline">press &amp; hold ~1s instead of a tap — the pill fills while held</span>
        </div>
      </details>
      ${config.type === 'rive' ? renderHeartTouchSection(config) : ''}
    `;
  }

  // ─── Heart touch section ──────────────────────────────────────────────────────
  // Invisible gesture zone over Eli's heart. The Rive file owns the visual
  // (heart_state); these rows own what each gesture does.
  function renderHeartTouchSection(config) {
    const activeSegment = Array.isArray(config.segments) ? config.segments[st.activeSegmentIndex] : null;
    const hasSegmentZone = activeSegment && Object.prototype.hasOwnProperty.call(activeSegment, 'heartZone');
    const hz = (hasSegmentZone ? activeSegment.heartZone : config.heartZone) || {};
    const scenes = (st.sequence.scenes || []).filter(s => s !== config.id);
    const segments = Array.isArray(config.segments) ? config.segments : [];
    const destinationOpts = (sel) => {
      const segmentOptions = segments.map((seg, i) => {
        const value = `@segment:${i}`;
        const detail = seg?.type === 'chat'
          ? (seg.opening || 'Chat')
          : (seg?.voice || 'Voice');
        return `<option value="${value}" ${sel === value ? 'selected' : ''}>Segment ${i + 1} · ${esc(detail)}</option>`;
      }).join('');
      const sceneOptions = scenes.map(s =>
        `<option value="${esc(s)}" ${sel === s ? 'selected' : ''}>${esc(st.configs[s]?.title || s)}</option>`).join('');
      return `<option value="">— stay —</option>`
        + (segmentOptions ? `<optgroup label="Segments in this scene">${segmentOptions}</optgroup>` : '')
        + (sceneOptions ? `<optgroup label="Scenes">${sceneOptions}</optgroup>` : '');
    };
    const heartOpts = (sel) => `<option value="">— no change —</option>` + HEART_LABELS.map((l, i) =>
      l ? `<option value="${i}" ${String(sel) === String(i) ? 'selected' : ''}>${l}</option>` : '').join('');

    const gestureRow = (key, label, g, extra = '') => `
        <div class="field-row" data-heart-gesture="${key}">
          <label class="field-label">${label}</label>
          ${extra}
          <span class="nudge-inline">heart</span>
          <select class="field-select" data-hz="${key}.heartState" style="width:110px">${heartOpts(g?.heartState)}</select>
          <span class="nudge-inline">input</span>
          <input class="field-input" data-hz="${key}.input" type="text" list="ctaInputNames" autocomplete="off"
                 value="${esc(g?.input || '')}" placeholder="optional" style="width:120px" />
          <span class="nudge-inline">then</span>
          <select class="field-select" data-hz="${key}.next" style="flex:1;min-width:0">${destinationOpts(g?.next)}</select>
        </div>`;

    const activeGestures = ['tap', 'doubleTap', 'hold'].filter(k => hz[k]).length;
    return `
      <details class="panel-section panel-section--heart-touch panel-section--collapsible" data-collapse="heart" ${st.sectionOpen.heart ? 'open' : ''}>
        <summary class="panel-section__header panel-section__header--summary">
          <span class="rive-setup__chev" aria-hidden="true">▸</span>
          HEART TOUCH
          <span class="connections-hint-inline">${activeGestures ? `${activeGestures} gesture${activeGestures > 1 ? 's' : ''} active` : 'invisible gesture zone over Eli\'s heart — leave a row empty to disable it'}</span>
        </summary>
        <div class="field-row">
          <label class="field-label">Zone</label>
          <span class="nudge-inline">x</span>
          <input class="field-input" data-hz="x" type="number" min="0" max="100" value="${Number(hz.x) || 50}" style="width:58px" />
          <span class="nudge-inline">% · y</span>
          <input class="field-input" data-hz="y" type="number" min="0" max="100" value="${Number(hz.y) || 62}" style="width:58px" />
          <span class="nudge-inline">% · size</span>
          <input class="field-input" data-hz="size" type="number" min="5" max="80" value="${Number(hz.size) || 24}" style="width:58px" />
          <span class="nudge-inline">% of screen</span>
        </div>
        ${gestureRow('tap', 'Tap', hz.tap)}
        ${gestureRow('doubleTap', 'Double tap', hz.doubleTap)}
        ${gestureRow('hold', 'Hold', hz.hold, `
          <input class="field-input" data-hz="hold.duration" type="number" min="0.5" step="0.5" value="${Number(hz.hold?.duration) || 3}" style="width:52px" title="Seconds to hold" />
          <span class="nudge-inline">s ·</span>`)}
      </details>
    `;
  }

  // Populate the trigger select with input names discovered from the loaded Rive preview
  function populateTriggerSelect(config) {
    const sel = document.getElementById('fieldTrigger');
    if (!sel) return;
    let grp = sel.querySelector('optgroup[data-rive-inputs]');
    if (!grp) {
      grp = document.createElement('optgroup');
      grp.label = 'Rive Inputs';
      grp.dataset.riveInputs = '1';
      sel.appendChild(grp);
    }
    grp.innerHTML = '';
    const ctaList = document.getElementById('ctaInputNames');
    if (ctaList) ctaList.innerHTML = '';
    const currentTrigger = config.after?.trigger || '';
    for (const [name] of riveInputMap) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (currentTrigger === name) opt.selected = true;
      grp.appendChild(opt);
      if (ctaList) {
        const ctaOpt = document.createElement('option');
        ctaOpt.value = name;
        ctaList.appendChild(ctaOpt);
      }
    }
  }

  // ─── Preview test mode ────────────────────────────────────────────────────────
  let previewTestMode = false;

  function setPreviewModeButtons() {
    document.querySelectorAll('#previewModeCtl .preview-mode__btn').forEach(b => {
      b.classList.toggle('is-active', (b.dataset.pmode === 'player') === previewTestMode);
    });
  }

  async function startPreviewTest(config) {
    const wrap = document.getElementById('scenePreviewWrap');
    if (!wrap) return;

    // Auto-save before testing so the game player reads the latest markers
    if (st.dirty || st.activeVoiceFile) await saveAll();

    previewTestMode = true;
    stopAudio();

    wrap.classList.add('scene-preview--testing');
    wrap.innerHTML = `
      <iframe id="previewTestFrame" src="/?scene=${encodeURIComponent(config.id)}&${gq()}"></iframe>
    `;
    setPreviewModeButtons();
  }

  function stopPreviewTest(config) {
    previewTestMode = false;
    // renderPanel() binds events and re-inits the Rive preview itself
    renderPanel();
  }

  // ─── Panel event binding ──────────────────────────────────────────────────────
  function bindPanelEvents(config) {
    // Preview mode: Canvas (pose/scrub) ↔ Player (real game in an iframe)
    document.querySelectorAll('#previewModeCtl .preview-mode__btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const wantPlayer = btn.dataset.pmode === 'player';
        if (wantPlayer && !previewTestMode) startPreviewTest(config);
        else if (!wantPlayer && previewTestMode) stopPreviewTest(config);
      });
    });
    setPreviewModeButtons();

    // Rive setup accordion — remember open/closed, like the files accordion
    const riveSetup = document.getElementById('riveSetupDetails');
    if (riveSetup) riveSetup.addEventListener('toggle', () => { st.riveSetupOpen = riveSetup.open; });

    // FALLBACK / CTA / HEART TOUCH accordions — remember state across re-renders
    document.querySelectorAll('details[data-collapse]').forEach(d => {
      d.addEventListener('toggle', () => { st.sectionOpen[d.dataset.collapse] = d.open; });
    });

    // Workflow strip → scroll to the step's section
    document.querySelectorAll('[data-wf-target]').forEach(step => {
      step.addEventListener('click', () => {
        document.querySelector(step.dataset.wfTarget)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    updateScenePill();

    // Set as start scene
    const btnSetStart = document.getElementById('btnSetStart');
    if (btnSetStart) {
      btnSetStart.addEventListener('click', async () => {
        st.sequence.start = config.id;
        await fetch('/api/sequence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...st.sequence, game: st.game }) });
        renderSceneList();
        renderPanel();
        showToast(`The game now starts at "${config.title}".`);
      });
    }

    // Audio-files accordion — remember open/closed across re-renders
    const filesAccordion = document.getElementById('filesAccordion');
    if (filesAccordion) {
      filesAccordion.addEventListener('toggle', () => { st.audioFilesOpen = filesAccordion.open; });
    }

    // Restore previous save
    const btnRestore = document.getElementById('btnRestoreBackup');
    if (btnRestore) btnRestore.addEventListener('click', () => restoreSceneBackup(config));

    // Title rename
    const fieldTitle = document.getElementById('fieldTitle');
    if (fieldTitle) {
      fieldTitle.addEventListener('change', async () => {
        const newTitle = fieldTitle.value.trim();
        if (!newTitle || newTitle === config.title) return;
        const res  = await fetch('/api/scenes/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: config.id, title: newTitle, game: st.game }) });
        const data = await res.json();
        if (data.ok) {
          const newId = data.id;
          // Update local state if id changed
          if (newId !== config.id) {
            st.configs[newId] = { ...config, id: newId, title: newTitle };
            st.files[newId]   = st.files[config.id] || [];
            delete st.configs[config.id];
            delete st.files[config.id];
            const seq = await (await fetch(`/api/sequence?${gq()}`)).json();
            st.sequence = seq;
            st.activeId = newId;
          } else {
            st.configs[config.id].title = newTitle;
          }
          renderSceneList();
          renderPanel();
        } else {
          showToast(`Rename failed: ${data.error || 'unknown error'}`, true);
          fieldTitle.value = config.title || '';
        }
      });
    }

    // Shared eli.riv upload
    const sharedRiveInput = document.getElementById('sharedRiveInput');
    if (sharedRiveInput) {
      sharedRiveInput.addEventListener('change', async () => {
        const file = sharedRiveInput.files[0];
        if (!file || !file.name.endsWith('.riv')) { showToast('Please select a .riv file.', true); return; }
        showToast('Uploading shared eli.riv…');
        const data = await uploadBinary('/api/shared/upload', { filename: 'eli.riv' }, file);
        if (data.ok) {
          rivBufferCache.clear();
          showToast('eli.riv uploaded to shared/');
          initRivePreview(config);
        } else {
          showToast(`Upload failed: ${data.error}`, true);
        }
      });
    }

    // Rive source toggle
    const riveUploadLabel  = document.getElementById('riveUploadLabel');
    const sharedUploadLabel = document.getElementById('sharedRiveUploadLabel');
    document.querySelectorAll('[name="riveSource"]').forEach(radio => {
      radio.addEventListener('change', () => {
        if (radio.value === 'shared') {
          config.rive = 'shared';
          if (riveUploadLabel)   riveUploadLabel.style.display   = 'none';
          if (sharedUploadLabel) sharedUploadLabel.style.display = '';
        } else {
          // Keep existing scene file if set, otherwise mark as needing upload
          if (!config.rive || config.rive === 'shared') config.rive = '';
          if (riveUploadLabel)   riveUploadLabel.style.display   = '';
          if (sharedUploadLabel) sharedUploadLabel.style.display = 'none';
        }
        st.dirty = true;
      });
    });

    // Rive file upload
    const riveFileInput = document.getElementById('riveFileInput');
    if (riveFileInput) {
      riveFileInput.addEventListener('change', async () => {
        const file = riveFileInput.files[0];
        if (!file || !file.name.endsWith('.riv')) { showToast('Please select a .riv file.', true); return; }
        showToast('Uploading…');
        const data = await uploadBinary('/api/scene/upload', { id: config.id, filename: file.name, game: st.game }, file);
        if (data.ok) {
          rivBufferCache.clear();
          config.rive = data.filename;
          st.dirty = true;
          await saveAll();
          renderPanel();
          showToast(`${data.filename} connected.`);
        } else {
          showToast(`Upload failed: ${data.error}`, true);
        }
      });
    }

    // File role selects
    document.querySelectorAll('[data-file-role]').forEach(sel => {
      sel.addEventListener('change', () => {
        const filename = sel.dataset.fileRole;
        const role     = sel.value;
        // If setting a new voice file, demote the previous one (unless segments mode)
        if (role === 'voice' && !(Array.isArray(config.segments) && config.segments.length)) {
          Object.keys(config.files || {}).forEach(f => { if (config.files[f] === 'voice') config.files[f] = 'bg'; });
        }
        config.files = config.files || {};
        if (role === 'unset') delete config.files[filename];
        else config.files[filename] = role;
        st.dirty = true;
        renderPanel();
      });
    });

    // Edit lip sync buttons
    document.querySelectorAll('[data-lipsync-load]').forEach(btn => {
      btn.addEventListener('click', () => loadVoiceFile(btn.getAttribute('data-lipsync-load'), config));
    });

    // ── Segment events ──
    // Tab clicks
    document.querySelectorAll('[data-seg-idx]').forEach(tab => {
      tab.addEventListener('click', () => {
        const idx = Number(tab.dataset.segIdx);
        if (idx === st.activeSegmentIndex) return;
        stopAudio();
        st.activeSegmentIndex = idx;
        st.activeVoiceFile = '';
        renderPanel();
      });
    });
    // Add voice segment
    document.querySelector('[data-action="add-segment"]')?.addEventListener('click', () => {
      if (!config.segments) config.segments = [];
      config.segments.push({ voice: '', trigger: 'ended' });
      st.activeSegmentIndex = config.segments.length - 1;
      st.activeVoiceFile = '';
      st.dirty = true;
      renderPanel();
    });
    // Add chat segment
    document.querySelector('[data-action="add-chat-segment"]')?.addEventListener('click', () => {
      if (!config.segments) config.segments = [];
      config.segments.push({ type: 'chat', opening: '', max_exchanges: 5, context_hint: '', trigger: 'ended' });
      st.activeSegmentIndex = config.segments.length - 1;
      st.activeVoiceFile = '';
      st.dirty = true;
      renderPanel();
    });
    // Delete segment (from tab × or config button)
    function deleteSegment(idx) {
      if (!config.segments) return;
      config.segments.splice(idx, 1);
      if (!config.segments.length) {
        delete config.segments;
        st.activeSegmentIndex = 0;
      } else {
        st.activeSegmentIndex = Math.min(st.activeSegmentIndex, config.segments.length - 1);
      }
      st.activeVoiceFile = '';
      st.dirty = true;
      renderPanel();
    }
    document.querySelector('[data-action="delete-segment"]')?.addEventListener('click', () => deleteSegment(st.activeSegmentIndex));
    document.querySelectorAll('[data-seg-delete]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSegment(Number(el.dataset.segDelete));
      });
    });
    // Enable segments
    document.querySelector('[data-action="enable-segments"]')?.addEventListener('click', () => {
      const existingVoice = Object.keys(config.files || {}).find(f => config.files[f] === 'voice');
      config.segments = [{ voice: existingVoice || '', trigger: 'ended' }];
      st.activeSegmentIndex = 0;
      st.dirty = true;
      renderPanel();
    });
    // Segment field inputs (selects, text, number)
    document.querySelectorAll('[data-seg-field]').forEach(el => {
      const evt = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(evt, function () {
        if (!config.segments?.[st.activeSegmentIndex]) return;
        const field = this.dataset.segField;
        const val   = this.type === 'checkbox' ? this.checked
                    : this.type === 'number'   ? Number(this.value)
                    : (this.value || '');
        config.segments[st.activeSegmentIndex][field] = val;
        st.dirty = true;
        if (field === 'voice') {
          // Picking a file that wasn't marked as voice yet marks it now —
          // one step instead of "set role, then pick".
          if (val) {
            config.files = config.files || {};
            if (config.files[val] !== 'voice') config.files[val] = 'voice';
          }
          st.activeVoiceFile = '';
          renderPanel();
          return;
        }
        if (field === 'trigger') {
          const tab = document.querySelector(`[data-seg-idx="${st.activeSegmentIndex}"] .segment-tab__trigger`);
          if (tab) tab.textContent = this.value;
        }
      });
    });

    // BG music multi-checklist
    document.querySelectorAll('[data-seg-bgs] .bg-check').forEach(cb => {
      cb.addEventListener('change', () => {
        if (!config.segments?.[st.activeSegmentIndex]) return;
        const checked = [...cb.closest('[data-seg-bgs]').querySelectorAll('.bg-check:checked')].map(c => c.value);
        config.segments[st.activeSegmentIndex].bgs = checked;
        delete config.segments[st.activeSegmentIndex].bg; // migrate away from old single field
        st.dirty = true;
      });
    });

    // Chat scene or chat segment: preview-only animation buttons
    const isChatPreview = config.type === 'chat' || (Array.isArray(config.segments) && config.segments[st.activeSegmentIndex]?.type === 'chat');
    const expressionPreview = document.querySelector('[data-expression-preview]');
    if (expressionPreview) {
      bindExpressionPreviewButtons(expressionPreview, (key, value) => {
        const segment = Array.isArray(config.segments) ? config.segments[st.activeSegmentIndex] : null;
        if (segment) {
          segment.pose = segment.pose || {};
          segment.pose[key] = value;
        } else {
          config.pose = config.pose || {};
          config.pose[key] = value;
        }
        st.dirty = true;
      });
    } else if (isChatPreview) {
      bindExpressionPreviewButtons(document);
    }

    // File delete
    document.querySelectorAll('[data-file-delete]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const filename = btn.dataset.fileDelete;
        if (!confirm(`Remove "${filename}"?`)) return;
        await fetch('/api/scene/delete-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: config.id, filename, game: st.game }) });
        if (config.files) delete config.files[filename];
        st.files[config.id] = (st.files[config.id] || []).filter(f => f !== filename);
        if (st.activeVoiceFile === filename) { st.activeVoiceFile = ''; stopAudio(); }
        renderPanel();
        showToast('File removed.');
      });
    });

    // Upload
    const fileUpload = document.getElementById('fileUpload');
    const uploadZone = document.getElementById('uploadZone');
    if (fileUpload) {
      fileUpload.addEventListener('change', () => handleUpload(fileUpload.files, config));
      uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('is-drag'); });
      uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('is-drag'));
      uploadZone.addEventListener('drop', e => {
        e.preventDefault();
        uploadZone.classList.remove('is-drag');
        handleUpload(e.dataTransfer.files, config);
      });
    }

    // System prompt
    const fieldPrompt = document.getElementById('fieldSystemPrompt');
    if (fieldPrompt) {
      fieldPrompt.addEventListener('input', () => { config.system_prompt = fieldPrompt.value; st.dirty = true; });
    }

    // Artboard
    const fieldArtboard = document.getElementById('fieldArtboard');
    if (fieldArtboard) {
      fieldArtboard.addEventListener('change', () => {
        config.artboard = fieldArtboard.value.trim() || undefined;
        st.dirty = true;
        initRivePreview(config);
      });
    }

    // State machines
    const fieldStateMachines = document.getElementById('fieldStateMachines');
    if (fieldStateMachines) {
      fieldStateMachines.addEventListener('change', () => {
        const names = fieldStateMachines.value.split(',').map(s => s.trim()).filter(Boolean);
        config.stateMachines = names.length ? names : undefined;
        st.dirty = true;
        initRivePreview(config);
      });
    }

    // After section
    const fieldTrigger   = document.getElementById('fieldTrigger');
    const fieldMessage   = document.getElementById('fieldMessage');
    const fieldNextScene = document.getElementById('fieldNextScene');
    if (fieldTrigger)   fieldTrigger.addEventListener('change',   () => { config.after = config.after || {}; config.after.trigger = fieldTrigger.value; st.dirty = true; });
    if (fieldMessage)   fieldMessage.addEventListener('input',    () => { config.after = config.after || {}; config.after.message = fieldMessage.value; st.dirty = true; });

    // CTA button — empty label removes it from the scene entirely
    const fieldCtaLabel = document.getElementById('fieldCtaLabel');
    const fieldCtaNext  = document.getElementById('fieldCtaNext');
    const fieldCtaHold  = document.getElementById('fieldCtaHold');
    const applyCta = () => {
      const label = (fieldCtaLabel?.value || '').trim();
      if (label) config.cta = { label, next: fieldCtaNext?.value || '', hold: !!fieldCtaHold?.checked };
      else delete config.cta;
      st.dirty = true;
    };
    if (fieldCtaLabel) fieldCtaLabel.addEventListener('input', applyCta);
    if (fieldCtaNext)  fieldCtaNext.addEventListener('change', applyCta);
    if (fieldCtaHold)  fieldCtaHold.addEventListener('change', applyCta);

    // Heart touch zone — gestures with no action are dropped; no gestures
    // removes the zone entirely.
    const hzEls = [...document.querySelectorAll('[data-hz]')];
    const applyHeartZone = () => {
      const activeSegment = Array.isArray(config.segments) ? config.segments[st.activeSegmentIndex] : null;
      const get = (path) => (hzEls.find(el => el.dataset.hz === path)?.value ?? '').trim();
      const gesture = (key) => {
        const g = { heartState: get(`${key}.heartState`), input: get(`${key}.input`), next: get(`${key}.next`) };
        if (g.heartState === '' && !g.input && !g.next) return null;
        const out = {};
        if (g.heartState !== '') out.heartState = Number(g.heartState);
        if (g.input) out.input = g.input;
        if (g.next)  out.next = g.next;
        if (key === 'hold') out.duration = Number(get('hold.duration')) || 3;
        return out;
      };
      const tap = gesture('tap'), doubleTap = gesture('doubleTap'), hold = gesture('hold');
      if (!tap && !doubleTap && !hold) {
        // null is an explicit per-segment "no heart interaction" override;
        // deleting it would unintentionally fall back to the scene's old zone.
        if (activeSegment) activeSegment.heartZone = null;
        else delete config.heartZone;
        st.dirty = true;
        return;
      }
      const heartZone = {
        x: Number(get('x')) || 50,
        y: Number(get('y')) || 62,
        size: Number(get('size')) || 24,
        ...(tap ? { tap } : {}),
        ...(doubleTap ? { doubleTap } : {}),
        ...(hold ? { hold } : {}),
      };
      if (activeSegment) activeSegment.heartZone = heartZone;
      else config.heartZone = heartZone;
      st.dirty = true;
    };
    for (const el of hzEls) {
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', applyHeartZone);
    }
    if (fieldNextScene) fieldNextScene.addEventListener('change', () => { config.after = config.after || {}; config.after.next = fieldNextScene.value || null; st.dirty = true; });
    // Lip sync controls
    bindLipSyncEvents(config);
  }

  // ─── File upload ─────────────────────────────────────────────────────────────
  // Send the file as a raw binary body (metadata in query params) — roughly a
  // third smaller and faster than the old base64-in-JSON approach.
  async function uploadBinary(endpoint, params, file) {
    const qs  = new URLSearchParams(params).toString();
    const res = await fetch(`${endpoint}?${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    return res.json();
  }

  async function handleUpload(fileList, config) {
    const statusEl = document.getElementById('uploadStatus');
    if (!fileList || !fileList.length) return;

    let lastUploaded = null;
    for (const file of fileList) {
      if (statusEl) statusEl.textContent = `Uploading ${file.name}…`;
      const data = await uploadBinary('/api/scene/upload', { id: config.id, filename: file.name, game: st.game }, file);
      if (data.ok) {
        if (!st.files[config.id]) st.files[config.id] = [];
        if (!st.files[config.id].includes(data.filename)) st.files[config.id].push(data.filename);
        st.audioFilesOpen = true;   // reveal the new file so it can get a role
        // Same as a TTS-generated line: assign a role right away so the file
        // isn't just an inert row — without this it sits with "— Role —" and
        // never gets a waveform or an Edit Lip Sync button until the user
        // manually picks a role and loads it themselves.
        if (config.type === 'video') {
          config.files = config.files || {};
          config.files[data.filename] = 'video';
          st.dirty = true;
        } else {
          assignGeneratedVoice(config, data.filename);
        }
        lastUploaded = data.filename;
        showToast(`Uploaded ${data.filename}`);
      } else {
        showToast(`Upload failed: ${data.error}`, true);
      }
    }
    if (statusEl) statusEl.textContent = '';
    renderPanel();
    if (lastUploaded && config.type !== 'video') await loadVoiceFile(lastUploaded, config);
  }

  // ─── Lip sync: audio loading ──────────────────────────────────────────────────
  async function loadVoiceFile(filename, config) {
    if (!filename) return;
    stopAudio();
    st.activeVoiceFile = filename;
    st.markers         = [];
    st.textCues        = [];
    st.markersVersion++;
    st.selectedMarkerIdx = -1;
    st.selectedTextCueIdx = -1;

    // One cache token for both requests — the <audio> element and the waveform
    // fetch share the same URL, so the second hit comes from the HTTP cache
    // instead of downloading the file twice.
    const v = Date.now();
    const audioUrl = `/games/${st.game}/scenes/${config.id}/audio/${encodeURIComponent(filename)}`;
    st.audio.src   = `${audioUrl}?v=${v}`;
    st.audio.onerror = () => {
      // Only report errors for THIS load — swapping src (stopAudio sets it to
      // '') can fire a stale error event that isn't about the current file.
      if (st.activeVoiceFile === filename && st.audio.src.includes(`v=${v}`) && st.audio.error) {
        showToast(`Could not load "${filename}" — the file may be missing or corrupted.`, true);
      }
    };
    st.audio.load();

    st.waveformPeaks = null;
    st.waveformEnv   = null;
    st._undo         = [];
    analyzeVoiceAudio(`${audioUrl}?v=${v}`, filename);   // waveform + auto-sync data

    // Load existing lipsync.json
    const baseName = filename.replace(/\.[^.]+$/, '');
    try {
      const res = await fetch(`/games/${st.game}/scenes/${config.id}/audio/${encodeURIComponent(baseName)}.lipsync.json?v=${v}`, { cache: 'no-store' });
      if (res.ok) {
        const payload = await res.json();
        st.markers = sanitizeMarkers(payload.markers);
        st.textCues = Array.isArray(payload.textCues) ? payload.textCues.filter(tc => tc && tc.text && Number.isFinite(tc.time)).sort((a, b) => a.time - b.time) : [];
        st.markersVersion++;
        showToast(`Loaded ${st.markers.length} markers, ${st.textCues.length} text cues`);
      }
    } catch {}

    // renderPanel() binds panel + lip sync events and re-inits the Rive preview
    renderPanel();
  }

  // ─── Waveform analysis ────────────────────────────────────────────────────────
  // Decode the voice file once: peak buckets for drawing + a 10ms RMS envelope
  // that auto lip-sync uses to find speech.
  async function analyzeVoiceAudio(url, filename = '') {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        if (filename) showToast(`"${filename}" is missing on disk (HTTP ${res.status}) — re-upload it or generate a new voice line.`, true);
        return;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ac = new AC();
      const audioBuf = await ac.decodeAudioData(await res.arrayBuffer());
      const data = audioBuf.getChannelData(0);

      const buckets = 1000;
      const step = Math.max(1, Math.floor(data.length / buckets));
      const peaks = [];
      for (let i = 0; i < buckets; i++) {
        let max = 0;
        for (let j = i * step, e = Math.min(j + step, data.length); j < e; j++) {
          const v = Math.abs(data[j]);
          if (v > max) max = v;
        }
        peaks.push(max);
      }

      const frameLen = Math.round(audioBuf.sampleRate * 0.01);
      const nFrames  = Math.floor(data.length / frameLen);
      const frames   = new Float32Array(nFrames);
      for (let i = 0; i < nFrames; i++) {
        let sum = 0;
        for (let j = i * frameLen, e = j + frameLen; j < e; j++) sum += data[j] * data[j];
        frames[i] = Math.sqrt(sum / frameLen);
      }

      ac.close();
      st.waveformPeaks = peaks;
      st.waveformEnv   = { frames, frameSec: 0.01 };
      drawWaveform();
    } catch {
      st.waveformPeaks = null;
      st.waveformEnv   = null;
    }
  }

  function drawWaveform() {
    const canvas = document.getElementById('waveformCanvas');
    if (!canvas || !st.waveformPeaks) return;
    const w = canvas.offsetWidth || 600, h = canvas.offsetHeight || 44;
    canvas.width  = w * devicePixelRatio;
    canvas.height = h * devicePixelRatio;
    const g = canvas.getContext('2d');
    g.scale(devicePixelRatio, devicePixelRatio);
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(83, 238, 134, 0.38)';
    const peaks = st.waveformPeaks, n = peaks.length;
    // Normalize to the loudest peak so quiet recordings still read clearly
    let maxPeak = 0;
    for (let i = 0; i < n; i++) if (peaks[i] > maxPeak) maxPeak = peaks[i];
    const scale = maxPeak > 0 ? 1 / maxPeak : 1;
    const barW = Math.max(1, w / n - 0.4);
    for (let i = 0; i < n; i++) {
      const bh = Math.max(1, peaks[i] * scale * (h - 4));
      g.fillRect((i / n) * w, (h - bh) / 2, barW, bh);
    }
  }

  // Redraw on window resize so the waveform stays crisp and aligned
  let waveformResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(waveformResizeTimer);
    waveformResizeTimer = setTimeout(drawWaveform, 150);
  });

  // ─── Undo (Cmd+Z) for markers & text cues ────────────────────────────────────
  function pushHistory() {
    st._undo.push(JSON.stringify({ m: st.markers, t: st.textCues }));
    if (st._undo.length > 50) st._undo.shift();
  }

  function undoLipSync() {
    const prev = st._undo.pop();
    if (!prev) { showToast('Nothing to undo.'); return; }
    const { m, t } = JSON.parse(prev);
    st.markers  = m;
    st.textCues = t;
    st.markersVersion++;
    st.selectedMarkerIdx = -1;
    st.selectedTextCueIdx = -1;
    st.dirty = true;
    refreshLipSyncViews();
    showToast('Undone.');
  }

  function refreshLipSyncViews() {
    const ml = document.getElementById('markerList');
    const sr = document.getElementById('scrubber');
    if (ml) renderMarkerList(ml);
    renderTextCueList();
    if (sr) renderScrubMarks(sr, isNaN(st.audio.duration) ? 0 : st.audio.duration);
  }

  // ─── Auto lip-sync ────────────────────────────────────────────────────────────
  // Amplitude-driven: opens the mouth on speech onsets, cycles visemes during
  // speech (louder → wider shapes), closes it in silences. A fast first pass —
  // fine-tune by hand afterwards.
  function generateAutoLipSync() {
    if (!st.waveformEnv) { showToast('Audio still analyzing — try again in a second.', true); return; }
    if (st.markers.length && !confirm(`Replace ${st.markers.length} existing markers with auto-generated ones?`)) return;
    pushHistory();

    const { frames, frameSec } = st.waveformEnv;
    let peak = 0;
    for (let i = 0; i < frames.length; i++) if (frames[i] > peak) peak = frames[i];
    if (peak <= 0) { showToast('No audio signal found in this file.', true); return; }

    const thr   = peak * 0.09;                  // speech onset threshold
    const wide  = [1, 8, 5];                    // A/E/I, O, EE — loud
    const mid   = [1, 3, 10, 5, 9];             // mixed consonant/vowel
    const soft  = [2, 6, 7, 11];                // B/M/P, F/V, L, TH — quiet
    const round3 = (t) => Math.round(t * 1000) / 1000;

    const markers = [];
    let inSpeech = false, lastMark = -1;
    for (let i = 0; i < frames.length; i++) {
      const t = i * frameSec, v = frames[i];
      if (!inSpeech && v >= thr) {
        inSpeech = true;
        markers.push({ time: round3(t), mouth_shape: wide[Math.floor(Math.random() * wide.length)] });
        lastMark = t;
      } else if (inSpeech && v < thr * 0.6) {
        let silent = true;                       // need ~80ms of quiet to close
        for (let j = i; j < Math.min(i + 8, frames.length); j++) {
          if (frames[j] >= thr * 0.6) { silent = false; break; }
        }
        if (silent) { inSpeech = false; markers.push({ time: round3(t), mouth_shape: 0 }); }
      } else if (inSpeech && t - lastMark >= 0.13) {
        const pool = v > peak * 0.45 ? wide : v > peak * 0.18 ? mid : soft;
        let shape = pool[Math.floor(Math.random() * pool.length)];
        if (markers.length && markers[markers.length - 1].mouth_shape === shape) {
          shape = pool[(pool.indexOf(shape) + 1) % pool.length];
        }
        markers.push({ time: round3(t), mouth_shape: shape });
        lastMark = t;
      }
    }
    if (inSpeech) markers.push({ time: round3(frames.length * frameSec), mouth_shape: 0 });

    st.markers = markers;
    st.markersVersion++;
    st.selectedMarkerIdx = -1;
    st.dirty = true;
    refreshLipSyncViews();
    showToast(`Generated ${markers.length} markers — scrub through and fine-tune, then Save.`);
  }

  // ─── Lip sync: Rive preview sync ─────────────────────────────────────────────
  function syncRiveToTime(t) {
    if (!rivePreview || !st.markers.length) return;
    let mouth = 0, emotion = -1, body = -1, head = -1, heart = -1;
    for (const m of st.markers) {
      if (m.time > t) break;
      if (Number.isFinite(m.mouth_shape))    mouth   = m.mouth_shape;
      if (Number.isFinite(m.emotion_state))  emotion = m.emotion_state;
      if (Number.isFinite(m.body_movement))  body    = m.body_movement;
      if (Number.isFinite(m.head_movement))  head    = m.head_movement;
      if (Number.isFinite(m.heart_state))    heart   = m.heart_state;
    }
    setPreviewInput('mouth_shape', mouth);
    setPreviewInput('is_speaking', mouth > 0);
    if (emotion >= 0) { setPreviewInput('emotion_state', emotion); setPreviewInput('eyes_state', emotion); }
    if (body    >= 0) { setPreviewInput('body_movement', body); setPreviewInput('nav_heart', body); }
    if (head    >= 0) { setPreviewInput('head_movement', head); setPreviewInput('head_state', head); }
    if (heart   >= 0) setPreviewInput('heart_state', heart);
  }

  // ─── Lip sync: events ────────────────────────────────────────────────────────
  function bindLipSyncEvents(config) {
    const scrubber     = document.getElementById('scrubber');
    const btnRestart   = document.getElementById('btnRestart');
    const btnPlayPause = document.getElementById('btnPlayPause');
    const chkTapMode   = document.getElementById('chkTapMode');
    const chkPauseAfter= document.getElementById('chkPauseAfter');
    const timeDisplay  = document.getElementById('timeDisplay');
    const markerList   = document.getElementById('markerList');

    if (!scrubber) return;

    // Stop any scrubber animation loop left over from a previous render
    if (st._scrubFrame) { cancelAnimationFrame(st._scrubFrame); st._scrubFrame = null; }

    // Duration can be NaN before metadata loads, or Infinity for some files —
    // fall back to the seekable range in those cases.
    const dur = () => {
      const d = st.audio.duration;
      if (Number.isFinite(d) && d > 0) return d;
      const sk = st.audio.seekable;
      return sk && sk.length ? sk.end(sk.length - 1) : 0;
    };

    const syncScrubberMax = () => {
      const d = dur();
      if (d <= 0) return;
      const max = d.toFixed(3);
      if (scrubber.max !== max) scrubber.max = max;
    };

    const refreshTransport = () => {
      syncScrubberMax();
      const d = dur(), cur = st.audio.currentTime || 0;
      if (!scrubber.dataset.dragging) scrubber.value = cur;
      if (timeDisplay) timeDisplay.textContent = `${fmtTime(cur)} / ${fmtTime(d)}`;
      renderScrubMarks(scrubber, d);
      syncRiveToTime(cur);
    };

    // Audio events. Metadata may ALREADY be loaded by the time we bind (cached
    // file, fast disk) — that race used to leave the slider stuck at max=0,
    // so refresh immediately too, and listen to every duration-related event.
    st.audio.onloadedmetadata = refreshTransport;
    st.audio.ondurationchange = refreshTransport;
    st.audio.oncanplay        = refreshTransport;
    st.audio.ontimeupdate     = refreshTransport;
    refreshTransport();

    // Smooth scrubber while playing (timeupdate alone only fires ~4×/sec)
    const scrubTick = () => {
      st._scrubFrame = null;
      if (!st.isPlaying) return;
      refreshTransport();
      st._scrubFrame = requestAnimationFrame(scrubTick);
    };

    st.audio.onended = () => {
      st.isPlaying = false;
      if (btnPlayPause) btnPlayPause.textContent = '▶';
    };
    st.audio.onplay  = () => {
      st.isPlaying = true;
      if (btnPlayPause) btnPlayPause.textContent = '⏸';
      if (!st._scrubFrame) st._scrubFrame = requestAnimationFrame(scrubTick);
    };
    st.audio.onpause = () => { st.isPlaying = false; if (btnPlayPause) btnPlayPause.textContent = '▶'; };

    // Scrubber — drag state must clear even when the pointer is released
    // outside the slider (this used to leave it stuck ignoring playback).
    const startDrag = () => { scrubber.dataset.dragging = '1'; };
    const endDrag   = () => { delete scrubber.dataset.dragging; };
    scrubber.addEventListener('pointerdown',   startDrag);
    scrubber.addEventListener('pointerup',     endDrag);
    scrubber.addEventListener('pointercancel', endDrag);
    scrubber.addEventListener('touchstart',    startDrag, { passive: true });
    scrubber.addEventListener('touchend',      endDrag);
    scrubber.addEventListener('touchcancel',   endDrag);
    scrubber.addEventListener('change',        endDrag);
    scrubber.addEventListener('input', () => {
      const t = Number(scrubber.value);
      safeSeek(t);
      if (timeDisplay) timeDisplay.textContent = `${fmtTime(t)} / ${fmtTime(dur())}`;
      renderScrubMarks(scrubber, dur());
      syncRiveToTime(t);
    });

    // Transport
    if (btnRestart)    btnRestart.onclick    = () => { safeSeek(0); scrubber.value = 0; syncRiveToTime(0); };
    if (btnPlayPause)  btnPlayPause.onclick  = () => { st.isPlaying ? st.audio.pause() : st.audio.play().catch(() => {}); };
    if (chkTapMode)    chkTapMode.onchange   = () => { st.tapMode = chkTapMode.checked; };
    if (chkPauseAfter) chkPauseAfter.onchange= () => { st.pauseAfterMark = chkPauseAfter.checked; };

    // Mouth / Emotion / Body buttons — stamp a marker at current time
    document.querySelectorAll('.mouth-btn').forEach(btn => {
      btn.onclick = () => recordMarker('mouth', Number(btn.dataset.mouth));
    });
    document.querySelectorAll('.emotion-btn').forEach(btn => {
      btn.onclick = () => recordMarker('emotion', Number(btn.dataset.emotion));
    });
    document.querySelectorAll('.body-btn').forEach(btn => {
      btn.onclick = () => recordMarker('body', Number(btn.dataset.body));
    });
    document.querySelectorAll('.head-btn').forEach(btn => {
      btn.onclick = () => recordMarker('head', Number(btn.dataset.head));
    });
    document.querySelectorAll('.heart-btn').forEach(btn => {
      btn.onclick = () => recordMarker('heart', Number(btn.dataset.heart));
    });
    document.querySelectorAll('.haptic-btn').forEach(btn => {
      btn.onclick = () => {
        const preset = HAPTIC_PRESETS[btn.dataset.haptic];
        if (!preset) return;
        if (navigator.vibrate) { try { navigator.vibrate(preset.pattern); } catch {} }
        recordMarker('haptic', preset.pattern.slice());
      };
    });

    // Text cue button
    const btnAddTextCue = document.getElementById('btnAddTextCue');
    const textCueInput  = document.getElementById('textCueInput');
    const textCueDuration = document.getElementById('textCueDuration');
    if (btnAddTextCue) {
      btnAddTextCue.onclick = () => {
        const text = textCueInput?.value.trim();
        if (!text) { textCueInput?.focus(); return; }
        const raw  = scrubber ? Number(scrubber.value) : st.audio.currentTime;
        addTextCueAt(Math.max(0, Math.round((isNaN(raw) ? 0 : raw) * 1000) / 1000), text);
        textCueInput.value = '';
      };
    }

    const btnAutoSync = document.getElementById('btnAutoSync');
    if (btnAutoSync) btnAutoSync.onclick = () => generateAutoLipSync();
    drawWaveform();

    renderTextCueList();
    renderMarkerList(markerList);

    // Keyboard — remove then re-add to prevent duplicates across re-renders
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup',   onKeyUp);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup',   onKeyUp);

    renderScrubMarks(scrubber, dur());

    // Click on scrub marks area to jump to position
    const scrubMarks = document.getElementById('scrubMarks');
    if (scrubMarks) {
      scrubMarks.addEventListener('click', (e) => {
        if (e.target.classList.contains('scrub-mark')) return;
        const rect = scrubMarks.getBoundingClientRect();
        const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const t    = pct * dur();
        scrubber.value = t;
        safeSeek(t);
        if (timeDisplay) timeDisplay.textContent = `${fmtTime(t)} / ${fmtTime(dur())}`;
        renderScrubMarks(scrubber, dur());
        syncRiveToTime(t);
      });

      // Double-click the caption lane to drop a caption right at that spot.
      // Uses whatever is typed in the caption box, or asks for the text.
      scrubMarks.addEventListener('dblclick', (e) => {
        if (e.target.closest('.scrub-mark')) return;
        const rect = scrubMarks.getBoundingClientRect();
        if (e.clientY - rect.top > 20) return;               // captions live in the top lane
        const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const time = Math.round(pct * dur() * 1000) / 1000;
        const typed = document.getElementById('textCueInput')?.value.trim();
        const text  = typed || prompt('Caption text:');
        if (!text || !text.trim()) return;
        addTextCueAt(time, text.trim());
        const inp = document.getElementById('textCueInput');
        if (inp) inp.value = '';
        safeSeek(time);
      });
    }
  }

  function onKeyDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undoLipSync();
      return;
    }

    // Space: hold to play, release to pause
    if (e.key === ' ' && !e.repeat) {
      e.preventDefault();
      if (!st.isPlaying) st.audio.play().catch(() => {});
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      pushHistory();
      if (st.selectedMarkerIdx >= 0) {
        st.markers.splice(st.selectedMarkerIdx, 1);
        st.selectedMarkerIdx = -1;
      } else if (st.markers.length) {
        st.markers.pop();
      }
      st.markersVersion++;
      st.dirty = true;
      const ml = document.getElementById('markerList');
      const sr = document.getElementById('scrubber');
      if (ml) renderMarkerList(ml);
      if (sr) renderScrubMarks(sr, isNaN(st.audio.duration) ? 0 : st.audio.duration);
    }
  }

  function onKeyUp(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === ' ') {
      e.preventDefault();
      if (st.isPlaying) st.audio.pause();
    }
  }

  function recordMarker(type, value) {
    if (!st.activeVoiceFile) return;
    pushHistory();
    const scrubber = document.getElementById('scrubber');
    const raw = scrubber ? Number(scrubber.value) : st.audio.currentTime;
    const time = Math.max(0, Math.round((isNaN(raw) ? 0 : raw) * 1000) / 1000);

    // Upsert: if a marker exists within 50ms, update it, else insert
    const near = st.markers.findIndex(m => Math.abs(m.time - time) < 0.05);
    const marker = near >= 0 ? st.markers[near] : { time };
    if (type === 'mouth')   { marker.mouth_shape   = value; setPreviewInput('mouth_shape', value); setPreviewInput('is_speaking', value > 0); }
    if (type === 'emotion') { marker.emotion_state = value; setPreviewInput('emotion_state', value); setPreviewInput('eyes_state', value); }
    if (type === 'body')    { marker.body_movement = value; setPreviewInput('body_movement', value); setPreviewInput('nav_heart', value); }
    if (type === 'head')    { marker.head_movement = value; setPreviewInput('head_movement', value); setPreviewInput('head_state', value); }
    if (type === 'heart')   { marker.heart_state = value; setPreviewInput('heart_state', value); }
    if (type === 'haptic')  marker.haptic = value;
    if (near < 0) {
      st.markers.push(marker);
      st.markers.sort((a, b) => a.time - b.time);
    }

    st.markersVersion++;
    st.dirty = true;

    if (st.pauseAfterMark) st.audio.pause();

    const ml = document.getElementById('markerList');
    const sr = document.getElementById('scrubber');
    if (ml) renderMarkerList(ml);
    if (sr) renderScrubMarks(sr, isNaN(st.audio.duration) ? 0 : st.audio.duration);
  }

  let scrubMarksRenderKey = '';

  function renderScrubMarks(scrubber, dur) {
    const marks = document.getElementById('scrubMarks');
    const timeDisplay = document.getElementById('timeDisplay');
    if (!marks || !dur) return;
    // Skip the rebuild if nothing changed — this runs on every audio timeupdate
    const key = `${st.markersVersion}|${st.markers.length}|${st.textCues.length}|${st.selectedMarkerIdx}|${st.selectedTextCueIdx}|${dur}`;
    if (key === scrubMarksRenderKey && marks.childElementCount) return;
    scrubMarksRenderKey = key;
    marks.innerHTML = `
      <div class="lane lane--captions">${st.textCues.length ? '' : '<span class="lane__hint">CAPTIONS · double-click here to add one at that spot</span>'}</div>`
    + st.markers.map((m, i) => {
      const pct = (m.time / dur) * 100;
      const cls = 'scrub-mark'
        + (i === st.selectedMarkerIdx ? ' is-selected' : '')
        + (Array.isArray(m.haptic) ? ' scrub-mark--haptic' : '');
      const tip = `${markerLabel(m)} — drag to move · double-click to delete`;
      return `<span class="${cls}" style="left:${pct}%" title="${esc(tip)}" data-midx="${i}"></span>`;
    }).join('') + st.textCues.map((tc, i) => {
      const pct = (tc.time / dur) * 100;
      const endPct = Math.min(100, ((tc.time + tc.duration) / dur) * 100);
      const sel = i === st.selectedTextCueIdx ? ' is-selected' : '';
      return `<span class="scrub-mark scrub-mark--text${sel}" style="left:${pct}%;width:${endPct - pct}%" title="${esc(tc.text)} — drag to move · edges to resize · double-click to edit" data-tcidx="${i}"><i class="tc-handle tc-handle--l"></i><span class="tc-text">${esc(tc.text)}</span><button class="tc-del" title="Delete caption">×</button><i class="tc-handle tc-handle--r"></i></span>`;
    }).join('');

    let dragJustHappened = false;

    marks.querySelectorAll('.scrub-mark').forEach(el => {
      const isText = 'tcidx' in el.dataset;
      const idx    = Number(isText ? el.dataset.tcidx : el.dataset.midx);
      const item   = isText ? st.textCues[idx] : st.markers[idx];
      if (!item) return;

      // Caption ✕ chip deletes
      el.querySelector('.tc-del')?.addEventListener('click', (e) => {
        e.stopPropagation();
        pushHistory();
        st.textCues.splice(idx, 1);
        st.selectedTextCueIdx = -1;
        st.markersVersion++;
        st.dirty = true;
        refreshLipSyncViews();
        showToast('Caption deleted — ⌘Z to undo.');
      });

      // Click: select + jump
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (dragJustHappened) { dragJustHappened = false; return; }
        if (isText) {
          st.selectedTextCueIdx = st.selectedTextCueIdx === idx ? -1 : idx;
          safeSeek(item.time);
          renderScrubMarks(scrubber, dur);
          renderTextCueList();
          return;
        }
        st.selectedMarkerIdx = st.selectedMarkerIdx === idx ? -1 : idx;
        if (st.selectedMarkerIdx >= 0) safeSeek(item.time);
        renderScrubMarks(scrubber, dur);
        const ml = document.getElementById('markerList');
        if (ml) renderMarkerList(ml);
      });

      // Double-click: edit caption text; delete animation keys
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (isText) {
          const next = prompt('Edit caption:', item.text);
          if (next === null || !next.trim() || next.trim() === item.text) return;
          pushHistory();
          item.text = next.trim();
          st.markersVersion++;
          st.dirty = true;
          refreshLipSyncViews();
          return;
        }
        pushHistory();
        st.markers.splice(idx, 1);
        if (st.selectedMarkerIdx === idx) st.selectedMarkerIdx = -1;
        st.markersVersion++;
        st.dirty = true;
        refreshLipSyncViews();
        showToast('Key deleted — ⌘Z to undo.');
      });

      // Drag to move; drag a text cue's edges to resize its duration
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.target.classList && e.target.classList.contains('tc-del')) return;   // let the ✕ click through
        e.preventDefault();
        e.stopPropagation();
        const mode = isText && e.target.classList && e.target.classList.contains('tc-handle')
          ? (e.target.classList.contains('tc-handle--l') ? 'resize-l' : 'resize-r')
          : 'move';
        const rect = marks.getBoundingClientRect();
        const startX = e.clientX;
        const origEnd = isText ? item.time + (Number(item.duration) || 3) : 0;
        let historyPushed = false;
        let moved = false;

        const applyStyle = () => {
          const leftPct = (item.time / dur) * 100;
          el.style.left = `${leftPct}%`;
          if (isText) {
            const endPct = Math.min(100, ((item.time + (Number(item.duration) || 3)) / dur) * 100);
            el.style.width = `${Math.max(0.4, endPct - leftPct)}%`;
            el.title = `${item.text} · ${fmtTime(item.time)} → ${fmtTime(item.time + (Number(item.duration) || 3))} (${(Number(item.duration) || 3).toFixed(1)}s)`;
          } else {
            el.title = fmtTime(item.time);
          }
        };

        const onMove = (ev) => {
          if (!moved && Math.abs(ev.clientX - startX) < 3) return;   // click tolerance
          moved = true;
          if (!historyPushed) { pushHistory(); historyPushed = true; }
          const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
          const t = Math.round(pct * dur * 1000) / 1000;
          if (mode === 'resize-r') {
            item.duration = Math.max(0.3, Math.round((t - item.time) * 10) / 10);
          } else if (mode === 'resize-l') {
            item.time     = Math.max(0, Math.min(t, origEnd - 0.3));
            item.duration = Math.round((origEnd - item.time) * 10) / 10;
          } else {
            item.time = t;
          }
          applyStyle();
          if (timeDisplay) timeDisplay.textContent = `${fmtTime(item.time)} / ${fmtTime(dur)}`;
        };
        const onUp = () => {
          el.removeEventListener('pointermove', onMove);
          try { el.releasePointerCapture(e.pointerId); } catch {}
          if (!moved) return;
          dragJustHappened = true;
          if (isText) st.textCues.sort((a, b) => a.time - b.time);
          else st.markers.sort((a, b) => a.time - b.time);
          st.selectedMarkerIdx = -1;
          st.markersVersion++;
          st.dirty = true;
          safeSeek(item.time);          // preview the new position
          syncRiveToTime(item.time);
          refreshLipSyncViews();
        };
        try { el.setPointerCapture(e.pointerId); } catch {}
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp, { once: true });
        el.addEventListener('pointercancel', onUp, { once: true });
      });
    });
  }

  function renderMarkerList(container) {
    if (!container) return;
    container.innerHTML = st.markers.map((m, i) => `
      <div class="marker-row ${i === st.selectedMarkerIdx ? 'is-selected' : ''}" data-midx="${i}">
        <span class="marker-row__time">${fmtTime(m.time)}</span>
        <span class="marker-row__label">${markerLabelHtml(m)}</span>
        <button class="marker-row__delete btn--icon" data-del-marker="${i}">×</button>
      </div>
    `).join('');

    container.querySelectorAll('[data-del-marker]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.dataset.delMarker);
        pushHistory();
        st.markers.splice(idx, 1);
        st.markersVersion++;
        st.dirty = true;
        if (st.selectedMarkerIdx === idx) st.selectedMarkerIdx = -1;
        renderMarkerList(container);
        const sr = document.getElementById('scrubber');
        if (sr) renderScrubMarks(sr, isNaN(st.audio.duration) ? 0 : st.audio.duration);
      });
    });

    container.querySelectorAll('.marker-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        const idx = Number(row.dataset.midx);
        st.selectedMarkerIdx = st.selectedMarkerIdx === idx ? -1 : idx;
        if (st.selectedMarkerIdx >= 0) safeSeek(st.markers[idx].time);
        renderMarkerList(container);
        const sr = document.getElementById('scrubber');
        if (sr) renderScrubMarks(sr, isNaN(st.audio.duration) ? 0 : st.audio.duration);
      });
    });
  }

  function markerParts(m) {
    const parts = [];
    if (Number.isFinite(m.mouth_shape))   parts.push({ track: 'mouth',   label: MOUTH_LABELS[m.mouth_shape]     || String(m.mouth_shape) });
    if (Number.isFinite(m.emotion_state)) parts.push({ track: 'emotion', tag: 'eyes', label: EMOTION_LABELS[m.emotion_state] || String(m.emotion_state) });
    if (Number.isFinite(m.body_movement)) parts.push({ track: 'body',    label: BODY_LABELS[m.body_movement]    || String(m.body_movement) });
    if (Number.isFinite(m.head_movement)) parts.push({ track: 'head',    label: HEAD_LABELS[m.head_movement]    || String(m.head_movement) });
    if (Number.isFinite(m.heart_state))   parts.push({ track: 'heart',   label: HEART_LABELS[m.heart_state]     || String(m.heart_state) });
    if (Array.isArray(m.haptic)) {
      const key = Object.keys(HAPTIC_PRESETS).find(k => HAPTIC_PRESETS[k].pattern.join() === m.haptic.join());
      parts.push({ track: 'haptic', label: key ? HAPTIC_PRESETS[key].label : 'custom' });
    }
    return parts;
  }

  function markerLabel(m) {
    return markerParts(m).map(p => `${p.tag || p.track} · ${p.label}`).join('  |  ');
  }

  function markerLabelHtml(m) {
    return markerParts(m).map(p =>
      `<span class="track-tag track-tag--${p.track}">${p.tag || p.track}</span>${esc(p.label)}`
    ).join(' &nbsp; ');
  }

  function addTextCueAt(time, text) {
    const g = (id) => document.getElementById(id);
    pushHistory();
    st.textCues.push({
      time,
      text,
      duration:   Number(g('textCueDuration')?.value) || 3,
      fontSize:   Number(g('textCueSize')?.value) || 24,
      color:      g('textCueColor')?.value || '#C1A376',
      position:   g('textCuePosition')?.value || 'bottom',
      fontWeight: g('textCueWeight')?.value || '700',
      speed:      Number(g('textCueSpeed')?.value) || 90,
      lipSync:    g('textCueLipSync')?.checked !== false,
    });
    st.textCues.sort((a, b) => a.time - b.time);
    st.markersVersion++;
    st.dirty = true;
    refreshLipSyncViews();
  }

  function renderTextCueList() {
    const container = document.getElementById('textCueList');
    if (!container) return;
    if (!st.textCues.length) { container.innerHTML = ''; return; }
    container.innerHTML = '<div class="text-cue-list__header">TEXT CUES</div>' + st.textCues.map((tc, i) => `
      <div class="marker-row marker-row--text ${i === st.selectedTextCueIdx ? 'is-selected' : ''}" data-tcidx="${i}">
        <span class="marker-row__time">${fmtTime(tc.time)}</span>
        <span class="marker-row__label marker-row__label--text" style="color:${esc(tc.color || '#C1A376')};font-size:${Math.min(tc.fontSize || 13, 16)}px;font-weight:${tc.fontWeight || 400}">${esc(tc.text)}</span>
        <span class="marker-row__dur">${tc.duration}s</span>
        <span class="marker-row__style-hint">${tc.fontSize || 24}px ${tc.position || 'bottom'} ${tc.speed || 90}ms ${tc.lipSync !== false ? '👄' : ''}</span>
        <button class="marker-row__delete btn--icon" data-del-tc="${i}">×</button>
      </div>
    `).join('');

    container.querySelectorAll('[data-del-tc]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pushHistory();
        st.textCues.splice(Number(btn.dataset.delTc), 1);
        st.dirty = true;
        renderTextCueList();
        const sr = document.getElementById('scrubber');
        if (sr) renderScrubMarks(sr, isNaN(st.audio.duration) ? 0 : st.audio.duration);
      });
    });

    container.querySelectorAll('.marker-row--text').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        const idx = Number(row.dataset.tcidx);
        st.selectedTextCueIdx = st.selectedTextCueIdx === idx ? -1 : idx;
        if (st.selectedTextCueIdx >= 0) safeSeek(st.textCues[idx].time);
        renderTextCueList();
      });
    });
  }

  function sanitizeMarkers(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(m => m && Number.isFinite(m.time) && m.time >= 0 &&
      (Number.isFinite(m.mouth_shape) || Number.isFinite(m.emotion_state) || Number.isFinite(m.body_movement) || Number.isFinite(m.head_movement) || Number.isFinite(m.heart_state) || Array.isArray(m.haptic))
    ).sort((a, b) => a.time - b.time);
  }

  // Seeking before metadata is ready throws in some browsers — never let that
  // break a click handler.
  function safeSeek(t) {
    try { st.audio.currentTime = Math.max(0, Number(t) || 0); } catch {}
  }

  function stopAudio() {
    if (st.audio) { st.audio.pause(); st.audio.src = ''; }
    st.isPlaying = false;
  }

  // ─── Save ────────────────────────────────────────────────────────────────────
  let saveInFlight = null;

  async function saveAll() {
    const config = st.configs[st.activeId];
    if (!config) return;
    if (saveInFlight) return saveInFlight;   // collapse rapid ⌘S presses into one save

    saveInFlight = (async () => {
      try {
        config.ctaRoutes = sanitizeCtaRoutes(config.ctaRoutes);

        const res = await fetch('/api/scene', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...config, game: st.game }),
        });
        if (!res.ok) throw new Error(`scene HTTP ${res.status}`);

        if (st.activeVoiceFile) {
          const res2 = await fetch('/api/lipsync/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: config.id, filename: st.activeVoiceFile, markers: st.markers, textCues: st.textCues, game: st.game }),
          });
          if (!res2.ok) throw new Error(`lip sync HTTP ${res2.status}`);
        }

        st.dirty = false;
        showToast('Saved.');
      } catch (err) {
        // Never claim success on a failed save — the work is still held in the
        // editor, so the user can retry once the server is back.
        showToast(`Save failed (${err.message}) — your work is still here, try again.`, true);
        throw err;
      } finally {
        saveInFlight = null;
      }
    })();
    return saveInFlight;
  }

  function sanitizeCtaRoutes(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map(route => ({
        name: String(route?.name || '').trim(),
        next: String(route?.next || '').trim() || null,
      }))
      .filter(route => route.name && route.next);
  }

  // ─── Test ────────────────────────────────────────────────────────────────────
  function updateMobileButtons() {
    const btn = document.getElementById('btnTestSceneMobile');
    const btnAll = document.getElementById('btnTestAllMobile');
    if (btn)    btn.style.display    = st.lanBase ? '' : 'none';
    if (btnAll) btnAll.style.display = st.lanBase ? '' : 'none';
  }

  // On mobile tests, surface the URL the phone needs (and copy it) — the tab
  // that opens on the desktop uses the same LAN address, so if that tab loads,
  // any phone on the same WiFi can load it too.
  function announceMobileUrl(url) {
    const shortUrl = url.replace(/[?&]v=\d+$/, '');
    try { navigator.clipboard?.writeText(shortUrl).catch(() => {}); } catch {}
    showToast(`Phone URL (copied): ${shortUrl} — open it on a phone on the same WiFi.`, false, 10000);
  }

  async function testThisScene(mobile = false) {
    const id = st.activeId;
    if (!id) return;
    const win = window.open('about:blank', '_blank');
    if (st.dirty) await saveAll();
    const base = mobile && st.lanBase ? st.lanBase : '.';
    const extra = mobile ? '&shell=0' : '';
    const url = `${base}/index.html?scene=${encodeURIComponent(id)}&${gq()}&preview=1${extra}&v=${Date.now()}`;
    if (win) win.location.href = url;
    else window.open(url, '_blank');
    if (mobile && st.lanBase) announceMobileUrl(url);
  }

  async function testAll(mobile = false) {
    const win = window.open('about:blank', '_blank');
    if (st.dirty) await saveAll();
    const base = mobile && st.lanBase ? st.lanBase : '.';
    const extra = mobile ? '&shell=0' : '';
    const url = `${base}/index.html?${gq()}&preview=1${extra}&v=${Date.now()}`;
    if (win) win.location.href = url;
    else window.open(url, '_blank');
    if (mobile && st.lanBase) announceMobileUrl(url);
  }

  // ─── Publish ─────────────────────────────────────────────────────────────────
  async function publish() {
    if (st.publishing) return;
    st.publishing = true;
    const publishButtons = [btnPublish, btnPublishFooter].filter(Boolean);
    const labels = publishButtons.map(btn => btn.textContent);
    publishButtons.forEach(btn => {
      btn.disabled = true;
      btn.textContent = 'Publishing...';
    });
    try {
      if (st.dirty) await saveAll();
      showToast('Publishing...');
      const res  = await fetch('/api/publish', { method: 'POST' });
      // A dead server can answer with non-JSON — never let that mask the error
      const data = await res.json().catch(() => ({ ok: false, error: `server error (HTTP ${res.status})` }));
      if (data.ok) {
        const msg = data.pushed
          ? `Published — pushed "${data.branch || 'main'}" and started the EasyPanel deploy.`
          : 'EasyPanel deploy started. ⚠ This folder is not a Git checkout, so the deploy rebuilds the last version pushed to Git — changes made only here won\'t appear online.';
        showToast(msg, false, data.pushed ? 5500 : 10000);
      } else {
        showToast(`Publish failed: ${data.error || 'unknown error'}`, true, 10000);
      }
    } catch (err) {
      showToast(`Publish error: ${err.message}`, true, 6500);
    } finally {
      publishButtons.forEach((btn, idx) => {
        btn.disabled = false;
        btn.textContent = labels[idx] || 'Publish';
      });
      st.publishing = false;
    }
  }

  // ─── Claude AI status ────────────────────────────────────────────────────────
  async function checkAIStatus() {
    try {
      const res  = await fetch('/api/chat-status');
      const data = await res.json();
      btnOpenAIStatus.style.color = data.ok ? '#53ee86' : '#ff6b6b';
      btnOpenAIStatus.title = data.ok ? `Claude ready (${data.model})` : 'Claude not configured — add ANTHROPIC_API_KEY to .env';
    } catch {}
  }

  // ─── Toast ───────────────────────────────────────────────────────────────────
  let toastTimer = null;
  function showToast(msg, isError = false, duration = 3000) {
    toast.textContent = msg;
    toast.className   = `toast is-visible${isError ? ' is-error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), duration);
  }

  // ─── Riv name detection ──────────────────────────────────────────────────────
  // Given the names array returned by the server's binary parser, pick the most
  // likely artboard and state machine name and apply them to the scene config.
  // ─── Utils ───────────────────────────────────────────────────────────────────
  function fmtTime(s) {
    if (!s || isNaN(s)) return '0:00.0';
    const m = Math.floor(s / 60);
    const sec = (s % 60).toFixed(1).padStart(4, '0');
    return `${m}:${sec}`;
  }

  function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

}());
