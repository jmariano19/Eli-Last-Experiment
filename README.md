# Eli's Last Experiment — Prototype 9

An interactive narrative game with a Rive-animated character (Eli), voice-acted
scenes with lip sync, and AI-driven chat powered by Claude. Includes a visual
editor for building scenes without touching code.

## Quick start

Double-click **`Start Editor.command`**, or run:

```
npm start
```

This stops any stale server, starts a fresh one, and opens the editor in your
browser. The terminal also prints a LAN URL for testing on your phone.

- Editor: http://localhost:4179/editor.html
- Game:   http://localhost:4179/index.html
- Testing reset: append `/reset-testing` to the deployed site address to clear
  Eli's shared player memory and begin a fresh participant session.

For AI chat scenes, create a `.env` file with `ANTHROPIC_API_KEY=sk-ant-...`
(optional: `CHAT_MODEL=` to override the model).

## Project layout

```
games/<game-id>/          One folder per game (use the header switcher to change)
  sequence.json           Scene order, start scene, game title
  scenes/<scene-id>/
    scene.json            Scene config (type, rive file, routes, segments…)
    <name>.riv            Scene-specific Rive file (optional; 'shared' uses public/rive/eli.riv)
    audio/                Voice lines, background audio, video, *.lipsync.json
    .backups/             Last 10 saved versions of scene.json (auto)
games/games.json          Which game the deployed player serves ("default")
public/rive/eli.riv       Shared character file used by scenes with rive: "shared"
src/main.js               Game player
src/editor.js             Editor
local-server.mjs          Server: static files + editor/chat APIs
start.mjs                 Launcher (port cleanup, auto-restart, auto-open)
```

## Scene types

- **rive** — animated character, voice lines with lip-sync markers, text cues,
  and multi-part *segments* (voice, AI chat, silence, or full-screen video)
  with triggers (auto / tap / Rive input). Video segments play a clip over the
  stage (optional Skip button) and hand back to Eli when it ends — upload
  .mp4/.webm in the files section, then **+ Video** in the segment picker.
- **video** — full-screen video with a Skip button.
- **chat** — free AI conversation with Eli (needs the API key).

Navigation: name Rive inputs `nav_<scene_id>` and wire them in the editor's
SCENE CONNECTIONS panel, or use the FALLBACK section for what happens when a
scene ends.

**Rive names:** every input / state machine / artboard name the code expects
is listed in `RIVE-CONTRACT.md` — keep it open while working in Rive Studio.
The editor's **Rive check** row (under State machines) diffs the loaded .riv
against the scene's config and flags missing names.

## Editor tips

- **✨ Auto sync** generates mouth markers from the audio; fine-tune by hand.
- **CC Auto captions** listens to the loaded voice line and creates timed,
  editable captions on the same lip-sync timeline. Review the text, then Save.
- **Cmd+Z** undoes marker/text-cue changes; **Space** holds to play.
- **Cmd+S** saves; the Save button glows amber when there are unsaved changes.
- Drag scenes in the sidebar to reorder; **⧉** duplicates a scene.
- **↺ Restore previous save** rolls a scene back (each Save keeps a backup).
- Scene switches autosave — you can't lose work by clicking around.

## Player notes

- Progress is saved locally; returning players resume at their last scene.
  Add `?scene=<id>` to force a scene, `?game=<id>` to play a non-default game.
- The speaker button (top right) mutes everything, including Eli's mumble voice.
- Eli's chat memory (bond, player name, unlocked memories) lives per game in
  `games/<id>/data/`. View or wipe it from the editor's ELI'S MEMORY section.

## Text-to-speech

**⌨ Generate voice** in the AUDIO FILES section turns typed text into a voice
file in the scene — no recording needed:

- **Eli voice (Google Gemini)** — the editor keeps Google's youthful `Leda`
  voice as Eli's identity. Choose a vulnerable, frightened, exhausted,
  remembering, hopeful, or relieved performance and set its strength per line.
  Set `GEMINI_API_KEY` in `.env`; override the model with
  `GEMINI_TTS_MODEL` if needed.
- **Natural (Kokoro)** — neural TTS, ~3s per line. One-time setup:
  `bash tts/setup-kokoro.sh` (downloads ~340 MB of models into `tts/`).
- **Draft (macOS voice)** — instant, built-in `say` voices. Good for
  placeholder timing, robotic for real scenes.

Generated files behave exactly like uploads (assign a role, run ✨ Auto sync).
The `tts/` models and venv stay local — they're excluded from deploys.

## Mumble voice

Eli's mumble plays real syllables sliced from the voice recordings
(`public/audio/mumble/`), with phrase prosody (pitch declines across a line,
rises on questions). If the sprite is missing it falls back to the old
formant synth. Rebuild after recording new lines:

```
node build-mumble-sprite.mjs games/main/scenes/eli/audio/*.mp3
```

## Deploying

`Publish` in the editor saves any open changes, pushes the current Git branch
when the folder is a checkout, then starts the EasyPanel deploy webhook. If the
editor is running from a plain folder without `.git`, it still starts the
EasyPanel deploy directly. The webhook URL can be overridden with
`DEPLOY_WEBHOOK` in `.env`.
