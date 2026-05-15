# Rive Authoring Contract

This document is the **single source of truth** for everything Rive exposes to the application code. If a value is not listed here, the code will not use it. If you (Jeff) add a new input in the Rive editor, add it to this file in the same commit.

Codex mirrors this document in `src/rive/contract.ts` as TypeScript types.

---

## Naming rules

| Thing | Case | Example |
|---|---|---|
| Artboard | PascalCase | `Eli`, `Title`, `HeartRun` |
| State machine | PascalCase, suffix `State` | `EliState` |
| Input | snake_case | `heart_pulse`, `tap_waveform` |
| Text run | snake_case | `eli_subtitle` |
| Animation (for direct play, rare) | snake_case | `idle_breath` |
| Bone | snake_case | `arm_l_upper` |
| Listener (hit area) | snake_case, prefix `hit_` | `hit_heart`, `hit_waveform` |

Trigger inputs: prefix `tap_` for player-initiated, `cue_` for code-initiated.

---

## Per-file specs

### `intro.riv`

**Artboard: `Title`** — **1080 × 2400 px** (portrait). Critical content within centered safe area 1080 × 1920. Runtime fit: Cover.

State machine: `TitleState`.

| Input | Type | Range / values | Purpose |
|---|---|---|---|
| `phase` | number | 0 → 3 | 0 = black, 1 = waveform, 2 = body reveal, 3 = title + CTA |
| `waveform_active` | boolean | — | Pulses the voice-memo waveform |
| `tap_waveform` | trigger | — | Player tapped the listen prompt |
| `tap_heart` | trigger | — | Player tapped Eli's heart |
| `heart_steadiness` | number | 0 → 100 | Drives heart visual from frail to calm |
| `cta_visible` | boolean | — | Reveals the STAY WITH ELI button |
| `tap_cta` | trigger | — | Player accepted the contract |

Text runs:
- `subtitle` — current caption line
- `title_main` — usually "ELI"
- `title_sub` — usually "LAST EXPERIMENT"
- `cta_label` — usually "STAY WITH ELI"

Listeners (hit areas):
- `hit_waveform`
- `hit_heart`
- `hit_cta`

Animations available to code (only if needed outside the state machine):
- `breathe_loop` (idle)

---

### `eli.riv`

**Artboard: `Eli`** — the canonical body, reused across scenes.

State machine: `EliState`.

| Input | Type | Range / values | Purpose |
|---|---|---|---|
| `heart_pulse` | number | 0 → 100 | Pulse intensity + color shift |
| `lungs_pulse` | number | 0 → 100 | Breath depth + visible ribcage motion |
| `brain_pulse` | number | 0 → 100 | Subtle glow at temples |
| `eyes_state` | number | 0 → 2 | 0 = closed, 1 = open, 2 = searching |
| `mouth_state` | number | 0 → 3 | 0 = neutral, 1 = whisper, 2 = small smile, 3 = pained |
| `body_state` | number | 0 → 2 | 0 = frail, 1 = steady, 2 = uncanny |
| `mood` | number | 0 → 4 | 0 = anxious, 1 = calm, 2 = trusting, 3 = dependent, 4 = questioning |
| `tap_heart` | trigger | — | Player tap event |
| `tap_lungs` | trigger | — | Player tap event |
| `tap_brain` | trigger | — | Player tap event |
| `cue_speak` | trigger | — | Sync mouth to playing voice line |
| `listening` | boolean | — | Subtle "I hear you" micro-animation |

Text runs:
- `eli_subtitle` — what Eli is saying right now

Listeners:
- `hit_heart`, `hit_lungs`, `hit_brain`

Design notes:
- Heart, lungs, brain are visible through a soft X-ray treatment when their pulse > 0.
- `body_state` should drive a *visible silhouette* difference, not just a color tint. The player must see the transformation.
- All organ tap reactions must complete within 600 ms — feedback latency is the whole point.

---

### `extraction/heart_run.riv` (and lungs_run, brain_run)

**Artboard: `HeartRun`** (etc.) — 1080 × 2400 px (same conventions as Title).

State machine: `RunState`.

| Input | Type | Range / values | Purpose |
|---|---|---|---|
| `time_remaining` | number | 0 → 180 | Seconds left in this run |
| `resource_collected` | number | 0 → 100 | Visual fill of what's been gathered |
| `risk_level` | number | 0 → 3 | 0 = safe, rising to 3 = imminent failure |
| `choice_available` | boolean | — | Show the choice prompt |
| `tap_choice_a` | trigger | — | Player picked the cautious option |
| `tap_choice_b` | trigger | — | Player picked the risky option |
| `cue_complete` | trigger | — | Run succeeded, play exit anim |
| `cue_fail` | trigger | — | Run failed, play exit anim |

Text runs:
- `prompt` — the question (e.g., "What will you give up to save him today?")
- `option_a`, `option_b`

Listeners:
- `hit_choice_a`, `hit_choice_b`

---

## How Codex uses this file

1. When this file changes, Codex regenerates `src/rive/contract.ts` to match. The types should look like:

```ts
export const RIVE_CONTRACT = {
  intro: {
    artboard: 'Title',
    stateMachine: 'TitleState',
    inputs: {
      phase: 'number',
      waveform_active: 'boolean',
      tap_waveform: 'trigger',
      tap_heart: 'trigger',
      heart_steadiness: 'number',
      cta_visible: 'boolean',
      tap_cta: 'trigger',
    },
    textRuns: ['subtitle', 'title_main', 'title_sub', 'cta_label'],
  },
  // ...
} as const;
```

2. Every call to `useStateMachineInput` is wrapped in a typed helper that validates the input name against this contract at compile time. No raw strings in scene code.

3. If a scene tries to use an input that isn't in the contract, TypeScript fails the build.

---

## Authoring checklist (Jeff, before exporting `.riv`)

- [ ] Artboard name matches this spec exactly
- [ ] State machine name matches this spec exactly
- [ ] All inputs named here exist with the correct type
- [ ] Text runs are present and named
- [ ] Listeners use the `hit_` prefix
- [ ] Default values for number inputs are 0
- [ ] No animations longer than necessary — trim end frames
- [ ] File size shown in Rive's exporter is under the budget in `README.md §5`
- [ ] No raster images embedded unless unavoidable (and pre-compressed if so)
- [ ] One artboard per file unless they share assets meaningfully
- [ ] Tested at 60 fps in Rive's preview at 1x and 2x scale

Then: export `.riv` (runtime, not editor file) → drop into `public/rive/`. The watcher does the rest.
