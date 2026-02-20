# Dominos Project Summary

> **Last Updated:** 2025-02-20
> **Last Commit:** `f27eab3` — "Add eval bar and AI move analysis panel"
> **Cache Version:** `dominos-v9` (sw.js)

---

## 1. Project Overview

A **Progressive Web App (PWA)** implementation of a two-player **double-six domino game** (Human vs AI). Hosted via GitHub Pages with full offline support.

### Game Rules (from Game_Req.txt)

- **28 tiles** (double-six set), **14 per player**, **no boneyard** (all tiles dealt)
- Players keep tiles concealed (unless "Open" mode is enabled)
- **First to 100 points** wins the match; points accumulate across hands
- Human chooses who leads first hand; hand winner leads next hand
- Hand ends by **Domino** (player empties hand) or **Block** (neither can play)
- **Ghost 13 Rule**: Unplayable [0-0] at hand end counts as 13 pips
- **Puppeteer Rule**: For blocks, the true aggressor is identified (the player who forced the opponent into a move that caused the block)
- **Block Scoring**: Successful block = opponent pips x2; Failed block = all remaining pips

---

## 2. File Structure

```
dominos/
├── index.html          # Main game interface (162 lines)
├── game.js             # Core game engine - pure logic, no DOM (~546 lines)
├── ai.js               # Bitboard AI engine - minimax + alpha-beta (~1233 lines)
├── ai-old.js           # Legacy array-based minimax engine (~1016 lines)
├── ai-worker.js        # Web Worker copy of bitboard engine (~1121 lines)
├── ui.js               # DOM rendering, event handling, controller (~1040 lines)
├── style.css           # All styling, mobile-first responsive (~1070 lines)
├── sw.js               # Service worker, network-first caching (57 lines)
├── manifest.json       # PWA manifest
├── Game_Req.txt        # Complete game rules specification
├── hard-ai-upgrade-plan.md   # 8-phase AI improvement roadmap (all completed)
├── ai-summary.html     # AI algorithm documentation
├── test.html           # Test harness page
├── test-harness.js     # Self-play testing & puppeteer validation
├── compare-engines.js  # Engine comparison tool
├── icons/              # PWA icons (icon.svg, icon-192.png, icon-512.png)
├── docs/               # Project documentation
│   └── PROJECT_SUMMARY.md  # This file
├── .gitignore
└── .github/workflows/static.yml  # GitHub Pages deployment
```

---

## 3. Architecture

### 3.1 Game Engine (`game.js`)

Pure logic layer with no DOM dependencies. Key classes:

- **`Tile`**: Represents a domino tile
  - `pipCount()`, `pipCountWithGhost(boardEnds)`, `matches(value)`, `isDouble()`, `otherSide(value)`
  - `id` format: `"low-high"` (e.g., `"3-5"`)
- **`TileHand`**: Collection of tiles for a player
  - `addTile()`, `removeTile()`, `tilesMatching()`, `pipTotal()`, `isEmpty()`
- **`Board`**: The domino chain layout
  - `place(tile, end)`, `isEmpty()`, `leftEnd`, `rightEnd`
- **`Hand`**: A single round of play
  - `board`, `humanHand`, `aiHand`, `moveHistory[]`
  - `legalMoves(hand)` returns array of `{tile, end}` objects
  - Block/Domino detection, Puppeteer Rule implementation
- **`Engine`**: Match-level state
  - `humanScore`, `aiScore`, `handNumber`, `hand`
  - `startHand(leader)`, `isMatchOver()`, `matchWinner()`

### 3.2 AI Engines

#### Bitboard Engine (`ai.js`) — Primary

- **28-bit integer bitmasks** for tile hands (each tile = 1 bit)
- Make/unmake moves with XOR operations
- Pre-computed lookup tables: `TILE_LOW[]`, `TILE_HIGH[]`, `TILE_PIPS[]`, `SUIT_MASK[]`
- **Minimax with alpha-beta pruning**, iterative deepening, aspiration windows
- **Zobrist hashing** for transposition table
- **Move ordering**: TT best-move, killer moves, history heuristic, domino bonus, force-pass bonus
- **Evaluation weights**: `W_PIP=2, W_MOBILITY=4, W_TILE=5, W_SUIT=3, W_LOCKIN=8, W_LOCKIN_BOTH=15, W_GHOST=10, W_DOUBLE=0.5`
- Zero allocation in hot path (typed arrays throughout)
- Returns enriched format: `{ move, bestScore, depth, nodes, analysis }`
- `evaluatePosition(engine)` for static eval after human moves

#### Legacy Engine (`ai-old.js`) — Fallback

- Array-based minimax with alpha-beta pruning
- Same evaluation function concepts but uses Tile objects instead of bitboards
- Zobrist hashing with simpler implementation
- Root scores keyed as `tile.id + '_' + endStr` (e.g., `"3-5_left"`)
- Same enriched return format for compatibility

#### Web Worker (`ai-worker.js`)

- Self-contained copy of the bitboard engine for non-blocking computation
- Communicates via `postMessage` with extended data: `{ tileId, end, bestScore, depth, nodes, analysis }`
- Falls back to synchronous execution if Worker unavailable

### 3.3 UI Controller (`ui.js`)

Single IIFE on `window.Domino` namespace. Key state:

```
difficulty     — 'easy' | 'hard'
selectedEngine — 'old' | 'new'
openTiles      — true | false (show AI tiles face-up)
isProcessing   — prevents double-clicks during AI turn
viewIndex      — -1 = live, 0..N = reviewing move N
isReviewing    — true when navigating history
handOver       — true once hand/match result is shown
handResult     — cached result data for re-showing overlay
lastAIAnalysis — { bestScore, depth, nodes, analysis }
```

Key functions:

| Function | Purpose |
|----------|---------|
| `startMatch()` | Initializes engine, AI, shows leader overlay |
| `startHand(leader)` | Deals tiles, saves initial state for replay |
| `onEndClicked(end)` | Human plays a tile, updates eval bar |
| `executeAITurn()` | Dispatches to worker or sync AI |
| `finishAIMove(tileId, end, analysis)` | Animates AI move, updates eval/analysis |
| `showHandResult(result)` | Shows hand result with Review/Next buttons |
| `updateEvalBar(score)` | Sets bar width + label from raw score |
| `renderAnalysis(analysis, chosenTileId, chosenEnd)` | Builds analysis pills |
| `clearAnalysis()` | Hides analysis panel |
| `scoreToPercent(score)` | Sigmoid: `50 + tanh(score * 0.03) * 50` |
| `enterReviewMode()` | Enters move-by-move history review |
| `exitReviewMode()` | Returns to live game state |
| `exitReviewToHandOver()` | Returns to end-of-hand overlay |
| `onReviewHand()` / `onReviewMatch()` | Dismisses overlay, enters review |
| `startHandReview()` | Sets viewIndex to last move |
| `updateNavButtons()` | Shows/hides and enables/disables nav arrows |
| `goBackward()` / `goForward()` | Steps through move history |
| `renderBoardState(moveIndex)` | Rebuilds board up to given move |

### 3.4 Styling (`style.css`)

- **Mobile-first** with safe area insets for notched devices
- **Green felt table** aesthetic (`#1a5c2a` base)
- CSS Grid for tile layouts in hands
- Pip positioning patterns for 3x3 domino face rendering
- Responsive breakpoints: 480px width, 500px height, 360px width
- Key UI components:
  - **Eval bar**: Green background (#3a8a4a), red/orange fill (#c06040), 10px height, `transition: width 0.4s ease`
  - **Analysis pills**: Compact, monospace, scrollable row; `.analysis-pill--best` has gold highlight
  - **Overlays**: Start, leader choice, hand result, match result (all `.overlay > .modal`)
  - **Modal buttons**: `.modal-buttons` flex row for Review/Next choices

### 3.5 Service Worker (`sw.js`)

- Cache name: `dominos-v9`
- Strategy: **Network-first** with offline fallback
- Auto-updates cache with fresh responses when online
- Must bump version when files change

---

## 4. Key Features

1. **Two AI difficulty levels**: Easy (random) and Hard (full minimax search)
2. **Two AI engines**: Bitboard (primary, faster) and Legacy Minimax (fallback)
3. **Engine selector** on start screen
4. **Open tiles mode**: Show AI hand face-up for learning
5. **AI move animation**: Tile visually moves from AI hand to board
6. **Move history navigation**: Backward/forward buttons during play
7. **Post-game review**: "Review Moves" button at hand/match end, with "Next Hand" / "Play Again" option
8. **Eval bar**: Horizontal bar showing who's winning (green=You, red=AI), sigmoid-normalized
9. **AI analysis panel**: Shows all moves AI considered, ranked best to worst as pills
10. **PWA**: Installable, works offline, has manifest and service worker
11. **GitHub Pages**: Auto-deployed via `.github/workflows/static.yml`

---

## 5. Data Flow

### Human Turn
```
User clicks tile → selectedTile set → end markers shown →
User clicks end → onEndClicked(end) →
  game.js: board.place(tile, end) →
  ai.js: evaluatePosition(engine) → static eval score →
  ui.js: updateEvalBar(score), clearAnalysis() →
  moveHistory entry gets .evalScore attached →
  executeAITurn()
```

### AI Turn
```
executeAITurn() →
  [Worker path]: postMessage to ai-worker.js →
    chooseMoveHard() → minimax search → collects rootScores →
    postMessage back: { tileId, end, bestScore, depth, nodes, analysis } →
  [Sync path]: ai.chooseMove(legalMoves, engine) →
    returns { move, bestScore, depth, nodes, analysis } →
  finishAIMove(tileId, end, analysisData) →
    animate tile → board.place() →
    updateEvalBar(bestScore) → renderAnalysis(analysis) →
    moveHistory entry gets .analysis + .evalScore attached
```

### Review Mode
```
User clicks ◄/► or "Review Moves" →
  goBackward()/goForward() →
    viewIndex adjusted →
    renderBoardState(viewIndex) — rebuilds board up to that move →
    Shows stored .analysis and .evalScore from moveHistory[viewIndex]
```

---

## 6. Move History Entry Format

Each entry in `engine.hand.moveHistory[]`:

```javascript
{
  player: 'human' | 'ai',
  tile: Tile,            // the tile played
  end: 'left' | 'right', // which end it was placed on
  pass: false,           // true if this was a pass
  boardEnds: { left, right }, // board state after this move

  // Attached by ui.js:
  analysis: [            // AI's considered moves (only for AI turns)
    { tileId: "3-5", end: "left", score: 45 },
    { tileId: "2-4", end: "right", score: -12 },
    ...
  ],
  evalScore: number      // raw evaluation score at this point
}
```

---

## 7. Enriched AI Return Format

All three engines return the same format from `chooseMove()`:

```javascript
{
  move: { tileLow, tileHigh, end } | Tile,  // bitboard vs legacy format
  bestScore: number,     // score of chosen move
  depth: number,         // search depth reached
  nodes: number,         // nodes searched
  analysis: [            // all root moves with scores, sorted best→worst
    { tileId: "3-5", end: "left", score: 45 },
    ...
  ]
}
```

- **Bitboard engine** (`ai.js`/`ai-worker.js`): Keys are `tIdx + '_' + end` (numeric index + 0/1)
- **Legacy engine** (`ai-old.js`): Keys are `tile.id + '_' + endStr` (e.g., `"3-5_left"`)
- `evaluatePosition(engine)` returns a raw score (positive favors AI)

---

## 8. Eval Bar Normalization

```javascript
function scoreToPercent(score) {
  var k = 0.03;
  var t = Math.tanh(score * k);
  return 50 + t * 50;  // maps to 0-100, where 50 = even
}
```

- `k = 0.03` controls sensitivity (adjustable if bar feels too/not responsive)
- Eval fill width = `(100 - percent)%` (fills from right = AI side)
- Labels: "You lead", "AI leads", "Even", "Winning!", "Losing!"

---

## 9. Commit History

```
f27eab3 Add eval bar and AI move analysis panel
e6a1b6b Add Review Moves option at hand/match end
5871237 Add move history navigation, fix hand numbering bug, rename engine label
ea2d9c3 Bitboard engine rewrite, open tiles, engine selector, AI move animation
407e445 Fix critical minimax bugs and boost AI search strength
1c9422b Upgrade Hard AI with 8-phase improvements and add Web Worker support
f73d08b Create static.yml
b982213 Add AI minimax implementation summary (HTML document)
4f96277 Switch service worker to network-first caching strategy
dff35d1 Switch human hand to CSS Grid for reliable tile wrapping
77770ab Fix mobile hand layout: ensure tiles wrap to fit screen
7d9b201 Upgrade AI hard mode to minimax with alpha-beta pruning
a41a566 Dominos: two-player double-six domino game (PWA)
```

---

## 10. Development Notes

### When modifying files:
1. **Always bump `sw.js` cache version** (currently `dominos-v9`) when any cached file changes
2. **Three engines must stay in sync**: `ai.js`, `ai-worker.js`, and `ai-old.js` all return the same enriched format
3. **`ai-worker.js` is a standalone copy** — changes to `ai.js` must be manually mirrored
4. **All game logic is in `game.js`** — AI and UI only import from it via `window.Domino`

### Known design decisions:
- **Perfect information**: AI sees both hands (no probability needed, pure search)
- **No boneyard**: All 28 tiles dealt, enabling full 28-ply solve with bitboard engine
- **Bitboard engine won comparison**: 57.5% vs 42.5% against legacy engine
- **Snake layout was attempted and reverted** in a previous session
- **Nav buttons hidden by default**: Only shown when there's history to navigate (user preference)
- **Post-game flow**: Shows result overlay with "Review Moves" / "Next Hand" buttons (not auto-advance)

### Potential future improvements:
- Adjust sigmoid sensitivity constant (`k=0.03`) based on playtesting
- Add depth/nodes info to the analysis display
- Style adjustments based on visual testing
- Consider adding AI explanations for why certain moves are good/bad
- Mobile gesture support for history navigation
