# Rive Contract — names the code expects

Keep this file open while working in Rive Studio. Every name below is matched
**exactly** (case-sensitive) by the player/editor. Renaming one of these in
Rive Studio without updating the scene config silently breaks that feature.

## Where .riv files live (one canonical copy each)

| File | Used by | Rule |
|------|---------|------|
| `public/rive/eli.riv` | Every scene with `rive: "shared"` | The ONLY copy of Eli. Replace via the editor's "↑ Upload shared eli.riv" button. |
| `games/<game>/scenes/<scene>/<name>.riv` | That scene only (`rive: "<name>.riv"`) | Replace via the scene's "Replace" upload button. |

Never hand-copy a .riv into two places — the editor uploads put it where the
player reads it and bust the preview cache.

## State machine inputs the code drives (lip sync / markers)

Set on the state machines listed in the scene's `stateMachines` (scene.json).

| Input name | Type | Driven by | Values |
|------------|------|-----------|--------|
| `mouth_shape` | Number | Lip-sync markers; reset to 0 when audio stops | 0 = Idle/closed … 18 (see mouth table below) |
| `is_speaking` | Boolean | true while `mouth_shape` > 0 | — |
| `emotion_state` | Number | Markers | 0 Neutral, 1 Sad, 2 Happy, 3 Angry, 4 Surprised, 5 Confused, 6 Remembering, 7 Scared, 8 Tired, 9 Eyes Closed |
| `body_movement` | Number | Markers (also mirrored into `nav_heart`) | see body table below |
| `head_movement`, `head_state` | Number | Markers (same value sent to both) | see head table below |
| `heart_state` | Number | Markers | see heart table below |

Mouth shape values: 0 Idle · 1 A E I · 2 B M P · 3 C D G K · 4 CH SH J · 5 EE ·
6 F V · 7 L · 8 O · 9 Q W · 10 R · 11 TH · 12 U · 13 Smile · 14 Sad · 15 Angry ·
16 Laugh · 17 Surprised · 18 Confused

Head values (`head_movement` / `head_state`): 0 Idle · 1 Look Up · 2 Look Down ·
3 Look Left · 4 Look Right · 5 Nod (Yes) · 6 Shake (No) · 7 Tilt · 8 Turn Away

Body values (`body_movement`): 0 Idle · 3 Breathe · 4 Shiver · 5 Reach · 6 Curl ·
7 Float · 8 Shake · 9 Lean In · 10 Lean Back · 11 Twitch · 12 Pulse · 13 Sway ·
14 Collapse · 15 Rise · 16 Tremble · 17 Move Left Arm
(1–2 are retired — they were Heart Glow/Pain, now on the heart track)

Heart values (`heart_state`): 0 Idle · 1 Glow · 2 Fast · 3 Pain · 4 Slow ·
5 Warm · 6 Flicker · 7 Race · 8 Stop

## Navigation — inputs and events the code LISTENS to

| Name pattern | Kind | What happens |
|--------------|------|--------------|
| `nav_<sceneId>` | Bool/Trigger input **or** Rive event | Navigates to scene `<sceneId>` (must exist in sequence.json), unless remapped in SCENE CONNECTIONS |
| `<routeName>` from ctaRoutes | Input or Rive event | Navigates per the editor's SCENE CONNECTIONS panel |
| `<numberInput>` = N | Number input | Routes via connection key `<numberInput>_N` (e.g. `next_scene` = 2 → route `next_scene_2`) |
| custom `after.trigger` name | Input or Rive event | Fires the scene's FALLBACK navigation |
| state named `exit` | State machine state | Entering it advances to `after.next` (or next scene in sequence) |

## Haptics (Android only)

| Name pattern | Kind | Effect |
|--------------|------|--------|
| `haptic_<preset>` | Boolean input (auto-reset) or Rive event | Vibrates with `<preset>` (e.g. `haptic_heartbeat`) |
| `vibration` / `vabiration` | Boolean input (legacy) | Heartbeat vibration |

## Per-scene config (scene.json, edited in the editor)

- `artboard` — must exist in the .riv file (editor shows detected names as chips)
- `stateMachines` — must exist on that artboard; inputs are only found on the
  machines listed here. Shared-eli fallback when empty:
  `EliState, EliBody, FacialState, EmotionState`

## When you rename something in Rive Studio

1. Re-export and upload through the editor (never Finder-copy).
2. Open the scene — the **Rive check** row under State machines flags any
   configured names or expected inputs the new file is missing.
