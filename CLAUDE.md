# Claude Code Instructions

## Project Context

This is a **double-six domino PWA** (Human vs AI). Read `docs/PROJECT_SUMMARY.md` for full architecture details, file descriptions, data flows, and development notes.

## Quick Reference

- **Game rules**: `Game_Req.txt`
- **Architecture summary**: `docs/PROJECT_SUMMARY.md`
- **AI upgrade plan**: `hard-ai-upgrade-plan.md`

## Key Reminders

1. **Bump `sw.js` cache version** whenever any cached file changes (currently `dominos-v12`)
2. **Three AI engines must stay in sync**: `ai.js`, `ai-worker.js`, `ai-old.js` — all return `{ move, bestScore, depth, nodes, analysis }`
3. **`ai-worker.js` is a standalone copy** of the bitboard engine — changes to `ai.js` search/eval must be manually mirrored
4. **All game logic lives in `game.js`** — AI and UI reference it via `window.Domino`
5. **User prefers**: Review Moves button at hand end (not auto-advance, not always-visible nav buttons)
6. **No boneyard**: All 28 tiles dealt to 2 players (14 each) — this enables perfect-information full-depth search
