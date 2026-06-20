# Rive Source Files

Save your Rive **editor source files** here (the ones you open and edit in the Rive desktop app).

This folder is for working files only — they are NOT loaded by the app.

The runtime exports go in `/public/rive/` instead, via **File → Export → Runtime** in the Rive desktop app.

## Naming

Use the same base name as the runtime export, with `_source` suffix to avoid confusion:

| Editor source (here) | Runtime export (in /public/rive/) |
|---|---|
| `intro_source.riv` | `/public/rive/intro.riv` |
| `eli_source.riv` | `/public/rive/eli.riv` |
| `heart_run_source.riv` | `/public/rive/extractions/heart_run.riv` |

## Backup

Weekly: zip this folder and copy to a backup location outside the repo. Editor files can't be reconstructed from runtime exports.
