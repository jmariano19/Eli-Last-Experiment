# The Give Ritual — hold-to-give a memory fragment

The missing Treat beat. Sits between a mini-game win and the chat opener that
is already wired (`consumeRecovery` → Eli speaks first). The player carries the
fragment back and presses it into Eli's heart. The game never gives it for them.

Flow: pairs/jigsaw win → **GIVE ritual** → chat (Eli notices, speaks first)

The fragment is the gift; the hold is the care; Eli's reaction is the reward.
No score, no particles explosion, no "+1 memory" toast — ever.

---

## States

```
ARRIVE → INVITE → HOLDING ⇄ RELEASED-EARLY
                     ↓
                 COMPLETE → EXIT (chat)
```

### 1. ARRIVE (0–2s)
Eli center frame, dim. Heart at `heart_state = 6` (Flicker) — alive but low.
The fragment: a single warm ember (~40px) drifting near the bottom of the
screen, slow float, soft pulse in sync with nothing — it's not his rhythm yet.
No UI, no text.

### 2. INVITE (at ~2s)
One whisper line fades in, lowercase, small (existing caption style):
> "he can't take it himself."

Fragment drifts slightly toward Eli, then settles. Heart flickers a touch
faster. If the player does nothing for 10s, repeat the whisper once. Never
add an arrow or pulsing ring — trust them.

### 3. HOLDING (player presses the heart zone)
- Trigger: `pointerdown` on the heart area (reuse the exact hold pattern from
  `playMemoryScene`, main.js ~1876–1928: rAF progress, cancel on
  pointerup/leave/cancel).
- Duration: **3200ms** (config `holdMs`, min 800 — same convention as memory room).
- During the hold:
  - Fragment glides to the chest over the first ~600ms, then sinks in gradually
    with progress (scale down + opacity into the glow).
  - Heart: `heart_state = 1` (Glow), brightening with progress if you author a
    blend (see Rive section).
  - Eli: `body_movement = 3` (Breathe), slow.
  - Haptics: `tap` on press, then `heartbeat` at 0ms / 1200ms / 2400ms —
    three beats, like his pulse steadying under their hand.
- Progress display: the chest glow itself IS the progress bar. No radial timer.

### 4. RELEASED-EARLY (release before 3200ms)
Not failure — information (Slide 6). Fragment eases back out to its float
position over ~400ms. Heart returns to Flicker. Progress resets to 0.
Optional whisper after 2 early releases: "gently. all the way."
No shake, no red, no error sound.

### 5. COMPLETE (at 3200ms)
In order, timed:

| t (ms) | What happens |
|---|---|
| 0 | Haptic `soft`. Fragment fully absorbed. |
| 0 | `heart_state = 5` (Warm) |
| 400 | `emotion_state = 6` (Remembering), eyes follow |
| 800 | `body_movement = 15` (Rise) — he straightens, barely |
| 1600 | `body_movement = 3` (Breathe) — steadier than before |
| 2200 | Whisper: "..." (one beat of silence is the reaction) |
| 3000 | Fade to chat scene |

### 6. EXIT
Load the chat scene. The existing `consumeRecovery()` hook fires and Eli's
first line references the fragment. **Important:** the ritual must NOT consume
the recovery record itself — it reads the fragment name for display only
(`localStorage eli.recovered.<game>`, read without removing). The chat scene
remains the consumer.

---

## Timings summary

| Thing | Value | Why |
|---|---|---|
| Arrive → invite whisper | 2000ms | let the frame breathe first |
| Hold duration | 3200ms | long enough to be deliberate, short enough to repeat daily |
| Heartbeat haptics during hold | at 0 / 1200 / 2400ms | three steadying beats |
| Early-release ease-out | 400ms | soft, non-punitive |
| Complete → chat fade | 3000ms | his reaction must land before dialogue |

## Haptics (existing presets only, per RIVE-CONTRACT)

`tap` (press start) → `heartbeat` ×3 (during hold) → `soft` (complete).
No `buzz`, no `strong` — this is a vigil, not a slot machine.

## Rive — what to author in Rive Studio

Everything below uses names already in RIVE-CONTRACT.md; only one input is new.

| Input | Existing? | Used for |
|---|---|---|
| `heart_state` 6 Flicker / 1 Glow / 5 Warm | yes | dim → charging → after |
| `emotion_state` 6 Remembering | yes | eyes at COMPLETE |
| `body_movement` 3 Breathe / 15 Rise | yes | during hold / at COMPLETE |
| `give_progress` (Number 0–100) | **new, optional** | blend chest-glow intensity with hold progress |

If you add `give_progress`, author it as a 1D blend on the heart glow
(0 = flicker-dim → 100 = full warm) on the `EliState` machine, and add it to
RIVE-CONTRACT.md. Without it, the code steps `heart_state` 6 → 1 → 5 and the
ember visual carries the progress — acceptable for the first build.

The ember itself can be plain DOM/CSS (like the memory-room objects), no Rive
needed: a radial-gradient div with a slow float keyframe. Cheaper to iterate.

## Code plan (when you're ready — reuses what exists)

1. New function `playGiveRitual(config)` in main.js, modeled line-for-line on
   the memory-room hold (startHold/cancelHold/updateHold/finishHold,
   ~1876–1928) but over the shared Eli rive canvas.
2. Entry point: in `playChatScene`, before enabling the chat form — if
   `localStorage eli.recovered.<game>` exists and is fresh, run the ritual
   first, then proceed (the existing auto-opener then consumes the record).
   This means **no new scene type and no sequence changes** — the ritual is a
   pre-roll on chat whenever a fragment is waiting.
3. Config lives on the chat scene: `"give": { "holdMs": 3200, "hint": "he can't
   take it himself." }` — editable in the editor later.
4. Skip conditions: no fresh recovery → straight to chat (no empty ritual);
   segment/voice chat scenes → skip (same guard as the auto-opener).

## Edge cases

- Release early N times: never lock out, never time out. They can sit there.
- App backgrounded mid-hold: treat as release-early.
- Reduced motion (`prefers-reduced-motion`): keep timings, drop the float
  animation; fragment fades instead of glides.
- Two wins before one chat (pairs + jigsaw same day): last one wins —
  single-fragment record is by design; one gift per visit.
- Android-only haptics (existing constraint) — the visual glow must carry the
  feeling on iOS by itself. Test on iPhone with sound off.

## Tone guardrails (from the deck)

- Slide 2 test: vigil, not slot machine. If any part of this feels "juicy,"
  reduce it.
- Slide 6: early release is information, not punishment.
- Slide 10: would you be embarrassed if a player saw the system behind it? A
  hold timer disguised as care would embarrass; a hold that IS care doesn't
  need disguising. Keep the chest-glow honest — no fake difficulty.
- Beat 5 belongs to the chat opener, not the ritual. Resist adding dialogue
  here; his body reacting is enough. The words come after.
