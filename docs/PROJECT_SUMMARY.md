# Dominos Project Summary

> **Last Updated:** 2026-02-26
> **Last Commit:** `213f209` — "Add 1v3 team mode to 4-player game alongside existing 2v2"

---

## 1. Project Overview

A **Progressive Web App (PWA)** collection of **double-six domino games** with multiple player variants: 2-player standard, 2-player draw, 3-player, and 4-player. Each variant has its own AI engine tailored to the game's information model. Hosted via GitHub Pages with full offline support.

### Game Variants at a Glance

| Variant | Directory | Players | Tiles/Player | Boneyard | Info Model | AI Approach |
|---------|-----------|---------|--------------|----------|------------|-------------|
| 2P Standard | `/` (root) | 2 | 14 | None | Perfect | Bitboard minimax, full-depth |
| 2P Draw | `/2players/` | 2 | 9 (+10 boneyard) | Yes | Imperfect | Bayesian + Monte Carlo 3-ply |
| 3 Players | `/3players/` | 3 | 9 (27 tiles, no [0\|0]) | None | Imperfect | TileTracker3P + Monte Carlo 3-ply |
| 4 Players | `/4players/` | 4 | 7 (28 tiles) | None | Imperfect | TileTracker4P + Monte Carlo 3-ply |

---

## 2. File Structure

```
dominos/
├── Root — 2-Player Standard (Perfect Information)
│   ├── index.html          # Game interface (~250 lines)
│   ├── game.js             # Core game engine (~642 lines)
│   ├── ai.js               # Bitboard AI — minimax + alpha-beta (~1301 lines)
│   ├── ai-old.js           # Legacy array-based minimax (~1048 lines)
│   ├── ai-worker.js        # Web Worker copy of bitboard engine (~1270 lines)
│   ├── ui.js               # Classic board UI controller (~2219 lines)
│   ├── ui-board.js          # Snake board UI controller (~2636 lines)
│   ├── style.css           # Main styling (~1246 lines)
│   ├── style-board.css     # Snake board styling (~91 lines)
│   ├── sw.js               # Service worker — cache: dominos-v27
│   └── manifest.json
│
├── 2players/ — 2-Player Draw (Imperfect Information)
│   ├── index.html, game.js, ai.js, ai-enhanced.js
│   ├── ui.js, ui-board.js, style.css, style-board.css
│   ├── sw.js               # Cache: dominos-draw-v7
│   └── manifest.json
│
├── 3players/ — 3-Player Free-for-All + Coordination
│   ├── index.html, game.js, ai.js, rules.html
│   ├── ui-board.js, style.css, style-board.css
│   ├── sw.js               # Cache: dominos-3p-v10
│   └── manifest.json
│
├── 4players/ — 4-Player Teams (Independent / 1v3 / 2v2)
│   ├── index.html, game.js, ai.js, rules.html
│   ├── ui-board.js, style.css, style-board.css
│   ├── sw.js               # Cache: dominos-4p-v6
│   └── manifest.json
│
├── icons/              # PWA icons (icon.svg, icon-192.png, icon-512.png)
├── docs/               # PROJECT_SUMMARY.md (this file)
├── Game_Req.txt        # Complete 2P game rules specification
├── CLAUDE.md           # Development instructions for AI assistant
├── hard-ai-upgrade-plan.md  # 8-phase AI improvement roadmap (completed)
├── ai-summary.html     # AI algorithm documentation
├── test.html + test-harness.js  # Self-play testing
├── compare-engines.js  # Bitboard vs legacy comparison
├── tune-weights.js     # AI evaluation weight tuning
├── .gitignore
└── .github/workflows/static.yml  # GitHub Pages deployment
```

---

## 3. Variant Details

### 3.1 Two-Player Standard (Root Directory)

**Rules:** 28 tiles, 14 per player, no boneyard. First to 100 points.
- **Perfect information** — AI sees both hands, enabling full-depth minimax search
- **Ghost 13 Rule**: [0-0] counts as 13 pips when all 6 other zero-suit tiles are on board
- **Puppeteer Rule**: Blocks identify the true aggressor who forced the opponent
- **Block Scoring**: Successful block = opponent pips ×2; Failed block = all remaining pips

**AI:** Bitboard engine (28-bit masks, XOR make/unmake, Zobrist TT, iterative deepening, aspiration windows). Legacy array-based engine as fallback. Web Worker for non-blocking search.

**Special Features:** Engine selector, open tiles mode, eval bar, AI analysis pills, move history review, board style selector (classic vs snake).

---

### 3.2 Two-Player Draw (`/2players/`)

**Rules:** 28 tiles, 9 per player, 10 in boneyard. If no legal moves, draw from boneyard until you can play or it's empty.
- **Imperfect information** — player can't see opponent's or boneyard tiles
- No Ghost 13, no Puppeteer Rule

**AI:** TileTracker with Bayesian inference (deduces opponent hand from draws/passes), Monte Carlo determinization with 3-ply lookahead. 10 strategic advantages: endpoint locking, draw-forcing, scarcity exploitation, chain detection, boneyard depletion aggression.

**Special Features:** Draw button, boneyard display with count, AI hints toggle. No eval bar or analysis panel.

---

### 3.3 Three Players (`/3players/`)

**Rules:** 27 tiles (no [0|0]), 9 per player, no boneyard. Ghost 13 does not apply.
- **Imperfect information** — each player only sees own hand
- **Turn order:** Human → AI-1 → AI-2
- **Block scoring:** Lowest pip count wins, gets sum of all opponents' pips

**AI Modes:**
- **Independent** — each AI plays for itself (3-way free-for-all)
- **Coordinated** — both AIs cooperate against human using public info only

**AI:** TileTracker3P, Bayesian inference per opponent, Monte Carlo 3-ply, chain detection, endgame urgency, kingmaker awareness. Coordination strategies: C1 (non-aggression), C2 (squeeze human), C3 (sacrifice for partner).

**Special Features:** Turn indicator with color, color-coded AI hand tiles, undo, match/quick mode, rules page.

---

### 3.4 Four Players (`/4players/`)

**Rules:** 28 tiles (with Ghost 13), 7 per player, no boneyard.
- **Imperfect information** — each player only sees own hand
- **Seating order:** Human → AI-1 → AI-3 → AI-2 (partners sit across)
- **Team scoring:** All winning team members get losing team's combined pips

**AI Modes (3 options):**
- **Independent** — 4-way free-for-all, winner gets sum of all opponents' pips minus own
- **Teams (1v3)** — Human alone vs AI-1 + AI-2 + AI-3 cooperating
- **Teams (2v2)** — Human + AI-3 vs AI-1 + AI-2

**AI:** TileTracker4P, team-aware inference. Dynamic `TEAMS` config via `configureTeams('1v3'|'2v2')`. `teammates` array supports any team size. AI cooperation: C3 sacrifice iterates all teammates, S4 block steering sums all teammate pips.

**Player Colors:** Human = green (#60d070), AI-1 = gold (#d4a843), AI-2 = purple (#ab80f0), AI-3 = red (#e05050)

**Special Features:** 3 AI mode buttons with dynamic subtitle, turn indicator, undo, match/quick mode, rules page with team guide.

---

## 4. Architecture Patterns (Shared Across Variants)

### Game Engine (`game.js` in each directory)
- Pure logic layer, no DOM dependencies
- Exports via `window.Domino` (aliased as `D`)
- Key classes: `Tile`, `TileHand`, `Board`, `GameEngine`
- `playTile(player, tile, end)` → `checkHandEnd()` → `resolveDomino()` or `resolveBlock()`
- `pass(player)` → checks consecutive passes → `resolveBlock()` if all players passed
- `undoLastMove()` for undo support
- Move history: `engine.hand.moveHistory[]` — array of `{player, tile, end, pass, boardEnds}`

### AI Engine (`ai.js` in each directory)
- **Root:** Bitboard minimax (perfect info, deep search)
- **Others:** `TileTracker` + Bayesian inference + Monte Carlo 3-ply (imperfect info)
- All return `{ move: {tile, end}, ... }` from `chooseMove(legalMoves, engine)`
- Easy mode: random legal move; Hard mode: full strategy

### UI Controller (`ui-board.js` in each directory)
- Single IIFE wrapping all DOM logic
- Snake board layout with directional tile rendering
- Overlays: Start screen → Leader choice → Game → Hand result → (Match result)
- `isProcessing` flag prevents race conditions during AI turns
- `isReviewing` + `viewIndex` for post-game move review

### Service Worker (`sw.js` in each directory)
- Network-first strategy with offline fallback
- **Must bump cache version when any cached file changes**

---

## 5. Key Configuration: 4-Player TEAMS

The 4P game uses a dynamic `TEAMS` object configured at match start:

```javascript
// 2v2 (default):
TEAMS.human = { partner: 'ai3', team: 'A', enemies: ['ai1', 'ai2'], teammates: ['ai3'] };
TEAMS.ai3   = { partner: 'human', team: 'A', enemies: ['ai1', 'ai2'], teammates: ['human'] };
TEAMS.ai1   = { partner: 'ai2', team: 'B', enemies: ['human', 'ai3'], teammates: ['ai2'] };
TEAMS.ai2   = { partner: 'ai1', team: 'B', enemies: ['human', 'ai3'], teammates: ['ai1'] };

// 1v3:
TEAMS.human = { partner: null, team: 'A', enemies: ['ai1', 'ai2', 'ai3'], teammates: [] };
TEAMS.ai1   = { partner: null, team: 'B', enemies: ['human'], teammates: ['ai2', 'ai3'] };
// ... etc
```

Helper functions: `getTeamMembers(player)`, `getTeammates(player)`, `getEnemies(player)`, `getTeamName(player)` — all read from TEAMS dynamically.

---

## 6. Service Worker Cache Versions

| Variant | Cache Name | Current Version |
|---------|-----------|-----------------|
| Root (2P Standard) | `dominos-v27` | v27 |
| 2P Draw | `dominos-draw-v7` | v7 |
| 3 Players | `dominos-3p-v10` | v10 |
| 4 Players | `dominos-4p-v6` | v6 |

---

## 7. Recent Commit History

```
213f209 Add 1v3 team mode to 4-player game alongside existing 2v2
28ced8e Add complete 4-player dominos mode with rules guide
5d7131e Add AI hints toggle to 2P game, remove AI analysis from 3P
6bc4237 Add 3P game rules & AI strategy guide page
ee71830 Add color-coded AI hand tiles in 3P game
0048356 Add color-coded tile borders by player in 3P game
03c2155 Add undo and match mode to 3-player game
cdf1ce3 Overhaul 3P AI with 3-ply lookahead, chain detection, endgame urgency
067ad7e Overhaul 2P Draw AI with 3-ply lookahead and chain detection
bba68e1 Add 4 draw-variant AI strategies for stronger 2P Draw game
776e17f Add Draw 2P game with enhanced AI, remove WASM engine
fb31efb Add 3-player dominos with enhanced AI and coordination mode
1e1764f Add multi-variant directory structure for game modes
8db0475 Add match points selector: 1, 50, or 100 (default)
e129092 Increase AI time budget to 20s for full-depth solve
f27eab3 Add eval bar and AI move analysis panel
```

---

## 8. Development Notes

### When modifying files:
1. **Always bump `sw.js` cache version** in the relevant directory when any cached file changes
2. **Root 2P only:** Three AI engines must stay in sync: `ai.js`, `ai-worker.js`, `ai-old.js`
3. **Root `ai-worker.js` is a standalone copy** — changes to root `ai.js` must be manually mirrored
4. **All game logic is in `game.js`** per directory — AI and UI import via `window.Domino`
5. **Each variant is self-contained** — no shared JS between directories (only shared icons/)

### Design decisions:
- **Root 2P = perfect information** (AI sees both hands, pure minimax). All others = imperfect.
- **No boneyard** in root, 3P, 4P — all tiles dealt. 2P Draw has 10-tile boneyard.
- **Snake board layout** used in all variants (tiles turn corners)
- **Post-game flow**: Result overlay → "Review Moves" / "Next Hand" buttons (user preference: not auto-advance)
- **4P seating**: Human → AI-1 → AI-3 → AI-2 (partners sit across in 2v2 mode)
- **3P removes [0|0]** to get 27 tiles (divisible by 3)
- **AI cooperation uses only public info** — AIs don't share hidden tile knowledge

### Cross-variant links:
Each start screen has "Other Modes" section linking to all variants:
- Root `index.html` → 2players, 3players, 4players
- Each variant links back to others

---

## 9. Technology Stack

- **Framework:** Vanilla JavaScript (no build tools, no frameworks)
- **UI:** DOM manipulation, CSS Grid, CSS transitions, mobile-first responsive
- **Offline:** Service Worker (network-first) + PWA manifest
- **Hosting:** GitHub Pages via `.github/workflows/static.yml`
- **WASM:** Rust WASM engine exists in `/wasm-ai/` but is not currently used
