# Eli's Last Experiment

A mobile narrative-strategy game. Single codebase, three platforms: **iOS, Android, Web**. All character interactivity is authored in **Rive**; the app code orchestrates state, audio, dialogue, and scene transitions.

> **Design north star:** the player should feel concern, tenderness, urgency, guilt, hope. Eli is a presence, not a target. See `00_Documents/` for full design intent.

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Build/dev | **Vite 5** + TypeScript (strict) | Fast HMR, smallest viable bundler |
| UI | **React 18** (functional, hooks only) | Codex affinity, ecosystem |
| Animation | **Rive** via `@rive-app/react-canvas` | WebGL + WASM, identical on iOS/Android/Web |
| Native shell | **Capacitor 6** | Wraps the web build as iOS + Android apps |
| State | **Zustand** | Small, no boilerplate, persists easily |
| Audio | **Howler.js** | Reliable on iOS WKWebView, gapless loops |
| Storage | `@capacitor/preferences` | Save state cross-platform |
| Lint/format | ESLint + Prettier | Standard |
| Test | Vitest + React Testing Library | Fast |

**Do not use:** Redux, MobX, styled-components, CSS-in-JS runtimes, animation libraries other than Rive, or any heavy UI kit. Tailwind is allowed but optional.

---

## 2. Folder structure

```
Prototype-4/
├── README.md                    ← this file (the contract for Codex)
├── RIVE_SPEC.md                 ← Rive file authoring contract
├── public/
│   └── rive/                    ← drop .riv files here; auto-served at /rive/*
│       ├── intro.riv
│       ├── eli.riv
│       └── extraction/
│           ├── heart_run.riv
│           ├── lungs_run.riv
│           └── brain_run.riv
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── scenes/                  ← one folder per scene
│   │   ├── Intro/
│   │   ├── Body/                ← Eli's body view (the hub)
│   │   └── Extraction/
│   ├── components/
│   │   ├── RiveCanvas.tsx       ← generic Rive renderer
│   │   └── Subtitle.tsx
│   ├── hooks/
│   │   ├── useRiveInputs.ts     ← typed input bridge
│   │   └── useHaptics.ts
│   ├── state/
│   │   ├── gameStore.ts         ← Zustand store
│   │   └── persistence.ts       ← Capacitor Preferences wrapper
│   ├── audio/
│   │   ├── AudioBus.ts
│   │   └── tracks.ts
│   ├── rive/
│   │   ├── contract.ts          ← TS types mirroring RIVE_SPEC.md
│   │   └── manifest.ts          ← auto-generated; do not hand-edit
│   └── types/
├── ios/                         ← Capacitor-generated, do not edit by hand
├── android/                     ← Capacitor-generated, do not edit by hand
├── scripts/
│   └── watch-rive.mjs           ← watcher that rebuilds the Rive manifest
├── capacitor.config.ts
├── vite.config.ts
├── tsconfig.json
└── package.json
```

---

## 3. The Rive ↔ Code contract

**The rule:** code never hardcodes animation behavior. Code reads/writes **inputs** on a Rive **state machine**. Rive authors transitions and visuals.

Every `.riv` file declares:
- One or more **artboards** (PascalCase)
- One **state machine per artboard** (PascalCase, suffix `State`)
- **Inputs** (snake_case): `number`, `boolean`, or `trigger`
- **Text runs** (snake_case) for any text that changes at runtime

The canonical list of artboards, state machines, inputs, and text runs lives in `RIVE_SPEC.md`. **`src/rive/contract.ts` must mirror it exactly** — when the spec changes, the types change, and TypeScript will surface every broken call site.

Example use:
```ts
import { useRive, useStateMachineInput } from '@rive-app/react-canvas';

const { rive, RiveComponent } = useRive({
  src: '/rive/eli.riv',
  artboard: 'Eli',
  stateMachines: 'EliState',
  autoplay: true,
});

const heartPulse = useStateMachineInput(rive, 'EliState', 'heart_pulse');
const tapHeart   = useStateMachineInput(rive, 'EliState', 'tap_heart');

// later
heartPulse.value = 72;
tapHeart.fire();
```

**Direction matters.** Two flows cross the contract, and they're not symmetric:

- **App → Rive:** code writes input values to push app state into the animation (`heartPulse.value = 72`, `listening.value = true` on scene mount, initial baselines on load). This is fine and expected.
- **Rive → App:** code does **not** drive user-input triggers from JS click handlers. Clicks live inside Rive via **Listeners** authored in the Rive editor (hit areas → Input Change actions). When Rive needs to tell the app something happened — a CTA committed, audio should play, the scene should change — it emits either a **Rive Event** (preferred) or flips a Boolean input the app polls (fallback). The app subscribes and reacts (play audio, swap scenes, persist state).

The fallback exists because the current Rive BETA used to author `intro.riv` doesn't expose the Rive Event creator in the expected places. See Appendix B for the workaround pattern.

---

## 4. Hot-swap workflow (the thing Jeff cares about)

**Goal:** Jeff edits `eli.riv` in the Rive editor, exports, drops it into `public/rive/eli.riv`, and the running app reloads with the new file. No code change.

How it works:
1. Vite watches `public/`. Any change there triggers a full page reload in dev.
2. `scripts/watch-rive.mjs` (run via `npm run dev`) watches `public/rive/**/*.riv` and rewrites `src/rive/manifest.ts` with hashed filenames. The manifest exports URLs like `/rive/eli.riv?v=abc123`. This busts the WKWebView/Android WebView cache, which otherwise will cling to stale binaries.
3. In React, `<RiveCanvas src={RIVE.eli}>` always pulls the current hash.

**Codex task:** implement `scripts/watch-rive.mjs` using `chokidar` and `crypto.createHash('sha1')` on file contents. Emit a TS module like:
```ts
export const RIVE = {
  intro: '/rive/intro.riv?v=8f3a1e',
  eli:   '/rive/eli.riv?v=2c91b4',
  heart: '/rive/extraction/heart_run.riv?v=ee401d',
} as const;
```
Run the watcher in parallel with Vite via `npm-run-all` or `concurrently`.

For production: the same manifest is generated at build time. The hash is the cache-buster on the CDN.

---

## 5. Mobile performance budget

**Hard ceilings — fail the PR if exceeded:**

| Metric | Budget |
|---|---|
| Total .riv assets on cold launch | < 2 MB |
| Single `.riv` file size | < 500 KB (target), 800 KB (hard ceiling) |
| First meaningful paint (title screen, mid-tier Android) | < 1.5 s |
| Sustained frame rate during Eli idle | 60 fps |
| Sustained frame rate during extraction run | ≥ 45 fps |
| Bundle size (JS, gzipped) | < 250 KB |
| Audio asset per dialogue line | < 60 KB (Opus, 32 kbps, mono) |

**Rules to stay under budget:**
- Vector first. No raster inside Rive unless absolutely necessary; if needed, pre-compress to ≤ 80% JPG quality before importing.
- One Rive file per scene at most. Don't bundle the whole game into one `.riv`.
- Reuse Eli's body across scenes by passing him to multiple `RiveCanvas` mounts pointing at the same `eli.riv` — Rive caches the binary.
- Mesh deformation: budget 6 meshes per artboard. Bones are cheaper.
- Disable Rive autoplay on offscreen scenes; pause via `rive.pause()` when scene unmounts.
- Audio: Opus for voice, AAC for music. Stream music, preload SFX.
- Lazy-load extraction `.riv` files only when the run begins.

---

## 6. Commands

```bash
# install
npm install

# dev (web only, with HMR + Rive watcher)
npm run dev

# typecheck + lint + test
npm run check

# build web
npm run build

# preview the production build locally
npm run preview

# iOS (requires Xcode, macOS)
npx cap sync ios
npx cap open ios

# Android (requires Android Studio)
npx cap sync android
npx cap open android

# update native shells after web build
npm run build && npx cap sync
```

Every commit must pass `npm run check`.

---

## 7. Conventions

- **TypeScript strict mode.** No `any`. No `// @ts-ignore` without a `// reason:` comment on the same line.
- Components are functional. Hooks only. No class components.
- One component per file. File name matches default export.
- State lives in Zustand. Component-local state (`useState`) is fine for ephemeral UI only.
- No global mutable singletons except `AudioBus` and the Rive manifest.
- Imports: external first, then `@/` aliases, then relative. ESLint enforces.
- All user-facing strings live in `src/content/strings.ts` keyed by ID. No string literals in JSX.
- Subtitle and dialogue copy: short, present tense, lowercase except proper nouns. See `00_Documents/` for tone.
- No emoji in code or copy.

---

## 8. The first build target: Minute One

Codex's first deliverable is **the opening 60 seconds** described below. This is the smallest end-to-end slice — it exercises Rive, audio, state, persistence, and the hot-swap pipeline.

**Sequence (single scene: `Intro`):**

| t | What happens | Driven by |
|---|---|---|
| 0.0 s | App opens to black. Soft heartbeat starts (audio). | `AudioBus.play('heartbeat_loop')` |
| 0.8 s | `intro.riv` artboard `Title` fades in. State machine input `phase` = 0. | Rive |
| 2.0 s | Voice-memo waveform pulses. Subtitle: *Listen.* | Rive input `waveform_active` = true |
| — | Player taps the waveform. | `tap_waveform` trigger fires |
| — | Eli's recorded voice plays: *"I thought… nobody could hear me. Are you really there?"* | `AudioBus.play('eli_intro_01')` |
| ~18 s | Audio ends → `phase` = 1. Eli's silhouette resolves. His heart pulses faintly in his chest. Subtitle: *He can feel where you touch.* | Rive |
| — | Player taps the heart. | `tap_heart` trigger |
| — | On each tap, heartbeat audio nudges toward steady rhythm. After 3 taps, `phase` = 2. | gameStore counts taps |
| ~50 s | Eli, eyes closed, faint smile. Whisper: *"Stay?"* Title fades in: ELI — LAST EXPERIMENT. | Rive |
| ~58 s | Button "STAY WITH ELI" appears. | Rive input `cta_visible` = true |
| — | Player taps. Persist `intro_completed = true`. Route to `Body` scene (placeholder for now). | gameStore + Capacitor Preferences |

**Acceptance criteria:**
- Runs on web (`npm run dev`), iOS simulator, and Android emulator with identical visuals.
- Replacing `public/rive/intro.riv` and saving causes a hot reload within 2 s; no manual cache clearing.
- Total time-to-interactive on a mid-tier Android phone < 1.5 s.
- No console errors. No layout shift after first paint.
- Subtitles are screen-reader accessible (`aria-live="polite"`).

---

## 9. What Codex should NOT do

- Do not invent new Rive inputs, artboards, or state machines. The Rive file is the source of truth; if a missing input would help, **stop and ask Jeff to add it in Rive first.**
- Do not change the contract types in `src/rive/contract.ts` without a matching edit to `RIVE_SPEC.md`.
- Do not pull in additional dependencies without justification in the PR description.
- Do not add analytics, telemetry, ad SDKs, or social SDKs. Not now.
- Do not optimize prematurely. Hit the budget; don't micro-tune below it.

---

## 10. Open questions for Jeff (answer before sprint 2)

- Localization: English only for v1?
- Account system: anonymous local save only, or sign-in later?
- Monetization: out of scope for prototype.
- Distribution: TestFlight + Android internal testing for the prototype?

---

## Appendix A — Why this stack over the alternatives

- **React Native + rive-react-native.** Native runtime is faster but the web build path is awkward (rive-react-native does not run on web). Hot-swap is also harder because native bundlers cache assets aggressively.
- **Flutter + rive-flutter.** Excellent native perf, but Codex is weaker at Dart than at TypeScript, and web Flutter has long startup.
- **Native iOS + Android.** Best perf, worst velocity. Two codebases, two Rive integrations.
- **Pure PWA, no Capacitor.** Works, but no App Store distribution and iOS PWA support is unstable for audio playback.

Capacitor + Vite + React + Rive Web hits the right point on the curve for a prototype that must look identical across platforms and iterate fast on `.riv` files.

---

## Appendix B — Prototype-4 Handoff Notes (updated May 14, 2026)

These notes capture the current local Rive/audio preview workflow before the full React/Vite app is scaffolded.

### Current preview harness

There is a temporary standalone preview page at `test.html`. Run it with:

```bash
cd "/Users/jeff/Desktop/Jeff_Main/08_Eli's Last Experiment/Prototype-4"
python3 -m http.server 4177
```

Desktop preview:

```text
http://localhost:4177/test.html
```

Same-Wi-Fi mobile preview from Jeff's current network:

```text
http://10.0.0.4:4177/test.html
```

Mobile Eli preview:

```text
http://10.0.0.4:4177/test.html?file=eli
```

Mobile debug preview:

```text
http://10.0.0.4:4177/test.html?debug=1
```

Preview profiles:

```text
http://localhost:4177/test.html
  loads public/rive/intro.riv
  artboard: Title
  state machine: TitleState

http://localhost:4177/test.html?file=eli
  loads public/rive/eli.riv
  artboard: Eli
  state machine: EliState

http://localhost:4177/test.html?file=eli&debug=1
  same Eli preview plus contract/size debug panel and a Fire tap_heart button
```

Important: use `http://localhost:4177/...`, not a `file://` URL. The WebGL/WASM Rive runtime and mobile audio behavior are more reliable through the local server. `test.html` now redirects from `file://` to `http://localhost:4177/test.html` as a guardrail.

The preview uses `@rive-app/webgl2@latest` so Rive Renderer features such as vector feathering, blur/layer effects, and WebGL rendering display correctly. It also uses `useOffscreenRenderer: true`.

### Current file split

The project now uses separate Rive files for scene and character:

```text
public/rive/intro.riv
  opening scene, waveform, title, CTA, entry mood

public/rive/eli.riv
  Eli avatar, face, body, organs, emotional/touch reactions
```

This is intentional. `intro.riv` should not permanently contain the full Eli avatar. The real app will layer/route from intro scene work to the reusable Eli character file.

### Intro CTA behavior

The entry CTA copy is:

```text
STAY WITH ELI
```

In `intro.riv`, keep this as text run:

```text
cta_label
```

Current `intro.riv` exposes:

```text
Artboard: Title
State machine: TitleState
Inputs (in the "Deprecated" section in BETA Rive; still functional):
  start_dot: Trigger
  stay: Trigger
  nav_eli: Boolean    # host watches this to route to eli.riv
Listeners:
  dot_heart
  Stay
    actions:
      fire: stay                  # drives the state machine transition
      and set: nav_eli = true     # signals the host to navigate
```

The temporary preview flow now works like this:

```text
clicks: owned entirely by Rive Listeners (dot_heart, Stay, etc.).
        The host does NOT count taps, fire triggers, or hold any
        intro-specific tap logic in JS.

host responsibilities on tap:
  1. Unlock mobile audio on the first user gesture (one-time).
  2. Watch the `nav_eli` Boolean input on a rAF loop and route to
     eli.riv when it flips true.

flow:
  tap dot   -> Rive listener fires start_dot -> state machine advances
  tap STAY  -> Rive listener fires stay AND sets nav_eli = true
            -> host watcher sees nav_eli flip true
            -> host fades to black (3000 ms overlay) and navigates
               to test.html?file=eli

audio: still external (per the no-audio-in-Rive policy). The host plays
       sounds on load (heartbeat loop) or in response to Rive Events
       (`handleRiveEvent` in test.html maps event names to sound keys).

fade: owned by the host HTML overlay. The final React app should
      implement the same goodbye moment via scene routing.
```

### Why `nav_eli` instead of a Rive Event

The cleaner long-term pattern is for the Stay listener to **report a Rive Event** (e.g. `goto_eli`) that the host subscribes to. The host code already supports it — `handleRiveEvent` in `test.html` routes any event named `goto_<profile>` to that profile, and plays any event whose name matches a sound key.

In the current Rive BETA (0.8.x) used to author `intro.riv`, the Event creator UI is not exposed where expected: the `+` next to "Events" inside a transition inspector creates a firing slot but not an event definition, and typing an event name into a Report Event action's dropdown clears the text on commit because no global event with that name exists yet. Events appear to have migrated into the Data Binding system (View Models), which this project does not yet use.

As a workaround, the Stay listener sets a Boolean input `nav_eli = true` on tap. The host polls it each frame and routes when it flips true. When the Rive Event creator becomes reachable (newer BETA, or once Data Binding is adopted), migrate by:

1. Adding a Rive Event named `goto_eli` at the state machine level.
2. Replacing the listener's "and set: nav_eli = true" action with "report: goto_eli".
3. Removing the `nav_eli` input from the Inputs section.

No JS changes needed — the host already listens for both paths.

Note: the broader written contract in `RIVE_SPEC.md` still describes the older intro input names (`phase`, `tap_waveform`, `tap_cta`, etc.). Either update `RIVE_SPEC.md` to match the current `start_dot` / `stay` / `nav_eli` set, or rename the Rive inputs back to the spec before implementation hardening.

### External audio policy

Audio must stay outside `.riv` files. Do not embed audio in Rive.

Expected audio paths in the temporary preview:

```text
public/audio/sfx/heartbeat_loop.opus
public/audio/voice/eli/intro_01.opus
public/audio/sfx/heart_tap.opus
public/audio/sfx/cta_chime.opus
```

Temporary fallback currently supported:

```text
public/audio/sfx/heartbeat-deceleration-the-foundation-fast-to-slow-2-00-24.mp3
```

Mobile browsers will not autoplay audio on page load. Audio unlock happens on the first player tap.

### Eli avatar state machine contract

`public/rive/eli.riv` should expose:

```text
Artboard: Eli
State machine: EliState
```

Inputs:

```text
heart_pulse: Number
lungs_pulse: Number
brain_pulse: Number
eyes_state: Number
mouth_state: Number
body_state: Number
mood: Number
tap_heart: Trigger
tap_lungs: Trigger
tap_brain: Trigger
cue_speak: Trigger
listening: Boolean
```

Text run:

```text
eli_subtitle
```

Listener/hit areas:

```text
hit_heart
hit_lungs
hit_brain
```

Naming rule:

```text
hit_heart   = invisible clickable/listener area
tap_heart   = trigger input
heart_pain  = animation/state name
heart_pulse = number input for visual intensity
```

Do not name the listener and trigger the same thing. Do not name the animation state `tap_heart`; use `heart_pain` or `heart_react`.

### Eli heart interaction setup

The current working Rive pattern is:

```text
EliState
  Listeners
    hit_heart
      Listen to: Click
      Action target: tap_heart

  States
    Entry -> idle
    idle -> heart_pain
      condition: tap_heart
    heart_pain -> idle
      exit time / animation complete
```

Inside `heart_pain`, animate the visible Eli art on the main `Eli` artboard:

```text
heart visual pulses/glows
face changes to pain/concern
eyes/mouth/brows react
then returns softly to idle
```

The app/code does not read Rive listeners directly. The app talks to state machine inputs. Rive listeners are internal hit areas that fire those inputs.

### Current status and risks

As of the latest local checks, `eli.riv` exports with the expected names, including:

```text
EliState
hit_heart
tap_heart
heart_pain
idle
heart_pulse
eyes_state
mouth_state
mood
```

Known issue: asset size is far above budget while proving the interaction.

Recent observed sizes:

```text
intro.riv: roughly 4.4 MB
eli.riv: roughly 3.3 MB
```

Project budget remains:

```text
single .riv target: <= 500 KB
single .riv hard ceiling: <= 800 KB
```

Do not optimize the artwork until the interaction is locked, but plan a serious Rive cleanup pass before implementation hardening. Likely cleanup areas: embedded/oversized raster assets, duplicate component art, hidden/unused layers, unused timelines, and source/editor artifacts accidentally exported into runtime files.

### Production preview deployment

The production Docker image now runs `local-server.mjs` with Node instead of static Nginx. This is intentional: the same container must serve the Rive prototype and the `/api/eli-chat` endpoint.

Required production environment variable:

```text
OPENAI_API_KEY=sk-proj-...
```

Optional production environment variables:

```text
OPENAI_MODEL=gpt-4.1-mini
PORT=80
```

If `OPENAI_API_KEY` is missing or quota is unavailable, the prototype still loads and uses local fallback Eli replies.

### Claude continuation handoff - June 4, 2026

This repo is currently a working standalone Rive/HTML prototype, not the final React app scaffold. Continue work primarily in:

```text
test.html
local-server.mjs
public/rive/*.riv
public/audio/*
```

Local server:

```bash
cd "/Users/jeff/Desktop/Jeff_Main/08_Eli's Last Experiment/Prototype-4"
OPENAI_API_KEY="..." node local-server.mjs
```

Safer local launcher:

```bash
"/Users/jeff/Desktop/Jeff_Main/08_Eli's Last Experiment/Prototype-4/start-ai-server.command"
```

Current local URLs:

```text
Entry:          http://localhost:4177/test.html
Eli:            http://localhost:4177/test.html?file=eli
First contact:  http://localhost:4177/test.html?file=first_contact
Reset chat:     http://localhost:4177/test.html?file=first_contact&reset=1
AI status:      http://localhost:4177/api/openai-status
```

Mobile review on Jeff's current Wi-Fi:

```text
Entry:          http://10.0.0.212:4177/test.html
Eli:            http://10.0.0.212:4177/test.html?file=eli
First contact:  http://10.0.0.212:4177/test.html?file=first_contact
Reset chat:     http://10.0.0.212:4177/test.html?file=first_contact&reset=1
```

Check the IP again with `ipconfig getifaddr en0` if mobile links stop loading.

#### Current scene map

`test.html` has active scene profiles for the Rive scenes plus one video interstitial:

```text
intro
  file: public/rive/intro.riv
  artboard: Title
  state machine: TitleState
  route to Eli: Boolean input nav_eli flips true

eli
  file: public/rive/eli.riv
  artboard: Eli
  state machine: EliState
  route to video: Boolean input nav_first_contact flips true

eli_video
  file: public/Video/eli_video.mp4
  plays before first_contact
  route to first_contact: video ended event

first_contact
  file: public/rive/first_contact.riv
  artboard: FirstContact
  state machine: FirstContactState
  HTML chat overlay on top of Rive
```

Scene routing is still handled by the host page. Rive listeners should fire inputs/events; JavaScript should not manually guess tap locations.

#### Current audio behavior

Audio is external. Do not embed audio into `.riv` files.

Current sound keys in `test.html`:

```text
screen_tap        -> public/audio/sfx/tap.mp3
screen_enter_loop -> public/audio/sfx/enter.mp3
xray_loop         -> public/audio/sfx/xray.mp3
heart_tap         -> public/audio/sfx/heart_tap.opus (optional/missing until added)
cta_chime         -> public/audio/sfx/cta_chime.opus (optional/missing until added)
eli_intro_01      -> public/audio/voice/eli/intro_01.opus (optional/missing until added)
heartbeat_loop    -> opus/mp3 fallback paths from earlier prototype
```

Entry screen behavior:

```text
first tap: tap.mp3 plays once
after 220ms: enter.mp3 starts looping
transition to Eli: entry loop stops, xray.mp3 starts looping during fade
```

Eli screen behavior:

```text
xray.mp3 loops while on Eli when audio has been unlocked.
If Eli is opened directly in a fresh browser tab, one tap is still needed because mobile browsers block autoplay.
```

All looping sounds are stopped on scene transition by `stopLoopingSounds()`, except transition sounds explicitly passed through.

#### First contact chat

The first contact screen is an HTML overlay on top of `first_contact.riv`.

Current UX decisions:

```text
overlay fades in
input is not auto-focused on entry, so mobile keyboard does not cover Eli's first line
chat thread scrolls
new messages auto-scroll to bottom
mobile typography is enlarged for Pixel-sized screens
```

First-contact opening is story-first, not user-profile-first. The scripted opening asks the player to help investigate what happened to Eli, then asks for the player's name after a few memory fragments.

Current scripted opening keys:

```text
help_consent
first_clue
heart_sound
player_name
permission_pattern
```

After onboarding, the screen becomes open chat. Memory is stored in `localStorage` under:

```text
eli_player_name
eli_relationship_memory
```

Use `?reset=1` to clear local first-contact memory.

#### AI server

`local-server.mjs` serves both static files and `/api/eli-chat`.

The AI prompt lives in `eliSystemPrompt`. It should keep Eli:

```text
frightened but curious
gentle
short
relationship-building, not chatbot-like
non-clinical
not manipulative
careful not to invent player emotions
```

Important guardrail already implemented: `sanitizeEliReply()` catches model replies that invent unsupported player feelings such as sadness after the player says they are okay.

Production requires:

```text
OPENAI_API_KEY
```

Optional:

```text
OPENAI_MODEL=gpt-4.1-mini
```

If OpenAI is unavailable, `/api/eli-chat` returns local fallback replies so the prototype remains usable.

#### Easypanel / production

The Dockerfile now uses Node:

```text
FROM node:22-alpine
CMD ["node", "local-server.mjs"]
```

This replaced the older static Nginx image so production can serve `/api/eli-chat`. Easypanel should deploy from GitHub `main`.

Set Easypanel environment variables:

```text
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-mini
PORT=80
```

Do not commit real API keys. The only key-looking value in the repo should be the README placeholder.

#### Known risks before hardening

```text
Rive files are still much larger than budget.
Some referenced audio paths are optional/missing until final assets are added.
Current prototype is a single test.html; final app architecture is still planned as React/Vite/Capacitor.
Mobile audio depends on user gesture unlock. Avoid designs that require true autoplay.
Do not overwrite Jeff's latest .riv changes unless explicitly asked.
```

---

## Appendix C — Claude working context (read this first in every session)

This section is written for Claude. When Jeff opens this project in VS Code and starts a conversation, Claude should read this appendix before touching any file.

### Who Jeff is

Jeff is a UX designer and technologist building this game as a solo founder project alongside consulting and career transition work. He is fluent in English and Spanish. He thinks in systems and moves fast once direction is clear. He prefers direct, specific input over diplomatic hedging. Do not soften feedback.

### What this project actually is right now

`Prototype-4` is a **working standalone HTML/Node prototype**, not yet the final React/Vite/Capacitor app described in sections 1–8 of this README. The architecture in sections 1–8 is the intended final target. The current working files are:

```text
test.html           ← the entire frontend (one file, no build step)
local-server.mjs    ← Node HTTP server + /api/eli-chat endpoint
public/rive/*.riv   ← Rive animation files (do not overwrite without being asked)
public/audio/*      ← sound assets
```

All active development happens in those four locations. Do not scaffold React components, Zustand stores, or Vite configs unless Jeff explicitly asks to migrate to the final architecture.

### How to start the server

```bash
cd "/Users/jeff/Desktop/Jeff_Main/08_Eli's Last Experiment/Prototype-4"
OPENAI_API_KEY="..." node local-server.mjs
```

Or use the safe launcher:

```bash
"/Users/jeff/Desktop/Jeff_Main/08_Eli's Last Experiment/Prototype-4/start-ai-server.command"
```

### Live URLs

```text
Entry:         http://localhost:4177/test.html
Eli body:      http://localhost:4177/test.html?file=eli
First contact: http://localhost:4177/test.html?file=first_contact
Reset chat:    http://localhost:4177/test.html?file=first_contact&reset=1
AI status:     http://localhost:4177/api/openai-status
```

Mobile (check IP with `ipconfig getifaddr en0` if links stop working):

```text
http://10.0.0.212:4177/test.html
```

### Current state of the codebase — June 4, 2026

These features are **implemented and working**:

```text
Rive/video scenes: intro → eli → eli_video → first_contact
Scene routing via Boolean input polling (nav_eli, nav_first_contact)
HTML chat overlay on first_contact scene
OpenAI /api/eli-chat endpoint with fallback replies
Story-first scripted opening: help_consent, first_clue, heart_sound, player_name, permission_pattern
Memory stored in localStorage: eli_player_name, eli_relationship_memory
sanitizeEliReply() guardrail — prevents Eli from inventing player emotions
Rive event handler: goto_<profile> routes scenes, play_<sound> triggers audio
Hot audio unlock on first user gesture
```

These features were **added June 4, 2026** (files: `local-server.mjs`, `test.html`):

```text
vitals in API response: {bpm: number, mood: number} alongside every Eli reply
heart_pulse and mood Rive inputs written after each chat reply (chat → Rive bridge)
BPM display overlay (position:fixed, top-right, first_contact scene only)
session_number tracked in localStorage, incremented on each open
last_session_at timestamp stored; hours_since_last_session computed and sent to API
last_absence_hours stored; absenceAwareOpenPrompt() overrides Eli's first free-chat line
fallbackVitals() provides bpm/mood estimates when OpenAI is offline
sanitizeVitals() clamps bpm 60-180, mood 0-5 before leaving server
```

These features are **not yet built**:

```text
Push notifications / lock screen signal (between-session variable interval mechanic)
Session arc (Eli's tone shifting across sessions 1-7: stranger → known → trusted → mirror)
Organ health decay over time (avoidance loop — heart_pulse rises while player is away)
Extraction run scenes (heart_run.riv, lungs_run.riv, brain_run.riv)
Memory chip visualization (words Eli has stored, shown in the chat thread)
React/Vite/Capacitor migration (still on single test.html)
```

### The eli_relationship_memory schema

Stored in `localStorage` under `eli_relationship_memory`. Current shape after June 4 changes:

```json
{
  "help_consent": "yes",
  "first_clue": "the room",
  "heart_sound_theory": "a machine",
  "player_name": "Jeff",
  "permission_pattern": "yes",
  "first_contact_complete": true,
  "open_chat_started": true,
  "last_free_chat": "...",
  "interactions": [
    {
      "scene": "first_contact",
      "question": "player_name",
      "player_answer": "Jeff",
      "at": "2026-06-04T15:30:00.000Z",
      "eli_reply": "Jeff. I can remember that.",
      "replied_at": "2026-06-04T15:30:02.000Z"
    }
  ],
  "session_number": 3,
  "last_session_at": "2026-06-04T15:30:00.000Z",
  "last_absence_hours": 4.2,
  "last_bpm": 118,
  "last_mood": 3,
  "updated_at": "2026-06-04T15:30:02.000Z"
}
```

### The /api/eli-chat contract

**Request body:**

```json
{
  "question": "string — the current prompt Eli is asking",
  "answer": "string — the player's reply (max 240 chars)",
  "memory": { ...eli_relationship_memory },
  "recent_interactions": [ ...last 6 interactions ],
  "session_number": 3,
  "absence_hours": 4.2
}
```

**Response body:**

```json
{
  "mode": "openai | fallback",
  "reply": "Eli's response text (4-18 words)",
  "memory_patch": { "key": "value" },
  "vitals": { "bpm": 118, "mood": 3 }
}
```

`vitals` may be `null` in fallback mode if the input is cold/unrecognized. Always null-check before writing to Rive.

### The Rive input bridge

`setInput(name, value)` in `test.html` writes to the active state machine. After each Eli reply, `applyVitals()` is called with the response vitals:

```text
vitals.bpm  → mapped 60-180 to 0-100 → written to heart_pulse (Number input)
vitals.mood → written directly to mood (Number input, 0-5)
```

Initial values on first_contact scene load:

```text
heart_pulse: derived from memory.last_bpm (default 132 if no prior session)
mood:        derived from memory.last_mood (default 1 if no prior session)
```

### Eli's character — do not drift from this

```text
frightened but curious
gentle, short replies (4-18 words)
relationship-building, not chatbot-like
non-clinical language only
never manipulates, shames, flatters excessively, or claims to be human
does not invent or assume player emotions
uses player's exact words back — not synonyms, not summaries
has his own interior: afraid of forgetting, curious about the player's life outside the game
exists between sessions — notices time passing, notices the player's absence
```

### Rules for Claude when working in this repo

1. **Read before writing.** Always read the file you are about to edit. Never patch from memory.
2. **Do not overwrite .riv files.** Ever. Only Jeff touches Rive files.
3. **Do not add npm dependencies** to the prototype without asking. The prototype has no `package.json` — it uses CDN scripts.
4. **Do not scaffold the React app** unless Jeff explicitly says "migrate to React." The prototype and the final app are separate work streams.
5. **Minimal diffs.** Change only what is needed for the task. Do not reformat unrelated code.
6. **Syntax-check before handing back.** Run `node --check local-server.mjs` after any server edit. For `test.html`, verify the script block with `node -e "new Function(...)"`.
7. **When unsure about a Rive input name**, check `profile.expectedInputs` in `test.html` or ask Jeff to confirm in the Rive editor. Do not guess input names.
8. **Memory keys must be snake_case, 1-64 chars, alphanumeric plus `_` and `:`**. The `sanitizeMemory()` function on the server enforces this — invalid keys are silently dropped.
9. **The design north star is attachment, not engagement.** Every feature should make the player feel concern, tenderness, or care for Eli. If a change makes the game feel more like a chatbot or a notification machine, push back.

### Design documents Claude has already read

In the current conversation thread (started June 4, 2026), Claude has full context on:

```text
Hopson's Behavioral Game Design framework (variable ratio, avoidance, chain schedules, extinction)
The attachment architecture (4-layer memory system: voice profile, event log, patterns, Eli's interior)
The wireframe system (3 screens: chat introduction, returning player home, between-session signal)
The Hopson loop map (which UI element drives which schedule)
The session arc (sessions 1-7: stranger → known → trusted → mirror)
```

If starting a new conversation, Jeff should paste this README into the first message or use the VS Code Claude extension with this file open. The context above does not need to be re-explained — just confirm the README was read and proceed.

### What to work on next (as of June 4, 2026)

Priority order:

1. **Test the vitals bridge** — open `?file=first_contact&reset=1`, say something warm, confirm BPM drops and `heart_pulse` input changes in the Rive debug panel.
2. **Organ decay loop** — `heart_pulse` should drift upward over real time when the player is away. A simple `setInterval` in `test.html` that increments `last_bpm` by ~1 every 5 minutes (capped at 160) and writes it to Rive on next open.
3. **Session arc prompt injection** — the system prompt in `local-server.mjs` should vary based on `session_number`: sessions 1 = stranger register, 2-3 = first recall moments (use player's exact word back), 4-5 = Eli asks a genuine question from earlier, 6-7 = the mirror (synthesize a behavioral pattern observation).
4. **Memory chip visualization** — after Eli's reply, show a small row of word chips in the chat thread for the words he just stored. Maps to `memory_patch` keys from the response.
5. **Rive file size cleanup** — `intro.riv` ~4.4 MB, `eli.riv` ~3.3 MB. Both exceed the 800 KB hard ceiling. Cleanup pass needed before any hardening work.
