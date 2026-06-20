(function () {
  'use strict';

  // ─── Rive preview ───────────────────────────────────────────────────────────
  let rivePreview  = null;
  let riveInputMap = new Map();
  let previewNavPollFrame = null;

  function getRiveSrc(config) {
    if (!config || !config.rive) return null;
    if (config.rive === 'shared') return '/public/rive/eli.riv';
    return `/scenes/${config.id}/${config.rive}`;
  }

  function initRivePreview(config) {
    const canvas = document.getElementById('previewCanvas');
    if (!canvas) return;
    const src = getRiveSrc(config);
    if (!src) return;
    const hint = document.getElementById('previewHint');
    if (hint) hint.textContent = 'Loading…';

    if (rivePreview) { try { rivePreview.cleanup(); } catch {} rivePreview = null; }
    if (previewNavPollFrame) { cancelAnimationFrame(previewNavPollFrame); previewNavPollFrame = null; }
    riveInputMap = new Map();

    const smNames = Array.isArray(config && config.stateMachines) && config.stateMachines.length
      ? config.stateMachines
      : ['EliState', 'EliBody', 'FacialState', 'EmotionState'];

    if (typeof rive === 'undefined' || !rive.Rive) {
      if (hint) hint.textContent = 'Error: Rive script did not load. Check your network connection.';
      return;
    }

    // Set canvas dimensions before init so Rive has a real surface
    canvas.width  = (canvas.offsetWidth  || 300) * devicePixelRatio;
    canvas.height = (canvas.offsetHeight || 300) * devicePixelRatio;

    const artboard = (config && config.artboard) || undefined;
    try {
      rivePreview = new rive.Rive({
        src,
        canvas,
        ...(artboard ? { artboard } : {}),
        autoplay: true,
        fit: rive.Fit.Contain,
        alignment: rive.Alignment.Center,
        useOffscreenRenderer: true,
        stateMachines: smNames,
        onLoad: () => {
          for (const sm of smNames) {
            try {
              for (const input of (rivePreview.stateMachineInputs(sm) || [])) {
                riveInputMap.set(input.name, input);
              }
            } catch {}
          }
          canvas.width  = (canvas.offsetWidth  || 300) * devicePixelRatio;
          canvas.height = (canvas.offsetHeight || 300) * devicePixelRatio;
          rivePreview.resizeToCanvas();
          if (hint) hint.textContent = '';
          populateTriggerSelect(config);
          populateConnectionsSection(config);
          setupPreviewCtaRouting(config, canvas);
        },
        onLoadError: (err) => {
          const h = document.getElementById('previewHint');
          if (h) h.textContent = `Rive error: ${err?.message || err?.type || JSON.stringify(err) || 'check browser console'}`;
        },
      });
    } catch (err) {
      if (hint) hint.textContent = `Rive init failed: ${err?.message || err}`;
    }
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
    return sanitizeCtaRoutes(config && config.ctaRoutes);
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
    sequence:      { version: '1', title: "Eli's Last Experiment", start: null, scenes: [] },
    configs:       {},       // { sceneId: scene.json }
    files:         {},       // { sceneId: [filenames] }
    activeId:      null,

    // Lip sync
    audio:               new Audio(),
    markers:             [],
    markersVersion:      0,
    activeVoiceFile:     '',
    sceneFiles:          [],
    isPlaying:           false,
    tapMode:             false,
    tapWords:            [],
    wordIndex:           0,
    selectedMarkerIdx:   -1,
    pauseAfterMark:      false,
    activeSegmentIndex:  0,
    dirty:               false,
  };

  const MOUTH_LABELS = ['Idle','A E I','B M P','C D G K','CH SH J','EE','F V','L','O','Q W','R','TH','U','Smile','Sad','Angry','Laugh','Surprised','Confused'];
  const EMOTION_LABELS = ['Neutral','Sad','Happy','Angry','Surprised'];
  const BODY_LABELS = ['Idle','Heart Glow','Heart Pain','Breathe','Shiver','Reach','Curl','Float','Shake','Lean In','Lean Back','Twitch','Pulse','Sway','Collapse','Rise','Tremble'];
  const TRIGGER_OPTIONS = { rive: ['never','tap_heart','auto'], video: ['ended'], chat: ['never'] };

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

  let selectedModalType = 'rive';

  // ─── Boot ───────────────────────────────────────────────────────────────────
  window.addEventListener('load', async () => {
    await loadSequence();
    wireButtons();
    checkAIStatus();
  });

  async function loadSequence() {
    try {
      const res = await fetch(`/api/sequence?v=${Date.now()}`);
      st.sequence = res.ok ? await res.json() : st.sequence;
    } catch {}
    renderSceneList();
    if (st.sequence.scenes.length) selectScene(st.sequence.scenes[0]);
  }

  // ─── Wire buttons ────────────────────────────────────────────────────────────
  function wireButtons() {
    btnAddScene.onclick     = () => openAddSceneModal();
    btnAddSceneCancel.onclick = () => closeAddSceneModal();
    btnAddSceneCreate.onclick = () => createScene();

    btnSave.onclick         = () => saveAll();
    btnTestScene.onclick    = () => testThisScene();
    btnTestAll.onclick      = () => testAll();
    btnPublish.onclick      = () => publish();
    btnPublishFooter.onclick= () => publish();

    btnOpenAIStatus.onclick = () => checkAIStatus();

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
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveAll(); }
      if (e.key === 'Escape') closeAddSceneModal();
    });
  }

  // ─── Scene list ──────────────────────────────────────────────────────────────
  function renderSceneList() {
    sceneList.innerHTML = '';
    const scenes = st.sequence.scenes || [];
    scenes.forEach((id, idx) => {
      const config = st.configs[id];
      const title  = config ? config.title : id;
      const type   = config ? config.type  : '?';

      const li = document.createElement('li');
      li.className = `scene-item${id === st.activeId ? ' is-active' : ''}`;
      li.innerHTML = `
        <span class="scene-item__order">${idx + 1}</span>
        <span class="scene-item__title">${esc(title)}</span>
        <span class="scene-item__badge scene-item__badge--${type}">${type}</span>
        <div class="scene-item__controls">
          ${idx > 0 ? '<button class="scene-ctrl" data-action="up" title="Move up">↑</button>' : ''}
          ${idx < scenes.length - 1 ? '<button class="scene-ctrl" data-action="down" title="Move down">↓</button>' : ''}
          <button class="scene-ctrl scene-ctrl--delete" data-action="delete" title="Delete scene">×</button>
        </div>
      `;
      li.addEventListener('click', (e) => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (action === 'up')     moveScene(id, -1);
        else if (action === 'down')   moveScene(id, 1);
        else if (action === 'delete') deleteScene(id);
        else selectScene(id);
      });
      sceneList.appendChild(li);
    });
  }

  async function selectScene(id) {
    st.activeId = id;
    renderSceneList();

    // Load config if not cached
    if (!st.configs[id]) {
      try {
        const res = await fetch(`/api/scene?id=${encodeURIComponent(id)}`);
        if (res.ok) st.configs[id] = await res.json();
        else st.configs[id] = { id, title: id, type: 'rive', files: {}, after: { trigger: 'tap_heart', message: '', next: null } };
      } catch { return; }
    }

    // Load file list
    await loadSceneFiles(id);

    // Re-render scene list now that config is loaded (fixes "?" badge)
    renderSceneList();
    renderPanel();
  }

  async function loadSceneFiles(id) {
    try {
      const res = await fetch(`/api/scene/files?id=${encodeURIComponent(id)}`);
      st.files[id] = res.ok ? (await res.json()).files || [] : [];
    } catch { st.files[id] = []; }
  }

  function moveScene(id, dir) {
    const arr = st.sequence.scenes;
    const i   = arr.indexOf(id);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    fetch('/api/scenes/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenes: arr }) });
    renderSceneList();
  }

  async function deleteScene(id) {
    if (!confirm(`Delete scene "${st.configs[id]?.title || id}"? This cannot be undone.`)) return;
    await fetch('/api/scenes/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
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
      body: JSON.stringify({ title, type: selectedModalType }),
    });
    const data = await res.json();
    if (!data.ok) { showToast('Could not create scene.', true); return; }

    st.configs[data.id]  = data.config;
    st.files[data.id]    = [];
    const seq = await (await fetch('/api/sequence')).json();
    st.sequence = seq;
    renderSceneList();
    selectScene(data.id);
    showToast(`Scene "${title}" created.`);
  }

  // ─── Panel renderer ──────────────────────────────────────────────────────────
  function showEmpty() {
    editorEmpty.hidden = false;
    editorPanel.hidden = true;
  }

  function renderPanel() {
    const config = st.configs[st.activeId];
    if (!config) { showEmpty(); return; }

    editorEmpty.hidden = true;
    editorPanel.hidden = false;

    const type = config.type || 'rive';

    editorPanel.innerHTML = `
      <div class="panel-section panel-section--meta">
        <div class="field-row">
          <label class="field-label">Title</label>
          <input class="field-input" id="fieldTitle" type="text" value="${esc(config.title || '')}" maxlength="64" />
        </div>
        <div class="field-row">
          <label class="field-label">Type</label>
          <span class="type-badge type-badge--${type}">${type}</span>
        </div>
        ${type !== 'video' ? `
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
          <label class="field-label" for="fieldStateMachines">State machines</label>
          <input class="field-input field-input--sm" id="fieldStateMachines" type="text"
            placeholder="e.g. FacialState, EliBody"
            value="${esc((config.stateMachines || []).join(', '))}" />
        </div>
        ` : ''}
      </div>

      ${type === 'rive' ? `
        <div class="preview-lipsync-split">
          <div class="preview-lipsync-split__preview">
            ${renderPreviewSection(config)}
            ${renderConnectionsSection(config)}
          </div>
          <div class="preview-lipsync-split__editor">
            ${renderFilesSection(config)}
            ${renderLipSyncSection(config)}
          </div>
        </div>
      ` : `
        ${type === 'chat' ? renderPreviewSection(config) : ''}
        ${renderFilesSection(config)}
        ${type === 'chat' ? renderChatSection(config) : ''}
      `}
      ${renderAfterSection(config)}
    `;

    bindPanelEvents(config);
    if (type === 'rive' || type === 'chat') initRivePreview(config);
  }

  // ─── Scene connections section ────────────────────────────────────────────────
  function renderConnectionsSection(config) {
    return `
      <div class="panel-section panel-section--connections">
        <div class="panel-section__header">SCENE CONNECTIONS
          <span class="connections-hint-inline" id="connectionsHint">waiting for preview…</span>
        </div>
        <div class="connections-list" id="connectionsList"></div>
      </div>
    `;
  }

  function populateConnectionsSection(config) {
    const hint = document.getElementById('connectionsHint');
    const list = document.getElementById('connectionsList');
    if (!list) return;

    const navInputs = [];
    for (const [name] of riveInputMap) {
      if (name.startsWith('nav_')) navInputs.push(name);
    }

    if (!navInputs.length) {
      if (hint) hint.textContent = 'no nav_* inputs found — name inputs nav_<scene_id> in Rive';
      list.innerHTML = '';
      return;
    }

    if (hint) hint.textContent = '';

    const scenes = st.sequence.scenes || [];
    const routes = config.routes || {};

    list.innerHTML = navInputs.map(name => {
      const dest   = routes[name] || '';
      const autoId = name.slice(4);
      const autoFill = !dest && scenes.includes(autoId) ? autoId : '';
      const active = dest || autoFill;
      return `
        <div class="connection-row">
          <span class="connection-input">${esc(name)}</span>
          <span class="connection-arrow">→</span>
          <select class="connection-scene field-select" data-conn-input="${esc(name)}">
            <option value="">— no action —</option>
            ${scenes.filter(s => s !== config.id).map(s => {
              const t = st.configs[s]?.title || s;
              return `<option value="${esc(s)}" ${active === s ? 'selected' : ''}>${esc(t)}</option>`;
            }).join('')}
          </select>
          <span class="connection-dot ${active ? 'is-wired' : ''}">●</span>
        </div>
      `;
    }).join('');

    list.querySelectorAll('.connection-scene').forEach(sel => {
      sel.addEventListener('change', () => {
        if (!config.routes) config.routes = {};
        const inputName = sel.dataset.connInput;
        if (sel.value) config.routes[inputName] = sel.value;
        else delete config.routes[inputName];
        const dot = sel.closest('.connection-row')?.querySelector('.connection-dot');
        if (dot) dot.classList.toggle('is-wired', !!sel.value);
        st.dirty = true;
      });
    });
  }

  // ─── Files section ───────────────────────────────────────────────────────────
  function renderFilesSection(config) {
    const type  = config.type;
    const files = st.files[config.id] || [];
    const roles = config.files || {};
    const audioFiles = files.filter(f => !f.endsWith('.lipsync.json'));
    const label = type === 'video' ? 'VIDEO FILE' : 'AUDIO FILES';
    const accept = type === 'video' ? 'video/*' : 'audio/*';

    return `
      <div class="panel-section">
        <div class="panel-section__header">${label}</div>
        <div class="file-list" id="fileList">
          ${audioFiles.map(f => renderFileRow(f, roles[f] || 'unset', type, config.id)).join('')}
        </div>
        <label class="upload-zone" id="uploadZone">
          <span class="upload-zone__text">↑ Upload ${type === 'video' ? 'video' : 'audio'}</span>
          <input type="file" id="fileUpload" accept="${accept}" multiple hidden />
        </label>
        <div class="upload-status" id="uploadStatus"></div>
      </div>
    `;
  }

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
          <button class="btn btn--ghost btn--small preview-test-btn" id="btnTestPreview">Test</button>
        </div>
        <div class="scene-preview" id="scenePreviewWrap">
          <canvas id="previewCanvas"></canvas>
          <div class="lipsync-preview__hint" id="previewHint">Loading…</div>
        </div>
      </div>
    `;
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
    if (!hasSegments && !voiceFile) return `
      <div class="panel-section panel-section--lipsync is-inactive">
        <div class="panel-section__header">LIP SYNC</div>
        <p class="panel-hint">Set an audio file's role to <strong>Voice</strong> above, then click Edit Lip Sync.</p>
      </div>`;

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
          <div class="segment-editor__row">
            <label class="segment-editor__label">BG music</label>
            <select class="field-select" data-seg-field="bg">
              <option value="">— none —</option>
              ${allFiles.filter(f => f.match(/\.(wav|mp3|ogg|m4a)$/i)).map(f => `<option value="${esc(f)}" ${seg.bg === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}
            </select>
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
          <button class="btn btn--ghost btn--small segment-delete-btn" data-action="delete-segment" ${segments.length <= 1 ? 'disabled' : ''}>Delete</button>
        </div>`;
      } else {
        segmentConfigHtml = `<div class="segment-editor">
          <div class="segment-editor__row">
            <label class="segment-editor__label">Voice</label>
            <select class="field-select segment-voice-select" data-seg-field="voice">
              <option value="">— none —</option>
              ${voiceFiles.map(f => `<option value="${esc(f)}" ${seg.voice === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}
            </select>
          </div>
          <div class="segment-editor__row">
            <label class="segment-editor__label">BG music</label>
            <select class="field-select" data-seg-field="bg">
              <option value="">— none —</option>
              ${allFiles.filter(f => f.match(/\.(wav|mp3|ogg|m4a)$/i)).map(f => `<option value="${esc(f)}" ${seg.bg === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}
            </select>
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
          <button class="btn btn--ghost btn--small segment-delete-btn" data-action="delete-segment" ${segments.length <= 1 ? 'disabled' : ''}>Delete</button>
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
          ? `<p class="panel-hint" style="padding:10px 14px">Chat segment — conversation is handled by Claude AI at runtime.</p>`
          : !voiceFile ? `<p class="panel-hint" style="padding:10px 14px">Pick a voice file for this segment above.</p>` :
          !isLoaded ? `<button class="btn btn--edit-lipsync" data-lipsync-load="${esc(voiceFile)}">Load for editing</button>` : `

        <div class="lipsync-layout">
          <div class="lipsync-controls">
            <div class="scrubber-wrap">
              <div class="scrub-marks" id="scrubMarks"></div>
              <input class="scrubber" id="scrubber" type="range" min="0" max="${dur.toFixed(3)}" step="0.001" value="${cur.toFixed(3)}" />
            </div>
            <div class="transport">
              <span class="transport__time" id="timeDisplay">${fmtTime(cur)} / ${fmtTime(dur)}</span>
              <button class="btn btn--icon" id="btnRestart" title="Restart">⏮</button>
              <button class="btn btn--icon" id="btnPlayPause" title="Play/Pause">${st.isPlaying ? '⏸' : '▶'}</button>
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
              <span class="row-label">Emotion</span>
              ${EMOTION_LABELS.map((l, i) => l ? `<button class="emotion-btn" data-emotion="${i}">${l}</button>` : '').join('')}
            </div>

            <div class="body-grid">
              <span class="row-label">Body</span>
              ${BODY_LABELS.map((l, i) => `<button class="body-btn" data-body="${i}" title="${l}">${l}</button>`).join('')}
            </div>
          </div>
        </div>

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
        <label class="field-label">System prompt</label>
        <textarea class="field-textarea" id="fieldSystemPrompt" rows="8">${esc(config.system_prompt || '')}</textarea>
      </div>
    `;
  }

  // ─── After section ───────────────────────────────────────────────────────────
  function renderAfterSection(config) {
    const after   = config.after || {};
    const scenes  = st.sequence.scenes || [];

    return `
      <div class="panel-section panel-section--after">
        <div class="panel-section__header">FALLBACK
          <span class="connections-hint-inline">${Array.isArray(config.segments) && config.segments.length ? 'after last segment ends' : 'if no CTA is tapped'}</span>
        </div>
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
      </div>
    `;
  }

  function triggerLabel(t) {
    return { tap_heart: 'Wait for heart tap', auto: 'Auto-advance', ended: 'After video ends', never: 'Never (open-ended)' }[t] || t;
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

  async function startPreviewTest(config) {
    const wrap = document.getElementById('scenePreviewWrap');
    const btn  = document.getElementById('btnTestPreview');
    if (!wrap) return;

    // Auto-save before testing so the game player reads the latest markers
    if (st.dirty || st.activeVoiceFile) await saveAll();

    previewTestMode = true;
    stopAudio();

    wrap.innerHTML = `
      <iframe id="previewTestFrame" src="/?scene=${encodeURIComponent(config.id)}" style="width:100%;height:100%;border:none;background:#000;"></iframe>
    `;
    if (btn) { btn.textContent = 'Back'; btn.classList.add('is-testing'); }
  }

  function stopPreviewTest(config) {
    previewTestMode = false;
    const btn = document.getElementById('btnTestPreview');
    if (btn) { btn.textContent = 'Test'; btn.classList.remove('is-testing'); }
    renderPanel();
    bindPanelEvents(st.configs[st.activeId]);
    initRivePreview(st.configs[st.activeId]);
  }

  // ─── Panel event binding ──────────────────────────────────────────────────────
  function bindPanelEvents(config) {
    // Preview test button
    const btnTest = document.getElementById('btnTestPreview');
    if (btnTest) {
      btnTest.addEventListener('click', () => {
        if (previewTestMode) stopPreviewTest(config);
        else startPreviewTest(config);
      });
    }

    // Title rename
    const fieldTitle = document.getElementById('fieldTitle');
    if (fieldTitle) {
      fieldTitle.addEventListener('change', async () => {
        const newTitle = fieldTitle.value.trim();
        if (!newTitle || newTitle === config.title) return;
        const res  = await fetch('/api/scenes/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: config.id, title: newTitle }) });
        const data = await res.json();
        if (data.ok) {
          const newId = data.id;
          // Update local state if id changed
          if (newId !== config.id) {
            st.configs[newId] = { ...config, id: newId, title: newTitle };
            st.files[newId]   = st.files[config.id] || [];
            delete st.configs[config.id];
            delete st.files[config.id];
            const seq = await (await fetch('/api/sequence')).json();
            st.sequence = seq;
            st.activeId = newId;
          } else {
            st.configs[config.id].title = newTitle;
          }
          renderSceneList();
          renderPanel();
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
        const reader = new FileReader();
        const b64 = await new Promise(r => { reader.onload = e => r(e.target.result.split(',')[1]); reader.readAsDataURL(file); });
        const res = await fetch('/api/shared/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: 'eli.riv', data: b64 }),
        });
        const data = await res.json();
        if (data.ok) {
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
        const reader = new FileReader();
        const b64 = await new Promise(r => { reader.onload = e => r(e.target.result.split(',')[1]); reader.readAsDataURL(file); });
        const res  = await fetch('/api/scene/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: config.id, filename: file.name, data: b64 }),
        });
        const data = await res.json();
        if (data.ok) {
          config.rive = data.filename;
          st.dirty = true;
          await saveAll();
          renderPanel();
          bindPanelEvents(config);
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
        bindPanelEvents(config);
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
        bindPanelEvents(config);
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
      bindPanelEvents(config);
    });
    // Add chat segment
    document.querySelector('[data-action="add-chat-segment"]')?.addEventListener('click', () => {
      if (!config.segments) config.segments = [];
      config.segments.push({ type: 'chat', opening: '', max_exchanges: 5, context_hint: '', trigger: 'ended' });
      st.activeSegmentIndex = config.segments.length - 1;
      st.activeVoiceFile = '';
      st.dirty = true;
      renderPanel();
      bindPanelEvents(config);
    });
    // Delete segment (from tab × or config button)
    function deleteSegment(idx) {
      if (!config.segments || config.segments.length <= 1) return;
      config.segments.splice(idx, 1);
      st.activeSegmentIndex = Math.min(st.activeSegmentIndex, config.segments.length - 1);
      st.activeVoiceFile = '';
      st.dirty = true;
      renderPanel();
      bindPanelEvents(config);
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
      bindPanelEvents(config);
    });
    // Segment field inputs (selects, text, number)
    document.querySelectorAll('[data-seg-field]').forEach(el => {
      const evt = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(evt, function () {
        if (!config.segments?.[st.activeSegmentIndex]) return;
        const field = this.dataset.segField;
        const val   = this.type === 'number' ? Number(this.value) : (this.value || '');
        config.segments[st.activeSegmentIndex][field] = val;
        st.dirty = true;
        if (field === 'voice') {
          st.activeVoiceFile = '';
          renderPanel();
          bindPanelEvents(config);
          return;
        }
        if (field === 'trigger') {
          const tab = document.querySelector(`[data-seg-idx="${st.activeSegmentIndex}"] .segment-tab__trigger`);
          if (tab) tab.textContent = this.value;
        }
      });
    });

    // File delete
    document.querySelectorAll('[data-file-delete]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const filename = btn.dataset.fileDelete;
        if (!confirm(`Remove "${filename}"?`)) return;
        await fetch('/api/scene/delete-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: config.id, filename }) });
        delete config.files[filename];
        st.files[config.id] = (st.files[config.id] || []).filter(f => f !== filename);
        if (st.activeVoiceFile === filename) { st.activeVoiceFile = ''; stopAudio(); }
        renderPanel();
        bindPanelEvents(config);
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

    // State machines
    const fieldStateMachines = document.getElementById('fieldStateMachines');
    if (fieldStateMachines) {
      fieldStateMachines.addEventListener('change', () => {
        const names = fieldStateMachines.value.split(',').map(s => s.trim()).filter(Boolean);
        config.stateMachines = names.length ? names : undefined;
        st.dirty = true;
      });
    }

    // After section
    const fieldTrigger   = document.getElementById('fieldTrigger');
    const fieldMessage   = document.getElementById('fieldMessage');
    const fieldNextScene = document.getElementById('fieldNextScene');
    if (fieldTrigger)   fieldTrigger.addEventListener('change',   () => { config.after.trigger  = fieldTrigger.value;   st.dirty = true; });
    if (fieldMessage)   fieldMessage.addEventListener('input',    () => { config.after.message   = fieldMessage.value;   st.dirty = true; });
    if (fieldNextScene) fieldNextScene.addEventListener('change', () => { config.after.next      = fieldNextScene.value || null; st.dirty = true; });
    // Lip sync controls
    bindLipSyncEvents(config);
  }

  // ─── File upload ─────────────────────────────────────────────────────────────
  async function handleUpload(fileList, config) {
    const statusEl = document.getElementById('uploadStatus');
    if (!fileList || !fileList.length) return;

    for (const file of fileList) {
      if (statusEl) statusEl.textContent = `Uploading ${file.name}…`;
      const reader = new FileReader();
      const b64 = await new Promise(r => { reader.onload = e => r(e.target.result.split(',')[1]); reader.readAsDataURL(file); });
      const res  = await fetch('/api/scene/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: config.id, filename: file.name, data: b64 }),
      });
      const data = await res.json();
      if (data.ok) {
        if (!st.files[config.id]) st.files[config.id] = [];
        if (!st.files[config.id].includes(data.filename)) st.files[config.id].push(data.filename);
        showToast(`Uploaded ${data.filename}`);
      } else {
        showToast(`Upload failed: ${data.error}`, true);
      }
    }
    if (statusEl) statusEl.textContent = '';
    renderPanel();
    bindPanelEvents(config);
  }

  // ─── Lip sync: audio loading ──────────────────────────────────────────────────
  async function loadVoiceFile(filename, config) {
    if (!filename) return;
    stopAudio();
    st.activeVoiceFile = filename;
    st.markers         = [];
    st.markersVersion++;
    st.selectedMarkerIdx = -1;

    const audioUrl = `/scenes/${config.id}/audio/${filename}`;
    st.audio.src   = `${audioUrl}?v=${Date.now()}`;
    st.audio.load();

    // Load existing lipsync.json
    const baseName = filename.replace(/\.[^.]+$/, '');
    try {
      const res = await fetch(`/scenes/${config.id}/audio/${baseName}.lipsync.json?v=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) {
        const payload = await res.json();
        st.markers = sanitizeMarkers(payload.markers);
        st.markersVersion++;
        showToast(`Loaded ${st.markers.length} markers`);
      }
    } catch {}

    renderPanel();
    bindPanelEvents(config);
    bindLipSyncEvents(config);
    initRivePreview(config);
  }

  // ─── Lip sync: Rive preview sync ─────────────────────────────────────────────
  function syncRiveToTime(t) {
    if (!rivePreview || !st.markers.length) return;
    let mouth = 0, emotion = -1, body = -1;
    for (const m of st.markers) {
      if (m.time > t) break;
      if (Number.isFinite(m.mouth_shape))   mouth   = m.mouth_shape;
      if (Number.isFinite(m.emotion_state)) emotion = m.emotion_state;
      if (Number.isFinite(m.body_movement)) body    = m.body_movement;
    }
    setPreviewInput('mouth_shape', mouth);
    setPreviewInput('is_speaking', mouth > 0);
    if (emotion >= 0) setPreviewInput('emotion_state', emotion);
    if (body    >= 0) { setPreviewInput('body_movement', body); setPreviewInput('nav_heart', body); }
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

    const dur = () => isNaN(st.audio.duration) ? 0 : st.audio.duration;

    const syncScrubberMax = () => {
      const d = dur();
      if (d > 0) scrubber.max = d.toFixed(3);
    };

    // Audio events
    st.audio.onloadedmetadata = syncScrubberMax;

    st.audio.ontimeupdate = () => {
      syncScrubberMax();
      const d = dur(), cur = st.audio.currentTime;
      if (!scrubber.dataset.dragging) scrubber.value = cur;
      if (timeDisplay) timeDisplay.textContent = `${fmtTime(cur)} / ${fmtTime(d)}`;
      renderScrubMarks(scrubber, d);
      syncRiveToTime(cur);
    };

    st.audio.onended = () => {
      st.isPlaying = false;
      if (btnPlayPause) btnPlayPause.textContent = '▶';
    };
    st.audio.onplay  = () => { st.isPlaying = true;  if (btnPlayPause) btnPlayPause.textContent = '⏸'; };
    st.audio.onpause = () => { st.isPlaying = false; if (btnPlayPause) btnPlayPause.textContent = '▶'; };

    // Scrubber — update time display and Rive even when paused
    scrubber.addEventListener('mousedown',  () => { scrubber.dataset.dragging = '1'; });
    scrubber.addEventListener('touchstart', () => { scrubber.dataset.dragging = '1'; }, { passive: true });
    scrubber.addEventListener('mouseup',    () => { delete scrubber.dataset.dragging; });
    scrubber.addEventListener('touchend',   () => { delete scrubber.dataset.dragging; });
    scrubber.addEventListener('input', () => {
      const t = Number(scrubber.value);
      st.audio.currentTime = t;
      if (timeDisplay) timeDisplay.textContent = `${fmtTime(t)} / ${fmtTime(dur())}`;
      renderScrubMarks(scrubber, dur());
      syncRiveToTime(t);
    });

    // Transport
    if (btnRestart)    btnRestart.onclick    = () => { st.audio.currentTime = 0; scrubber.value = 0; syncRiveToTime(0); };
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
        st.audio.currentTime = t;
        if (timeDisplay) timeDisplay.textContent = `${fmtTime(t)} / ${fmtTime(dur())}`;
        renderScrubMarks(scrubber, dur());
        syncRiveToTime(t);
      });
    }
  }

  function onKeyDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // Space: hold to play, release to pause
    if (e.key === ' ' && !e.repeat) {
      e.preventDefault();
      if (!st.isPlaying) st.audio.play().catch(() => {});
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
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
    const scrubber = document.getElementById('scrubber');
    const raw = scrubber ? Number(scrubber.value) : st.audio.currentTime;
    const time = Math.max(0, Math.round((isNaN(raw) ? 0 : raw) * 1000) / 1000);

    // Upsert: if a marker exists within 50ms, update it, else insert
    const near = st.markers.findIndex(m => Math.abs(m.time - time) < 0.05);
    const marker = near >= 0 ? st.markers[near] : { time };
    if (type === 'mouth')   { marker.mouth_shape   = value; setPreviewInput('mouth_shape', value); setPreviewInput('is_speaking', value > 0); }
    if (type === 'emotion') { marker.emotion_state = value; setPreviewInput('emotion_state', value); }
    if (type === 'body')    { marker.body_movement = value; setPreviewInput('body_movement', value); setPreviewInput('nav_heart', value); }
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

  function renderScrubMarks(scrubber, dur) {
    const marks = document.getElementById('scrubMarks');
    if (!marks || !dur) return;
    const w = scrubber.offsetWidth || marks.offsetWidth || 300;
    marks.innerHTML = st.markers.map((m, i) => {
      const pct = (m.time / dur) * 100;
      const cls = i === st.selectedMarkerIdx ? 'scrub-mark is-selected' : 'scrub-mark';
      const tip = markerLabel(m);
      return `<span class="${cls}" style="left:${pct}%" title="${esc(tip)}" data-midx="${i}"></span>`;
    }).join('');

    marks.querySelectorAll('.scrub-mark').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(el.dataset.midx);
        st.selectedMarkerIdx = st.selectedMarkerIdx === idx ? -1 : idx;
        if (st.selectedMarkerIdx >= 0) st.audio.currentTime = st.markers[idx].time;
        renderScrubMarks(scrubber, dur);
        const ml = document.getElementById('markerList');
        if (ml) renderMarkerList(ml);
      });
    });
  }

  function renderMarkerList(container) {
    if (!container) return;
    container.innerHTML = st.markers.map((m, i) => `
      <div class="marker-row ${i === st.selectedMarkerIdx ? 'is-selected' : ''}" data-midx="${i}">
        <span class="marker-row__time">${fmtTime(m.time)}</span>
        <span class="marker-row__label">${esc(markerLabel(m))}</span>
        <button class="marker-row__delete btn--icon" data-del-marker="${i}">×</button>
      </div>
    `).join('');

    container.querySelectorAll('[data-del-marker]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.dataset.delMarker);
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
        if (st.selectedMarkerIdx >= 0) st.audio.currentTime = st.markers[idx].time;
        renderMarkerList(container);
        const sr = document.getElementById('scrubber');
        if (sr) renderScrubMarks(sr, isNaN(st.audio.duration) ? 0 : st.audio.duration);
      });
    });
  }

  function markerLabel(m) {
    const parts = [];
    if (Number.isFinite(m.mouth_shape))   parts.push(MOUTH_LABELS[m.mouth_shape]   || `mouth ${m.mouth_shape}`);
    if (Number.isFinite(m.emotion_state)) parts.push(EMOTION_LABELS[m.emotion_state] || `emotion ${m.emotion_state}`);
    if (Number.isFinite(m.body_movement)) parts.push(BODY_LABELS[m.body_movement]   || `body ${m.body_movement}`);
    return parts.join(' · ');
  }

  function sanitizeMarkers(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(m => m && Number.isFinite(m.time) && m.time >= 0 &&
      (Number.isFinite(m.mouth_shape) || Number.isFinite(m.emotion_state) || Number.isFinite(m.body_movement))
    ).sort((a, b) => a.time - b.time);
  }

  function stopAudio() {
    if (st.audio) { st.audio.pause(); st.audio.src = ''; }
    st.isPlaying = false;
  }

  // ─── Save ────────────────────────────────────────────────────────────────────
  async function saveAll() {
    const config = st.configs[st.activeId];
    if (!config) return;

    config.ctaRoutes = sanitizeCtaRoutes(config.ctaRoutes);

    // Save scene config
    await fetch('/api/scene', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });

    // Save lipsync if active
    if (st.activeVoiceFile) {
      await fetch('/api/lipsync/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: config.id, filename: st.activeVoiceFile, markers: st.markers }),
      });
    }

    st.dirty = false;
    showToast('Saved.');
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
  async function testThisScene() {
    const id = st.activeId;
    if (!id) return;
    // Open window synchronously so browser doesn't block the popup
    const win = window.open('about:blank', '_blank');
    if (st.dirty) await saveAll();
    const url = `./index.html?scene=${encodeURIComponent(id)}&preview=1&v=${Date.now()}`;
    if (win) win.location.href = url;
    else window.open(url, '_blank');
  }

  async function testAll() {
    const win = window.open('about:blank', '_blank');
    if (st.dirty) await saveAll();
    const url = `./index.html?preview=1&v=${Date.now()}`;
    if (win) win.location.href = url;
    else window.open(url, '_blank');
  }

  // ─── Publish ─────────────────────────────────────────────────────────────────
  async function publish() {
    if (st.dirty) await saveAll();
    showToast('Publishing…');
    try {
      const res  = await fetch('/api/publish', { method: 'POST' });
      const data = await res.json();
      if (data.ok) showToast('Published successfully!');
      else showToast(`Publish failed: ${data.error}`, true);
    } catch (err) {
      showToast(`Publish error: ${err.message}`, true);
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
  function showToast(msg, isError = false) {
    toast.textContent = msg;
    toast.className   = `toast is-visible${isError ? ' is-error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3000);
  }

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
