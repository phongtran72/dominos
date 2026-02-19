# Hard AI Upgrade — Implementation Plan

## Context

The current Hard AI (minimax with alpha-beta) loses badly — 141-0 over 10 hands. Key problems:
1. **Correctness bug**: `ai.js` uses `lastPlacer` as aggressor in block scoring, but `game.js` uses the full Puppeteer Rule (`determineAggressor` → `checkPuppeteer`). This mismatch causes the AI to misjudge block outcomes.
2. **Shallow search**: Fixed depth (8 plies opening) with no transposition table — re-searches identical positions.
3. **No iterative deepening**: Can't adapt to time budget; no PV move reuse.
4. **Weak move ordering**: No TT best-move, no killer moves, no history heuristic.
5. **UI freeze risk**: AI runs synchronously on main thread.

## Files to Modify/Create

| File | Action | Phase |
|------|--------|-------|
| `ai.js` | Major rewrite — all search upgrades | 1-6 |
| `ai-worker.js` | New — self-contained Web Worker | 7 |
| `ui.js` | Modify — async worker integration | 7 |
| `sw.js` | Update — add worker to cache, bump version | 7 |
| `test.html` | New — test harness page | 8 |
| `test-harness.js` | New — self-play + puppeteer tests | 8 |

## Phase 1: Configurable Eval Weights (ai.js)

Extract all magic numbers to named constants at top of IIFE:
```
W_PIP=2, W_MOBILITY=4, W_TILE=5, W_SUIT=3, W_LOCKIN=8, W_LOCKIN_BOTH=15,
W_GHOST=10, W_DOUBLE=0.5
MO_DOMINO=1000, MO_FORCE_PASS=25, MO_GHOST=15, MO_DOUBLE=12, MO_PIP_MULT=1.5
```

**No `passedValues` parameter** — this is a perfect-information game where the AI already holds both hands. Suit voids are already captured by the lock-in bonus (`hL === 0` / `hR === 0`) and mobility scoring. Threading `opponentPassedValues` through every minimax/evaluate call adds hot-path overhead for zero new information.

## Phase 2: Puppeteer-Aware Block Scoring (ai.js)

**The bug**: `scoreBlock()` line 119 assumes `lastPlacer` = aggressor. But `game.js:444-529` checks if the second-to-last placer forced the last placer into a single legal tile where every placement blocks.

**Fix**: Add 7 params to minimax for placement history:
```
p1Who, p1L, p1R, p1Tile  — most recent tile placement (who, board-after, tile ref)
p2Who, p2L, p2R           — second-most-recent placement (who, board-after)
```

On tile placement: old p1→p2, current move→p1. On pass: unchanged.

New `detectAggressor()` function (mirrors `game.js:checkPuppeteer` logic):
- At block terminal, reconstruct forced player's hand (current hand + tile they played)
- Check if they had exactly 1 legal tile at the board state before their move
- If yes, simulate all placements of that tile — if all cause blocks → puppeteer applies, prev placer is aggressor

New `scoreBlockWithPuppeteer()` replaces `scoreBlock()` — calls `detectAggressor` then applies same scoring formula (successful: oppPips×2, failed: allPips).

Root call seeds p1/p2 from `engine.hand.moveHistory` (last 2 non-pass entries).

**Use `Uint8Array(28)` instead of `{}` object for tile dedup** in puppeteer check (avoids GC in hot path). Map tile IDs to indices 0-27 via `TILE_ID_TO_INDEX` lookup.

## Phase 3: Transposition Table with Zobrist Hashing (ai.js)

**Zobrist setup** — pre-compute random 32-bit values using seeded xorshift32:
- `TILE_HASH[28][2]` — per tile, per hand (AI=0, Human=1)
- `LEFT_HASH[8]`, `RIGHT_HASH[8]` — board end values 0-6 + null(=7)
- `SIDE_HASH` — XOR on side-to-move change
- `CONSPASS_HASH[2]` — consPass 0 or 1

**TT storage** — flat typed arrays for cache performance (~2.5MB total, mobile-friendly):
```
TT_SIZE = 1<<18  (262144 entries)
ttHash[TT_SIZE]    Int32Array   — verification hash
ttDepth[TT_SIZE]   Int8Array    — search depth
ttFlag[TT_SIZE]    Uint8Array   — 0=empty, 1=EXACT, 2=LOWER, 3=UPPER
ttValue[TT_SIZE]   Int16Array   — score
ttBestIdx[TT_SIZE] Int8Array    — best move tile index
ttBestEnd[TT_SIZE] Int8Array    — best move end code
```
Note: 1<<20 (~10MB) is excessive — the search visits at most NODE_LIMIT (1M) nodes and unique positions are far fewer. 1<<18 provides ample capacity without stressing mobile memory.

**Incremental hash update** in minimax: XOR out old tile/end hashes, XOR in new ones when placing a tile. Add `hash` parameter to minimax.

**Puppeteer state NOT included in hash** — block terminals are rare; accept minor scoring mismatches for vastly better TT hit rate.

`ttClear()` called at start of each `chooseMoveHard()`. TT is per-move, not persistent.

## Phase 4: Move Ordering Improvements (ai.js)

Three new ordering signals, integrated into `orderMoves()`:

1. **TT best-move** (+100000): From `ttProbe` result, search this move first
2. **Killer moves** (+5000): 1 killer per depth level — tile ID + end that caused a beta cutoff. Stored in `killerTileId[60]`, `killerEnd[60]` arrays.
3. **History heuristic** (+depth²): `historyScore[28][3]` array (28 tiles × 3 end codes). Updated on beta cutoffs. Cleared per root search.

Existing heuristics (domino, force-pass, ghost13, doubles, pip weight) remain with same priorities.

## Phase 5: Iterative Deepening + Time Budget (ai.js)

Replace `getMaxDepth()` with iterative deepening loop in `chooseMoveHard()`:
```
for depth = 2, 4, 6, ... until time budget exhausted:
    run root search at this depth
    if completed: save bestMove
    if elapsed > budget * 0.6: break (not enough time for next iteration)
```

- **Time budget**: 400ms (adjustable constant)
- **PV move**: TT stores best move from previous iteration → used as first move in next
- **NODE_LIMIT**: Kept as secondary safety valve within each iteration
- **Early termination**: If exact solve (nodeCount < limit and depth >= totalTiles), stop

## Phase 6: Quiescence / Tactical Extensions (ai.js)

At depth limit (`depth <= 0`), check if position is "noisy":
- Either side has exactly 1 legal move (0 is already handled by pass/terminal)
- Any move forces opponent pass

If noisy: set `depth = 2` and `ext = ext + 2`, then continue searching.

**Extension budget**: Add `ext` parameter to minimax (starts at 0). Extensions only fire when `ext < 4`. This caps total extra plies per search path at 4. The `ext` counter strictly increases — it cannot loop because each extension consumes budget.

Note: The earlier design using `depth > -4` as the guard was broken — resetting `depth = 2` while only checking current depth allows infinite re-extension (depth reaches 0, resets to 2, reaches 0, resets to 2...). The explicit `ext` counter fixes this.

## Phase 7: Web Worker (new ai-worker.js, modify ui.js, sw.js)

**`ai-worker.js`** — self-contained file with:
- Minimal `Tile` class (constructor + methods: matches, isDouble, pipCount, otherSide)
- Tile cache: `getTile(low, high)` returns shared Tile instance
- Complete AI engine (all functions from Phases 1-6, copied into worker scope)
- `onmessage` handler: reconstruct Tiles from `{low,high}` pairs, run search, post back `{tileId, end}`

**`ui.js` changes**:
- `initWorker()`: create worker on DOMContentLoaded
- `executeAITurn()`: if hard mode + worker available → serialize state, `postMessage`, handle result in `onWorkerResult` callback
- `applyAIMove(move, elapsed)`: extracted from current inline code — shared between sync and async paths
- Fallback: easy mode or no Worker support → runs synchronously as before

**`sw.js`**: Add `'./ai-worker.js'` to ASSETS, bump cache version.

## Phase 8: Test Harness (new test.html, test-harness.js)

**`test.html`**: Loads game.js + ai.js + test-harness.js. Buttons for self-play, puppeteer tests, perf benchmark.

**`test-harness.js`**:
- Seeded PRNG (xorshift128) replacing Math.random for deterministic dealing
- `selfPlay(numHands, seed)`: AI vs AI, returns win/loss/block/domino counts
- Puppeteer scenario tests: handcrafted positions where engine and AI block scoring must match
- Performance benchmark: measure decision time and node count per move

## Implementation Order

```
Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7 → Phase 8
  eval      puppet    TT+hash   ordering    ID+time   quiesce   worker    tests
```

Each phase produces a working, testable AI. Phases 1-6 touch only `ai.js`. Phase 7 adds `ai-worker.js` and modifies `ui.js`/`sw.js`. Phase 8 adds test files.

## Verification

1. **Puppeteer correctness**: Handcrafted scenarios where `game.js resolveBlock()` winner/points must match AI terminal scoring 1:1
2. **TT effectiveness**: Log hit rate; target 30-50% node reduction at same depth
3. **Iterative deepening**: Log depth reached per move; endgame still solves exactly
4. **Self-play**: 100+ hands AI-vs-AI, verify no crashes and reasonable win distribution
5. **Performance**: Decision time < 500ms on mobile (95th percentile)
6. **UI responsiveness**: No jank with Web Worker enabled on mobile
7. **PWA offline**: Worker cached and functional offline
