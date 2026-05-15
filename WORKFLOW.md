# Workflow — Daily Process and Asset Pipeline

How a feature flows from idea → Rive → repo → Codex → build → device. Read this before starting a sprint.

---

## 1. The five-step loop

```
1. SPEC      Update RIVE_SPEC.md / README.md with the new contract.
2. AUTHOR    Build / edit the .riv in Rive editor. Test in preview.
3. EXPORT    Drop the .riv into public/rive/. The watcher updates the manifest.
4. CODE      Hand a scoped task to Codex referencing the spec.
5. VERIFY    npm run check → run on simulator → smoke-test the slice.
```

Every change goes through this loop. Skipping spec-first is the #1 cause of drift.

---

## 2. Repo layout for an asset-heavy game

```
Prototype-4/
├── README.md                        ← the contract
├── RIVE_SPEC.md                     ← Rive contract
├── RIVE_GUIDE.md                    ← Rive craft
├── WORKFLOW.md                      ← this file
├── CODEX_FIRST_PROMPT.md            ← sprint-1 kickoff
│
├── public/
│   ├── rive/                        ← .riv binaries (per RIVE_SPEC §file structure)
│   │   ├── eli.riv
│   │   ├── scenes/
│   │   │   ├── intro.riv
│   │   │   ├── body.riv
│   │   │   └── ...
│   │   ├── extractions/
│   │   │   ├── heart_run.riv
│   │   │   └── ...
│   │   └── ui/
│   │       ├── hud.riv
│   │       └── transitions.riv
│   │
│   ├── audio/
│   │   ├── voice/
│   │   │   └── eli/
│   │   │       ├── intro_01.opus
│   │   │       └── ...
│   │   ├── sfx/
│   │   │   ├── heartbeat_loop.opus
│   │   │   └── ...
│   │   └── music/
│   │       └── title_loop.opus
│   │
│   └── images/                      ← only for non-Rive UI (favicon, splash)
│
├── src/
│   ├── content/
│   │   ├── strings.ts               ← all user-facing copy, keyed by ID
│   │   ├── dialogue.ts              ← Eli's voice lines: ID → text + audio key
│   │   └── scripts/                 ← scene-by-scene narrative scripts (TS data)
│   ├── rive/
│   │   ├── contract.ts              ← TS mirror of RIVE_SPEC.md
│   │   └── manifest.ts              ← AUTO-GENERATED. do not hand-edit.
│   ├── audio/
│   │   ├── manifest.ts              ← AUTO-GENERATED.
│   │   ├── AudioBus.ts
│   │   └── tracks.ts
│   ├── scenes/
│   ├── components/
│   ├── hooks/
│   ├── state/
│   ├── types/
│   └── App.tsx
│
├── scripts/
│   ├── watch-rive.mjs               ← regenerates src/rive/manifest.ts
│   ├── watch-audio.mjs              ← regenerates src/audio/manifest.ts
│   ├── encode-audio.mjs             ← raw → opus pipeline (ffmpeg)
│   └── asset-budget.mjs             ← fails CI if scene budgets are blown
│
├── tasks/                           ← one .md per Codex sprint
│   ├── 001-scaffold-minute-one.md
│   ├── 002-body-scene.md
│   └── ...
│
└── design/                          ← source files NOT shipped to the app
    ├── audio-raw/                   ← .wav voice recordings before encoding
    ├── reference/                   ← mood boards, sketches
    └── notes/
```

The `design/` folder is for source assets you don't ship — raw audio, reference images, Rive editor backups. It's git-ignored by default. Keep your source-of-truth files there.

---

## 3. Adding a new `.riv` — the actual sequence

You want to add a new scene called `dream`. Here's exactly what happens:

1. In `RIVE_SPEC.md`, add a new section `### scenes/dream.riv` with the artboard name, state machine name, all inputs, all text runs.
2. In the Rive editor, build the scene. Naming inside Rive must match what you just wrote in the spec.
3. Export to `public/rive/scenes/dream.riv`.
4. Run `npm run dev` (if not already running). The watcher regenerates `src/rive/manifest.ts`. You'll now see `RIVE.scenes_dream` available in TypeScript.
5. Open a Codex task pointing at the spec section and the existing `scenes/Intro/` for style reference. Codex writes `scenes/Dream/index.tsx` and wires it up.
6. Verify in browser, then `npx cap sync && open` on iOS / Android.

Notice: you never edit `src/rive/manifest.ts` by hand. You never tell Codex "the file is at `/rive/scenes/dream.riv`" — you say "use `RIVE.scenes_dream`."

---

## 4. Audio pipeline

Audio is the second biggest asset category. Treat it with the same discipline as Rive.

**Source → ship flow:**

```
design/audio-raw/eli/intro_01.wav     ← Jeff records / receives raw
            │
            ▼ scripts/encode-audio.mjs (ffmpeg, opus, 32kbps mono)
            │
public/audio/voice/eli/intro_01.opus  ← shipped
            │
            ▼ scripts/watch-audio.mjs
            │
src/audio/manifest.ts                 ← AUTO. types like AUDIO.eli.intro_01
```

**Encoding rules (in `scripts/encode-audio.mjs`):**

| Type | Codec | Bitrate | Channels | Notes |
|---|---|---|---|---|
| Voice (Eli, narration) | Opus | 32 kbps | mono | Volume-normalized to -16 LUFS |
| SFX | Opus | 64 kbps | mono | Short loops; pad ends with 5ms silence |
| Music | Opus | 96 kbps | stereo | Crossfade-ready loops |
| iOS-only fallback | AAC at same bitrate | — | — | Only if Opus breaks on older iOS |

**Why Opus over MP3:** smaller files at same quality, supported by every modern browser and WebView, royalty-free.

**Why `.opus` files in `public/`:** Capacitor serves them statically; AudioBus references by ID. Never reference by path in scene code.

---

## 5. Copy, strings, and dialogue

All user-facing text lives in `src/content/strings.ts`:

```ts
export const STR = {
  intro: {
    listen_prompt:   'Listen.',
    touch_prompt:    'He can feel where you touch.',
    cta:             'STAY WITH ELI',
    title_main:      'ELI',
    title_sub:       'LAST EXPERIMENT',
  },
  body: { ... },
} as const;
```

All Eli voice lines live in `src/content/dialogue.ts`:

```ts
export const DIALOGUE = {
  eli_intro_01: {
    audio: 'voice.eli.intro_01',           // key into AUDIO manifest
    subtitle: 'I thought… nobody could hear me. Are you really there?',
    mood: 1,
    duration_ms: 4200,
  },
  // ...
} as const;
```

**Why this matters:**
- One file to scan for tone consistency
- Localization is a one-day job, not a one-month job
- Codex never invents copy — it references a key
- Subtitles are guaranteed to be present for every line

---

## 6. The manifest pattern (the heart of "drop and go")

Every asset category has the same pattern:

| Folder | Watcher | Generates |
|---|---|---|
| `public/rive/` | `scripts/watch-rive.mjs` | `src/rive/manifest.ts` |
| `public/audio/` | `scripts/watch-audio.mjs` | `src/audio/manifest.ts` |
| `src/content/` | (handwritten, no watcher needed) | — |

Each manifest is a typed `const` object. Each key is the asset path-ified. Each value is the URL plus a sha1 query string for cache-busting.

When you drop a new file, the manifest grows. When you delete one, it shrinks. When TypeScript breaks somewhere because a key disappeared, you know exactly what depended on the missing asset.

**Never reference an asset by raw path in scene code.** Always go through the manifest.

---

## 7. Asset budgets — enforced

`scripts/asset-budget.mjs` runs in CI and pre-commit. It reports:

```
scene: intro     rive: 312 KB  audio: 184 KB  total: 496 KB ✓ (budget 800 KB)
scene: body      rive: 480 KB  audio: 220 KB  total: 700 KB ✓
scene: heart_run rive: 612 KB  audio: 180 KB  total: 792 KB ✓
TOTAL ALL SCENES        1.86 MB ✓ (budget 8 MB)
```

If a scene blows its budget, the commit fails. This forces you to make the call early — *re-author the Rive file*, *re-encode the audio*, or *raise the budget intentionally*.

Budget per scene (default): 800 KB. Total game ceiling for prototype: 8 MB.

---

## 8. Working with Codex — task discipline

Codex is at its best when you hand it **one PR-shaped task** with explicit boundaries. Here's the template every task file in `tasks/` should follow:

```markdown
# Task NNN — <short name>

## Goal
One sentence. What does done look like?

## Scope (in)
- Concrete list of files Codex may create/modify
- Concrete behaviors it must implement

## Scope (out)
- What Codex MUST NOT touch this round
- Open questions it must not invent answers to

## Spec references
- README.md §X
- RIVE_SPEC.md §Y
- DIALOGUE keys: eli_intro_01, eli_intro_02

## Acceptance
- `npm run check` passes
- Manual: open <url> → tap waveform → see subtitle → audio plays → ...
- No new dependencies without justification

## Stop-and-ask triggers
- If a Rive input is missing
- If a string key doesn't exist
- If audio asset isn't in the manifest
```

**Three rules for keeping Codex on the rails:**

1. **One task = one concern.** Don't combine "add new scene" with "refactor audio bus." Split them.
2. **Reference, don't restate.** Tell Codex *which section of the spec* applies; don't paste the spec into the task.
3. **Define "done" in verifiable terms.** "Looks good" is not done. "Tapping the heart three times advances `phase` to 2 and triggers `eli_intro_02` audio" is done.

---

## 9. PR / commit conventions

Every change touches one of these "lanes":

- `spec:` — README/RIVE_SPEC/RIVE_GUIDE/WORKFLOW edits only
- `rive:` — `.riv` binary changes only
- `audio:` — audio asset changes only
- `content:` — strings/dialogue/scripts only
- `code:` — TS code changes only
- `infra:` — scripts, vite config, capacitor config
- `chore:` — anything else (lint, deps, formatting)

PR title: `lane: short imperative` — e.g. `code: implement intro scene`, `rive: rebuild eli idle breath`.

Don't mix lanes in one PR unless the change *requires* it (e.g. spec change + the code change that implements it).

---

## 10. Daily rhythm — a suggested loop

A productive day looks like:

1. **Morning, 30 min — design pass.** Open Rive. Sketch the next scene. Note inputs in `RIVE_SPEC.md`.
2. **Midday, 1–2 hr — author in Rive.** Build the scene, polish state machine, export.
3. **After lunch, 15 min — write the Codex task.** Use the template in §8. Save to `tasks/`.
4. **Afternoon, async — Codex works.** You go review yesterday's PR, record voice lines, sketch the next scene.
5. **End of day — verify on device.** Build, run on a real phone for 5 minutes. Note bugs in `tasks/` for tomorrow.

The trap to avoid: **iterating on Rive while Codex is working on code that depends on the spec.** Pick one or the other. If you change the spec mid-task, Codex will produce mismatched code and you'll waste a session.

---

## 11. Reviewing Codex's output

For every Codex PR, check in this order:

1. **Did it stay in scope?** Files touched ≤ files in scope (in).
2. **Did it follow the spec?** No invented Rive inputs, no invented audio keys, no invented strings.
3. **Does `npm run check` pass?** Don't merge red.
4. **Does the slice work end-to-end on device?** Web preview is necessary but insufficient. Always device-check.
5. **Are budgets still met?** Bundle size, frame rate, asset weight.
6. **Is the code idiomatic?** Hooks-only, strict TS, no `any`, named exports match file names.

If any check fails, comment on the PR with the specific failure and the spec section it violates. Don't fix it yourself — make Codex iterate. That's how it gets better at your conventions over time.

---

## 12. When to pause and refactor

Stop adding scenes and refactor when you hit any of these:

- 3+ scenes share a copy-pasted block (it should be a component)
- `RIVE_SPEC.md` and the actual `.riv` files have drifted (spec week)
- A single scene blows its asset budget twice in a row (re-author Rive)
- Frame rate drops below budget on the test device (perf week)
- The strings file has stale or orphaned keys (copy cleanup)

Refactor sprints should be explicit tasks in `tasks/`, not snuck into feature work.
