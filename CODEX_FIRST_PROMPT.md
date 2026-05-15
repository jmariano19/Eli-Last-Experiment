# Codex Kickoff Prompt

Paste this into Codex (or use it as the first message in a Codex session) when you're ready to start building. Read `README.md` and `RIVE_SPEC.md` first — they are the contract you'll work against.

---

## Your task (sprint 1)

Set up the Eli's Last Experiment project per `README.md` and ship **Minute One** as specified in `README.md` §8.

Concretely:

1. Scaffold the project at the repository root with the folder structure in `README.md` §2. Use `npm` (not pnpm or yarn).
2. Pin exact versions in `package.json`. Use the latest stable for each dependency at the time of scaffolding; lock them.
3. Configure `vite.config.ts` for path aliasing (`@/*` → `src/*`) and to serve `public/rive/*.riv` correctly (set `assetsInclude: ['**/*.riv']`).
4. Set up Capacitor 6 for iOS and Android with `appId = com.elilastexperiment.app` and `appName = "Eli's Last Experiment"`. Run `npx cap add ios` and `npx cap add android` but commit only the generated config — leave the platform folders for the human to verify locally.
5. Implement `scripts/watch-rive.mjs` per `README.md` §4. Use `chokidar`. On any change inside `public/rive/`, regenerate `src/rive/manifest.ts` with sha1-hashed query strings. Hook it into `npm run dev` via `concurrently`.
6. Generate `src/rive/contract.ts` from `RIVE_SPEC.md`. Build a typed helper `useTypedInput(rive, file, inputName)` that constrains `inputName` to the inputs declared for `file` in the contract.
7. Build `src/components/RiveCanvas.tsx` — a thin wrapper around `useRive` that takes a manifest key, an artboard name, a state machine name, and an `onLoad` callback exposing the rive instance + typed inputs.
8. Build the `Intro` scene per the t-table in `README.md` §8. Wire audio via Howler with three assets that Jeff will provide later (use 1-second sine-tone placeholders for now, file names `heartbeat_loop.opus`, `eli_intro_01.opus`, `cta_chime.opus`).
9. Persist `intro_completed` via `@capacitor/preferences` so a returning player skips straight to the (placeholder) `Body` scene.
10. Add a minimal `Body` scene that loads `eli.riv` and displays Eli idle — no interaction yet beyond logging tap events.
11. Pass `npm run check` (typecheck + lint + Vitest with at least one smoke test that mounts `Intro` and asserts the heartbeat audio call fires).

## Constraints

- Do not modify `RIVE_SPEC.md` without explicit approval. If you find you need a new Rive input, stop and say so in your PR description.
- Do not exceed the budgets in `README.md` §5.
- No new dependencies beyond those listed in `README.md` §1 without a one-line justification in the PR description.
- Strict TypeScript. No `any`. No `// @ts-ignore` without a same-line `// reason:` comment.
- Subtitles must be screen-reader accessible (`aria-live="polite"`).

## Definition of done

- `npm install && npm run dev` works on a fresh clone.
- The Intro scene plays end-to-end in the browser. Tapping the waveform, then the heart three times, then the CTA, advances state and persists `intro_completed`.
- Dropping any new `.riv` into `public/rive/` causes a reload within 2 seconds without manual cache clearing.
- `npm run check` passes.
- `npx cap sync` runs clean (don't worry about device boot — Jeff will do that locally).
- PR description lists: dependency choices with versions, any deviation from `README.md`, performance numbers (bundle size, time-to-interactive on `npm run preview`).

## Out of scope for sprint 1

- The full extraction-run mechanics
- Eli's transformation across sessions
- Dialogue system beyond the four lines in Intro
- Analytics, accounts, monetization
- App Store / Play Store submission

Begin with the scaffold. Confirm the structure builds before writing scene code.
