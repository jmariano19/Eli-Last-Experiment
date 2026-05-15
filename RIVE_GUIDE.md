# Working in Rive — Authoring Guide

This is for **Jeff (the author)**. It covers how to structure files in the Rive editor, how to set up state machines that scale, and what to check before exporting.

The companion document `RIVE_SPEC.md` is the *contract*. This document is the *craft*.

---

## 1. The mental model

There are two things called "Rive":

1. **The Rive editor** (cloud, web-based). Your team's account holds the source files. Think of this like Figma.
2. **The `.riv` runtime file** you export and drop into `public/rive/`. Think of this like a `.glb` or `.mp4` — a binary the app loads at runtime.

Rule of thumb: **the editor is the source of truth, the `.riv` is the build artifact.** Never edit a `.riv` directly. Never assume git history is enough to reconstruct an animation — back up the editor files weekly.

---

## 2. File-per-thing strategy

For a game with many assets, the question is always "one big file or many small ones?"

**Use this split:**

| Goes in `eli.riv` (one shared character file) | Goes in scene-specific `.riv` files |
|---|---|
| Eli's body, organs, face | Backgrounds, environments |
| All organ states (heart, lungs, brain, etc.) | Scene-specific UI (buttons, prompts) |
| Mood + body transformation state machines | Scene transitions |
| The "x-ray" treatment | Extraction-run mechanics |
| Idle breathing animations | Run-specific visuals |

**Why:** Eli must be visually consistent across every scene, and his transformation must be authored *once*. Putting him in his own `.riv` and compositing scenes around him via React layout means a change to Eli propagates everywhere automatically. Scenes stay light because they don't carry his weight.

**Rule:** if you find yourself copying Eli into a second `.riv` file, stop. The duplication will bite you in week three.

---

## 3. Artboards: one per *view of the same thing*

Inside `eli.riv`, use multiple artboards if you need different *framings* of Eli:

- `Eli` — full body, standard pose (the default)
- `EliClose` — chest-up close-up (for tender moments)
- `EliXray` — anatomical detail (for organ-focused scenes)

Each artboard has its own state machine. They share the same source artwork via **Solos** and **Components** inside Rive — don't redraw him three times.

Inside scene files (e.g. `intro.riv`), use *one* artboard called `Title` or `Body` etc. Don't make scenes multi-artboard unless you have a strong reason.

---

## 4. State machine architecture

For a complex character like Eli, **do not put everything in one state machine.** It becomes unreadable and inputs collide.

Use **multiple state machines per artboard**, each on its own concern:

```
Artboard: Eli
├── EliState         ← the main one app code talks to (the contract)
├── BreathLoop       ← idle breathing, always playing
└── MoodOverlay      ← facial micro-expressions on top of everything
```

**Layering rules:**
- The app *names* one state machine in `RIVE_SPEC.md` per artboard as the public interface. That's `EliState`. The others are internal — they autoplay and react to inputs *on the public one*.
- Internal state machines can read inputs from the public one. They cannot have their own inputs that code touches.
- Animations longer than 2 seconds belong in a state machine. Shorter ones can be raw animations triggered directly, but prefer state machines for consistency.

---

## 5. Naming discipline

This is the part that determines whether Codex can do its job.

- **One name for one thing, everywhere.** If the Rive input is `tap_heart`, the listener is `hit_heart`, the audio cue is `tap_heart`, the SFX file is `tap_heart.opus`, the gameStore action is `tapHeart`. Different cases per language convention, but the *root word* is identical.
- **Never rename without updating `RIVE_SPEC.md` in the same change.** Renames are the #1 source of "why doesn't this work" bugs.
- **Reserved prefixes:**
  - `tap_` = player-initiated trigger
  - `cue_` = code-initiated trigger
  - `hit_` = listener (hit area)
  - `is_` = boolean input
  - everything else = number input (use suffixes like `_pulse`, `_state`, `_level` for clarity)
- **No numeric IDs in names.** `heart_run` not `extraction_3`. The number means nothing six months later.

---

## 6. Inputs vs. listeners vs. events

You have three ways to make Rive respond to user input. Use them deliberately.

| When to use | Mechanism |
|---|---|
| Player taps a visible thing inside the artboard (heart, button, waveform) | **Listener** (`hit_*`) — fires a trigger input automatically |
| Code wants the animation to do something (audio finished, timer expired) | **Trigger input** fired from code |
| Continuous value (slider, intensity, time remaining) | **Number input** set from code |
| On/off state (CTA visible, listening mode) | **Boolean input** set from code |

**Avoid Rive Events** unless you have a use case the inputs above can't handle. Events are powerful but they make the contract harder to type and reason about. For this project: inputs only, with one exception — when an animation finishes and code needs to know, use an event. Document it in `RIVE_SPEC.md`.

---

## 7. Performance hygiene inside Rive

Before you export, check:

| Check | Rule |
|---|---|
| File size | Single `.riv` ≤ 500 KB (target), ≤ 800 KB (hard ceiling). If you blow past 500 KB and there's no raster, look for excessive mesh density or animation length. |
| Gradients | Max 4 stops per gradient. Each extra stop is a per-frame cost. |
| Mesh vertices | Max ~500 per character mesh. Bones beat dense meshes. |
| Blur / glow effects | Avoid entirely if possible. They're the most expensive thing on mobile WebGL. Fake glow with a soft-edged sprite. |
| Animated trim paths | Acceptable for short bursts; avoid in idle loops. |
| Raster images | Avoid entirely if you can. If you must, pre-compress to ≤80% JPG quality, ≤512×512, and check the size impact in Rive's export dialog. |
| Animation length | Trim trailing empty frames. A 4-second clip that's effectively 1 second of motion is still a 4-second animation in memory. |
| Unused animations | Delete them. Rive bundles them all. |
| Hidden layers | Delete them. Same reason. |

**Rule of thumb:** if Rive's preview drops below 60fps on your laptop, it will be worse on a mid-tier Android phone.

---

## 8. Idle is sacred

Every artboard's state machine must start in an *idle* state with a subtle, looping animation — never a frozen pose, never a black frame. For Eli, that's the breathing loop. For the title screen, it's the slow pulse of the central glow.

The reason isn't visual — it's psychological. Frozen characters feel dead. Even a 2px chest rise every 4 seconds tells the player "he's alive, he's waiting."

---

## 9. Tap reactions must complete in 600ms or less

For everything the player taps, the *full feedback animation* — start, peak, return-to-idle — should be under 600ms. Longer than that and tapping feels laggy.

If you need a long animation as a reaction (e.g. a 3-second tender moment after the player taps the heart three times), separate it: a short ack animation (≤200ms), then the longer narrative animation triggered as a follow-up.

---

## 10. Components and Nested Artboards

Rive supports nesting artboards. Use it for:
- Buttons (one `Button` artboard, instantiated wherever you need a button)
- The waveform (a `Waveform` component that pulses)
- HUD elements

Don't use it for Eli — Eli is composited at the React layer because he needs to persist across scenes.

For Components specifically: build a small library inside `eli.riv` and `ui.riv` rather than redrawing the same button five times.

---

## 11. Audio: keep it out of Rive

**Never embed audio in `.riv` files.** All audio plays through the app's `AudioBus`. Rive fires triggers (e.g. `tap_heart` was hit), code decides which audio to play, which channel, with what ducking and mixing.

Why: platform audio behavior on iOS WKWebView is finicky, you need precise mixing control, and audio in `.riv` would mean re-exporting to swap a sound effect.

---

## 12. Text: text runs only

All on-screen text inside Rive goes through **Text Runs** (named, runtime-settable). Never bake English text into a graphic layer. This matters for:
- Updating copy without re-exporting
- Localization later
- Accessibility (we can mirror the same string to an aria-live region in the DOM)

---

## 13. Before-you-export checklist

Each time you export a `.riv`:

- [ ] Artboard names, state machine names, input names, text run names all match `RIVE_SPEC.md` exactly
- [ ] No unused animations, hidden layers, or stale assets in the file
- [ ] File size in the export dialog is under budget
- [ ] State machine preview tested at multiple input values, especially the extremes (0 and 100 on number inputs)
- [ ] All `tap_*` listeners actually trigger their inputs (test in preview)
- [ ] Idle state plays automatically on load
- [ ] No frame jumps when transitioning between states
- [ ] Exported as **runtime** `.riv`, not the editor file

Then commit the binary into `public/rive/` and let the watcher do its job.

---

## 14. Backup the editor files

Rive cloud has revision history, but for a project this size:
- Once a week, export the editor's project archive (Rive lets you download the source) and drop it into `/Users/jeff/.../Prototype-4-RiveBackups/` (NOT inside the git repo — too big).
- Tag backups with date: `2026-05-11_eli-rive-backup.zip`.
- Before any major refactor in Rive, take a backup first.
