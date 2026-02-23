// ============================================================
// ai.js — AI Decision Making
//   Easy: random legal move
//   Hard: minimax with alpha-beta pruning (perfect information)
//
// Since all 28 tiles are dealt (14 each, no boneyard), the AI
// knows both hands. This is a perfect-information game from the
// AI's perspective — no probability needed, just search.
// ============================================================

(function (D) {
  'use strict';

  // --- Configurable evaluation weights ---
  // Allow external injection for tuning: set D._evalWeights before loading
  var _cfg = (typeof D._evalWeights === 'object' && D._evalWeights) || {};

  // Eval function weights (used in evaluate())
  var W_PIP         = _cfg.W_PIP         !== undefined ? _cfg.W_PIP         : 2;
  var W_MOBILITY    = _cfg.W_MOBILITY    !== undefined ? _cfg.W_MOBILITY    : 4;
  var W_TILE        = _cfg.W_TILE        !== undefined ? _cfg.W_TILE        : 5;
  var W_SUIT        = _cfg.W_SUIT        !== undefined ? _cfg.W_SUIT        : 3;
  var W_LOCKIN      = _cfg.W_LOCKIN      !== undefined ? _cfg.W_LOCKIN      : 8;
  var W_LOCKIN_BOTH = _cfg.W_LOCKIN_BOTH !== undefined ? _cfg.W_LOCKIN_BOTH : 15;
  var W_GHOST       = _cfg.W_GHOST       !== undefined ? _cfg.W_GHOST       : 10;
  var W_DOUBLE      = _cfg.W_DOUBLE      !== undefined ? _cfg.W_DOUBLE      : 0.5;

  // Move ordering weights (used in orderMoves())
  var MO_DOMINO     = _cfg.MO_DOMINO     !== undefined ? _cfg.MO_DOMINO     : 1000;
  var MO_DOUBLE     = _cfg.MO_DOUBLE     !== undefined ? _cfg.MO_DOUBLE     : 12;
  var MO_PIP_MULT   = _cfg.MO_PIP_MULT   !== undefined ? _cfg.MO_PIP_MULT   : 1.5;
  var MO_FORCE_PASS = _cfg.MO_FORCE_PASS !== undefined ? _cfg.MO_FORCE_PASS : 25;
  var MO_GHOST      = _cfg.MO_GHOST      !== undefined ? _cfg.MO_GHOST      : 15;

  // --- Zobrist hashing setup ---
  // Seeded xorshift32 PRNG for deterministic hash values
  var zobristSeed = 0x12345678;
  function xorshift32() {
    zobristSeed ^= zobristSeed << 13;
    zobristSeed ^= zobristSeed >>> 17;
    zobristSeed ^= zobristSeed << 5;
    return zobristSeed >>> 0; // unsigned
  }

  // Map tile id strings to indices 0-27 for array lookups
  var TILE_ID_TO_INDEX = {};
  (function () {
    var idx = 0;
    for (var i = 0; i <= 6; i++) {
      for (var j = i; j <= 6; j++) {
        TILE_ID_TO_INDEX[i + '-' + j] = idx++;
      }
    }
  })();

  // Pre-compute Zobrist hash values
  // TILE_HASH[tileIndex][hand]: hand 0=AI, 1=Human
  var TILE_HASH = new Array(28);
  for (var ti = 0; ti < 28; ti++) {
    TILE_HASH[ti] = [xorshift32(), xorshift32()];
  }
  // LEFT_HASH[value]: board left end 0-6, 7=null
  var LEFT_HASH = new Array(8);
  for (var li = 0; li < 8; li++) LEFT_HASH[li] = xorshift32();
  // RIGHT_HASH[value]: board right end 0-6, 7=null
  var RIGHT_HASH = new Array(8);
  for (var ri = 0; ri < 8; ri++) RIGHT_HASH[ri] = xorshift32();
  // Side-to-move hash
  var SIDE_HASH = xorshift32();
  // Consecutive pass hash (0 or 1)
  var CONSPASS_HASH = [xorshift32(), xorshift32()];

  // --- Transposition Table (flat typed arrays for cache performance) ---
  var TT_SIZE = 1 << 20; // 1048576 entries (~10MB total)
  var TT_MASK = TT_SIZE - 1;
  var ttHash   = new Int32Array(TT_SIZE);
  var ttDepth  = new Int8Array(TT_SIZE);
  var ttFlag   = new Uint8Array(TT_SIZE);  // 0=empty, 1=EXACT, 2=LOWER, 3=UPPER
  var ttValue  = new Int16Array(TT_SIZE);
  var ttBestIdx = new Int8Array(TT_SIZE);  // best move tile index
  var ttBestEnd = new Int8Array(TT_SIZE);  // best move end code

  var TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;

  function ttClear() {
    // Only need to clear flags — 0 means empty
    for (var i = 0; i < TT_SIZE; i++) ttFlag[i] = 0;
  }

  function ttProbe(hash, depth, alpha, beta) {
    var idx = (hash & TT_MASK) >>> 0;
    if (ttFlag[idx] === 0) return null; // empty slot
    if ((ttHash[idx] | 0) !== (hash | 0)) return null; // hash mismatch

    var result = { bestIdx: ttBestIdx[idx], bestEnd: ttBestEnd[idx], score: null };

    if (ttDepth[idx] >= depth) {
      var val = ttValue[idx];
      var flag = ttFlag[idx];
      if (flag === TT_EXACT) {
        result.score = val;
      } else if (flag === TT_LOWER && val >= beta) {
        result.score = val;
      } else if (flag === TT_UPPER && val <= alpha) {
        result.score = val;
      }
    }
    return result;
  }

  function ttStore(hash, depth, flag, value, bestIdx, bestEnd) {
    var idx = (hash & TT_MASK) >>> 0;
    // Always-replace if: empty, or new depth >= stored depth
    if (ttFlag[idx] === 0 || depth >= ttDepth[idx]) {
      ttHash[idx] = hash | 0;
      ttDepth[idx] = depth;
      ttFlag[idx] = flag;
      ttValue[idx] = value;
      ttBestIdx[idx] = bestIdx;
      ttBestEnd[idx] = bestEnd;
    }
  }

  // Compute initial Zobrist hash for the root position
  function computeHash(aiTiles, humanTiles, left, right, isAI, consPass) {
    var h = 0;
    for (var i = 0; i < aiTiles.length; i++) {
      h ^= TILE_HASH[TILE_ID_TO_INDEX[aiTiles[i].id]][0];
    }
    for (var i = 0; i < humanTiles.length; i++) {
      h ^= TILE_HASH[TILE_ID_TO_INDEX[humanTiles[i].id]][1];
    }
    h ^= LEFT_HASH[left === null ? 7 : left];
    h ^= RIGHT_HASH[right === null ? 7 : right];
    if (!isAI) h ^= SIDE_HASH;
    if (consPass > 0) h ^= CONSPASS_HASH[Math.min(consPass, 1)];
    return h;
  }

  // --- Search depth by game phase ---
  function getMaxDepth(totalTiles) {
    if (totalTiles <= 10) return 50;  // full solve
    if (totalTiles <= 14) return 28;  // deep solve
    if (totalTiles <= 18) return 20;
    if (totalTiles <= 22) return 16;
    return 12;
  }

  // --- Lightweight helpers (no object allocation in hot path) ---

  // Simulate placing tile on board, return new [leftEnd, rightEnd]
  function simPlace(left, right, tile, end) {
    if (left === null) {
      // First tile on empty board
      return [tile.low, tile.high];
    }
    if (end === 'left') {
      if (tile.high === left) return [tile.low, right];
      return [tile.high, right];
    } else {
      if (tile.low === right) return [left, tile.high];
      return [left, tile.low];
    }
  }

  // Get legal moves for a tile array given board ends [left, right]
  function getMoves(tiles, left, right) {
    var moves = [];
    if (left === null) {
      for (var i = 0; i < tiles.length; i++) {
        moves.push(i, -1); // index, end (-1 = left for empty board)
      }
      return moves;
    }
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      var canL = (t.low === left || t.high === left);
      var canR = (t.low === right || t.high === right);
      if (canL) moves.push(i, 0); // 0 = left
      if (canR && left !== right) {
        moves.push(i, 1); // 1 = right
      } else if (canR && left === right && !canL) {
        moves.push(i, 1);
      }
    }
    return moves;
  }

  // Count legal moves (just the count, no allocation)
  function countMoves(tiles, left, right) {
    if (left === null) return tiles.length;
    var c = 0;
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      var canL = (t.low === left || t.high === left);
      var canR = (t.low === right || t.high === right);
      if (canL) c++;
      if (canR && left !== right) c++;
      else if (canR && left === right && !canL) c++;
    }
    return c;
  }

  // Pip total with Ghost 13
  function totalPips(tiles, left, right) {
    var sum = 0;
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      if (t.low === 0 && t.high === 0 && left !== 0 && right !== 0) {
        sum += 13;
      } else {
        sum += t.low + t.high;
      }
    }
    return sum;
  }

  // Remove tile at index, return new array
  function removeTile(tiles, idx) {
    var a = new Array(tiles.length - 1);
    for (var i = 0, j = 0; i < tiles.length; i++) {
      if (i !== idx) a[j++] = tiles[i];
    }
    return a;
  }

  // Does tile array contain [0-0]?
  function has00(tiles) {
    for (var i = 0; i < tiles.length; i++) {
      if (tiles[i].low === 0 && tiles[i].high === 0) return true;
    }
    return false;
  }

  // --- Terminal scoring (from AI's perspective, positive = good) ---

  function scoreDomino(winnerIsAI, loserTiles, left, right) {
    var pips = totalPips(loserTiles, left, right);
    return winnerIsAI ? pips : -pips;
  }

  // Puppeteer detection: mirrors game.js checkPuppeteer() logic.
  // Checks if the second-to-last placer (p2) forced the last placer (p1)
  // into a single legal tile where every placement of that tile blocks.
  //
  // p1Who/p1L/p1R/p1Tile: last placement info (who, board-ends-after, tile played)
  // p2Who/p2L/p2R: second-to-last placement info (who, board-ends-after)
  // lastPlacerTiles: the last placer's current hand (AFTER their move)
  // otherTiles: the other player's current hand
  //
  // Returns the aggressor: 1 = AI, 0 = human
  function detectAggressor(p1Who, p1L, p1R, p1Tile, p2Who, p2L, p2R,
                           lastPlacerTiles, otherTiles) {
    // Need 2 placements to check Puppeteer
    if (p2Who === -1 || p1Tile === null) return p1Who;

    // Reconstruct the last placer's hand BEFORE their move
    // (current hand + the tile they played)
    var forcedHand = new Array(lastPlacerTiles.length + 1);
    for (var i = 0; i < lastPlacerTiles.length; i++) {
      forcedHand[i] = lastPlacerTiles[i];
    }
    forcedHand[lastPlacerTiles.length] = p1Tile;

    // Board ends after puppeteer's move (before the forced move) = p2L, p2R
    // Count unique legal tiles the forced player had at that board state
    var uniqueCount = 0;
    var theTile = null;
    for (var i = 0; i < forcedHand.length; i++) {
      var t = forcedHand[i];
      var canPlay = (t.low === p2L || t.high === p2L ||
                     t.low === p2R || t.high === p2R);
      if (canPlay) {
        // Deduplicate: check if we already counted this tile
        // (same tile object won't appear twice, but tiles with same values could
        //  in theory — in practice each tile is unique in a domino set)
        if (theTile === null || theTile !== t) {
          if (uniqueCount === 0) {
            theTile = t;
            uniqueCount = 1;
          } else if (uniqueCount === 1 && theTile !== t) {
            // More than 1 unique legal tile — Puppeteer does not apply
            return p1Who;
          }
        }
      }
    }

    // Must have exactly 1 legal tile
    if (uniqueCount !== 1) return p1Who;

    // Get all legal placements of that tile on the p2 board
    var canL = (theTile.low === p2L || theTile.high === p2L);
    var canR = (theTile.low === p2R || theTile.high === p2R);
    if (p2L === p2R && canL) canR = false; // same end, don't double-count

    // Build hand after forced player plays the tile
    var forcedHandAfter = lastPlacerTiles; // already has tile removed

    // Check each placement: does it result in a block?
    if (canL) {
      var newEnds = simPlace(p2L, p2R, theTile, 'left');
      if (countMoves(otherTiles, newEnds[0], newEnds[1]) > 0 ||
          countMoves(forcedHandAfter, newEnds[0], newEnds[1]) > 0) {
        return p1Who; // This placement doesn't block
      }
    }
    if (canR) {
      var newEnds = simPlace(p2L, p2R, theTile, 'right');
      if (countMoves(otherTiles, newEnds[0], newEnds[1]) > 0 ||
          countMoves(forcedHandAfter, newEnds[0], newEnds[1]) > 0) {
        return p1Who; // This placement doesn't block
      }
    }

    // All placements of the forced tile cause a block → Puppeteer applies
    // The second-to-last placer (p2) is the aggressor
    return p2Who;
  }

  // Score a block terminal with Puppeteer-aware aggressor detection.
  // p1Who/p1L/p1R/p1Tile: most recent placement
  // p2Who/p2L/p2R: second-most-recent placement
  function scoreBlockPuppeteer(aiTiles, humanTiles, left, right,
                               p1Who, p1L, p1R, p1Tile, p2Who, p2L, p2R) {
    // Determine the last placer's tiles and opponent's tiles
    var lastPlacerTiles = (p1Who === 1) ? aiTiles : humanTiles;
    var otherTiles = (p1Who === 1) ? humanTiles : aiTiles;

    var aggressor = detectAggressor(p1Who, p1L, p1R, p1Tile, p2Who, p2L, p2R,
                                    lastPlacerTiles, otherTiles);

    var aiPips = totalPips(aiTiles, left, right);
    var humanPips = totalPips(humanTiles, left, right);

    var aggrPips = (aggressor === 1) ? aiPips : humanPips;
    var oppPips = (aggressor === 1) ? humanPips : aiPips;

    if (aggrPips <= oppPips) {
      // Successful block: aggressor wins, scores oppPips * 2
      var pts = oppPips * 2;
      return (aggressor === 1) ? pts : -pts;
    } else {
      // Failed block: opponent of aggressor wins, scores ALL pips
      var pts = aiPips + humanPips;
      return (aggressor === 1) ? -pts : pts;
    }
  }

  // --- Static evaluation for non-terminal nodes ---

  function evaluate(aiTiles, humanTiles, left, right) {
    var aiPips = totalPips(aiTiles, left, right);
    var humanPips = totalPips(humanTiles, left, right);

    // 1. Pip advantage (lower pips = better for AI)
    var pipScore = (humanPips - aiPips) * W_PIP;

    // 2. Mobility advantage
    var aiMob = countMoves(aiTiles, left, right);
    var humanMob = countMoves(humanTiles, left, right);
    var mobScore = (aiMob - humanMob) * W_MOBILITY;

    // 3. Tile count advantage (fewer AI tiles = closer to domino)
    var tileScore = (humanTiles.length - aiTiles.length) * W_TILE;

    // 4. Suit control at board ends
    var suitScore = 0;
    if (left !== null) {
      var aiL = 0, aiR = 0, hL = 0, hR = 0;
      for (var i = 0; i < aiTiles.length; i++) {
        if (aiTiles[i].matches(left)) aiL++;
        if (left !== right && aiTiles[i].matches(right)) aiR++;
      }
      for (var i = 0; i < humanTiles.length; i++) {
        if (humanTiles[i].matches(left)) hL++;
        if (left !== right && humanTiles[i].matches(right)) hR++;
      }

      if (left === right) {
        // Both ends same value — suit control is doubly important
        suitScore = (aiL - hL) * W_SUIT * 2;
        // Human void on this value = locked on both ends
        if (hL === 0) suitScore += W_LOCKIN * 2 + W_LOCKIN_BOTH;
      } else {
        suitScore = (aiL + aiR - hL - hR) * W_SUIT;
        // 5. Lock-in bonus: if human has 0 tiles for an end value → huge bonus
        if (hL === 0) suitScore += W_LOCKIN;
        if (hR === 0) suitScore += W_LOCKIN;
        if (hL === 0 && hR === 0) suitScore += W_LOCKIN_BOTH;
      }
    }

    // 6. Ghost 13 pressure: human has [0-0] and no 0 on either end
    var ghost = 0;
    if (has00(humanTiles) && left !== null && left !== 0 && right !== 0) {
      ghost = W_GHOST;
    }
    // AI has [0-0] and no 0 on ends — bad for AI
    if (has00(aiTiles) && left !== null && left !== 0 && right !== 0) {
      ghost -= W_GHOST;
    }

    // 7. Double liability: unplayed doubles are risky (only match one suit)
    var doublePen = 0;
    for (var i = 0; i < aiTiles.length; i++) {
      if (aiTiles[i].isDouble()) doublePen -= (aiTiles[i].pipCount() + 2) * W_DOUBLE;
    }
    for (var i = 0; i < humanTiles.length; i++) {
      if (humanTiles[i].isDouble()) doublePen += (humanTiles[i].pipCount() + 2) * W_DOUBLE;
    }

    return pipScore + mobScore + tileScore + suitScore + ghost + doublePen;
  }

  // --- Move ordering (for alpha-beta efficiency) ---
  // Returns indices into the moves flat array, sorted best-first.
  // moves is flat: [tileIdx, end, tileIdx, end, ...]

  function orderMoves(moves, myTiles, oppTiles, left, right, isAI, depth) {
    var n = moves.length / 2;
    if (n <= 1) return moves;

    var scored = new Array(n);
    for (var i = 0; i < n; i++) {
      var tIdx = moves[i * 2];
      var end = moves[i * 2 + 1];
      var tile = myTiles[tIdx];
      var s = 0;

      // Domino detection (last tile → instant win)
      if (myTiles.length === 1) s += MO_DOMINO;

      // Killer move bonus (uses global tile identity, not array index)
      var tileGlobalIdx = TILE_ID_TO_INDEX[tile.id];
      if (depth >= 0 && depth < MAX_DEPTH_SLOTS &&
          killerTileId[depth] === tileGlobalIdx && killerEnd[depth] === end) {
        s += 5000;
      }

      // History heuristic bonus
      var endCode = end + 1; // -1→0, 0→1, 1→2
      s += historyScore[tileGlobalIdx][endCode];

      // Doubles first (dispose liability)
      if (tile.isDouble()) s += MO_DOUBLE;

      // High-pip tiles (shed weight)
      s += tile.pipCount() * MO_PIP_MULT;

      // Check if this move forces opponent to have no moves
      var endStr = (end === 0 || end === -1) ? 'left' : 'right';
      var newEnds = simPlace(left, right, tile, endStr);
      var oppMob = countMoves(oppTiles, newEnds[0], newEnds[1]);
      if (oppMob === 0) s += MO_FORCE_PASS;

      // Ghost 13 exploitation
      if (isAI && has00(oppTiles) && newEnds[0] !== 0 && newEnds[1] !== 0) {
        s += MO_GHOST;
      }

      scored[i] = { i: i, s: s };
    }

    scored.sort(function (a, b) { return b.s - a.s; });

    var ordered = new Array(n * 2);
    for (var i = 0; i < n; i++) {
      var oi = scored[i].i;
      ordered[i * 2] = moves[oi * 2];
      ordered[i * 2 + 1] = moves[oi * 2 + 1];
    }
    return ordered;
  }

  // --- Move ordering enhancements ---

  // Killer moves: 1 killer per depth level (global tile index 0-27 + end code that caused beta cutoff)
  var MAX_DEPTH_SLOTS = 60;
  var killerTileId = new Int8Array(MAX_DEPTH_SLOTS); // global tile index (TILE_ID_TO_INDEX)
  var killerEnd = new Int8Array(MAX_DEPTH_SLOTS);     // end code (-1/0/1)

  // History heuristic: historyScore[tileIndex][endCode] updated on beta cutoffs
  // endCode: 0=left(-1), 1=left(0), 2=right(1) → mapped as end+1
  var historyScore = new Array(28);
  for (var hi = 0; hi < 28; hi++) historyScore[hi] = [0, 0, 0];

  function clearMoveOrderingData() {
    for (var k = 0; k < MAX_DEPTH_SLOTS; k++) {
      killerTileId[k] = -1;
      killerEnd[k] = -2; // invalid sentinel
    }
    for (var h = 0; h < 28; h++) {
      historyScore[h][0] = 0;
      historyScore[h][1] = 0;
      historyScore[h][2] = 0;
    }
  }

  // --- Minimax with Alpha-Beta ---

  var nodeCount = 0;
  var NODE_LIMIT = 5000000;

  // Placement history for Puppeteer detection:
  //   p1Who, p1L, p1R, p1Tile — most recent tile placement
  //   p2Who, p2L, p2R         — second-most-recent tile placement
  //   p1Who/p2Who: 1=AI, 0=human, -1=none
  //   p1L/p1R/p2L/p2R: board ends after that placement
  //   p1Tile: tile object played in most recent placement (null if none)
  //   hash: Zobrist hash of current position (incrementally updated)
  //   ext: extension budget consumed so far (starts 0, max 4)
  function minimax(aiTiles, humanTiles, left, right, isAI, depth, alpha, beta,
                   consPass, p1Who, p1L, p1R, p1Tile, p2Who, p2L, p2R, hash, ext) {
    nodeCount++;

    // Safety valve
    if (nodeCount >= NODE_LIMIT) {
      return evaluate(aiTiles, humanTiles, left, right);
    }

    var myTiles = isAI ? aiTiles : humanTiles;
    var oppTiles = isAI ? humanTiles : aiTiles;
    var moves = getMoves(myTiles, left, right);
    var numMoves = moves.length / 2;

    // No legal moves → must pass
    if (numMoves === 0) {
      var newConsPass = consPass + 1;
      if (newConsPass >= 2) {
        // Block: both players stuck — use Puppeteer-aware scoring
        return scoreBlockPuppeteer(aiTiles, humanTiles, left, right,
                                   p1Who, p1L, p1R, p1Tile, p2Who, p2L, p2R);
      }
      // Pass — update hash: flip side, update consPass
      var passHash = hash ^ SIDE_HASH;
      if (consPass > 0) passHash ^= CONSPASS_HASH[Math.min(consPass, 1)];
      if (newConsPass > 0) passHash ^= CONSPASS_HASH[Math.min(newConsPass, 1)];
      // Placement history unchanged through passes
      return minimax(aiTiles, humanTiles, left, right, !isAI, depth, alpha, beta,
                     newConsPass, p1Who, p1L, p1R, p1Tile, p2Who, p2L, p2R, passHash, ext);
    }

    // Depth limit — check for tactical extension before falling back to static eval
    if (depth <= 0) {
      // Quiescence: extend only in clearly tactical positions, with tight budget
      var extended = false;
      if (ext < 6) {
        var myMoveCount = numMoves;
        // Only extend when current side has exactly 1 forced move (no choice)
        // or when total tiles is low enough that we're near endgame
        var totalRemaining = aiTiles.length + humanTiles.length;
        if (myMoveCount === 1) {
          // Forced move — always extend (no branching cost)
          extended = true;
        } else if (totalRemaining <= 8) {
          // Near endgame — extend to try to solve exactly
          var oppMoveCount = countMoves(oppTiles, left, right);
          if (oppMoveCount <= 1) extended = true;
        }
      }
      if (extended) {
        depth = 1;
        ext = ext + 1;
      } else {
        return evaluate(aiTiles, humanTiles, left, right);
      }
    }

    // TT probe
    var ttHit = ttProbe(hash, depth, alpha, beta);
    var ttBestMoveIdx = -1, ttBestMoveEnd = -1;
    if (ttHit) {
      if (ttHit.score !== null) return ttHit.score;
      ttBestMoveIdx = ttHit.bestIdx;
      ttBestMoveEnd = ttHit.bestEnd;
    }

    // Order moves for better pruning (only if enough moves to matter)
    if (numMoves > 2) {
      moves = orderMoves(moves, myTiles, oppTiles, left, right, isAI, depth);
      numMoves = moves.length / 2;
    }

    // If TT has a best move (global tile index), move it to front
    if (ttBestMoveIdx >= 0) {
      for (var mi = 1; mi < numMoves; mi++) {
        var miGIdx = TILE_ID_TO_INDEX[myTiles[moves[mi * 2]].id];
        if (miGIdx === ttBestMoveIdx && moves[mi * 2 + 1] === ttBestMoveEnd) {
          // Swap with position 0
          var tmpI = moves[0], tmpE = moves[1];
          moves[0] = moves[mi * 2];
          moves[1] = moves[mi * 2 + 1];
          moves[mi * 2] = tmpI;
          moves[mi * 2 + 1] = tmpE;
          break;
        }
      }
    }

    var who = isAI ? 1 : 0;
    var bestMoveIdx = -1, bestMoveEnd = -1;
    var origAlpha = alpha;
    var origBeta = beta;

    if (isAI) {
      // Maximizing
      var best = -100000;
      for (var i = 0; i < numMoves; i++) {
        var tIdx = moves[i * 2];
        var end = moves[i * 2 + 1];
        var tile = myTiles[tIdx];
        var endStr = (end === 0 || end === -1) ? 'left' : 'right';
        var newEnds = simPlace(left, right, tile, endStr);
        var newAI = removeTile(aiTiles, tIdx);

        var tileGIdx = TILE_ID_TO_INDEX[tile.id];

        // Terminal: AI domino
        if (newAI.length === 0) {
          var sc = scoreDomino(true, humanTiles, newEnds[0], newEnds[1]);
          if (sc > best) { best = sc; bestMoveIdx = tileGIdx; bestMoveEnd = end; }
          if (best > alpha) alpha = best;
          if (beta <= alpha) break;
          continue;
        }

        // Terminal: immediate lock — use Puppeteer-aware scoring
        // New placement shifts history: old p1→p2, current move→p1
        if (countMoves(humanTiles, newEnds[0], newEnds[1]) === 0 &&
            countMoves(newAI, newEnds[0], newEnds[1]) === 0) {
          var sc = scoreBlockPuppeteer(newAI, humanTiles, newEnds[0], newEnds[1],
                                       who, newEnds[0], newEnds[1], tile,
                                       p1Who, p1L, p1R);
          if (sc > best) { best = sc; bestMoveIdx = tileGIdx; bestMoveEnd = end; }
          if (best > alpha) alpha = best;
          if (beta <= alpha) break;
          continue;
        }

        // Incremental hash update for child position:
        // XOR out: tile from AI hand, old left/right ends, side, consPass
        // XOR in:  new left/right ends, flipped side, consPass=0
        var childHash = hash;
        childHash ^= TILE_HASH[tileGIdx][0]; // remove tile from AI hand
        childHash ^= LEFT_HASH[left === null ? 7 : left]; // old left
        childHash ^= LEFT_HASH[newEnds[0]]; // new left
        childHash ^= RIGHT_HASH[right === null ? 7 : right]; // old right
        childHash ^= RIGHT_HASH[newEnds[1]]; // new right
        childHash ^= SIDE_HASH; // flip side (was AI, now human)
        if (consPass > 0) childHash ^= CONSPASS_HASH[Math.min(consPass, 1)]; // remove old consPass

        // Recurse — shift placement history: old p1→p2, current→p1
        var sc = minimax(newAI, humanTiles, newEnds[0], newEnds[1], false, depth - 1, alpha, beta,
                         0, who, newEnds[0], newEnds[1], tile, p1Who, p1L, p1R, childHash, ext);
        if (sc > best) { best = sc; bestMoveIdx = tileGIdx; bestMoveEnd = end; }
        if (best > alpha) alpha = best;
        if (beta <= alpha) {
          // Beta cutoff — record killer move (global tile index) and update history
          var gi = TILE_ID_TO_INDEX[tile.id];
          if (depth >= 0 && depth < MAX_DEPTH_SLOTS) {
            killerTileId[depth] = gi;
            killerEnd[depth] = end;
          }
          historyScore[gi][end + 1] += depth * depth;
          break;
        }
      }

    } else {
      // Minimizing (human turn)
      var best = 100000;
      for (var i = 0; i < numMoves; i++) {
        var tIdx = moves[i * 2];
        var end = moves[i * 2 + 1];
        var tile = myTiles[tIdx];
        var endStr = (end === 0 || end === -1) ? 'left' : 'right';
        var newEnds = simPlace(left, right, tile, endStr);
        var newHuman = removeTile(humanTiles, tIdx);
        var tileGIdx = TILE_ID_TO_INDEX[tile.id];

        // Terminal: human domino
        if (newHuman.length === 0) {
          var sc = scoreDomino(false, aiTiles, newEnds[0], newEnds[1]);
          if (sc < best) { best = sc; bestMoveIdx = tileGIdx; bestMoveEnd = end; }
          if (best < beta) beta = best;
          if (beta <= alpha) break;
          continue;
        }

        // Terminal: immediate lock — use Puppeteer-aware scoring
        if (countMoves(aiTiles, newEnds[0], newEnds[1]) === 0 &&
            countMoves(newHuman, newEnds[0], newEnds[1]) === 0) {
          var sc = scoreBlockPuppeteer(aiTiles, newHuman, newEnds[0], newEnds[1],
                                       who, newEnds[0], newEnds[1], tile,
                                       p1Who, p1L, p1R);
          if (sc < best) { best = sc; bestMoveIdx = tileGIdx; bestMoveEnd = end; }
          if (best < beta) beta = best;
          if (beta <= alpha) break;
          continue;
        }

        // Incremental hash update for child position:
        var childHash = hash;
        childHash ^= TILE_HASH[tileGIdx][1]; // remove tile from human hand
        childHash ^= LEFT_HASH[left === null ? 7 : left];
        childHash ^= LEFT_HASH[newEnds[0]];
        childHash ^= RIGHT_HASH[right === null ? 7 : right];
        childHash ^= RIGHT_HASH[newEnds[1]];
        childHash ^= SIDE_HASH; // flip side (was human, now AI)
        if (consPass > 0) childHash ^= CONSPASS_HASH[Math.min(consPass, 1)];

        // Recurse — shift placement history
        var sc = minimax(aiTiles, newHuman, newEnds[0], newEnds[1], true, depth - 1, alpha, beta,
                         0, who, newEnds[0], newEnds[1], tile, p1Who, p1L, p1R, childHash, ext);
        if (sc < best) { best = sc; bestMoveIdx = tileGIdx; bestMoveEnd = end; }
        if (best < beta) beta = best;
        if (beta <= alpha) {
          // Alpha cutoff (from minimizer's perspective) — record killer (global tile index) and history
          if (depth >= 0 && depth < MAX_DEPTH_SLOTS) {
            killerTileId[depth] = tileGIdx;
            killerEnd[depth] = end;
          }
          historyScore[tileGIdx][end + 1] += depth * depth;
          break;
        }
      }
    }

    // TT store with proper flag determination
    // Standard pattern: compare best against original alpha and beta
    var ttF;
    if (best <= origAlpha) {
      ttF = TT_UPPER; // All moves scored <= alpha → upper bound
    } else if (best >= origBeta) {
      ttF = TT_LOWER; // Beta cutoff → lower bound
    } else {
      ttF = TT_EXACT; // Score is within window
    }
    ttStore(hash, depth, ttF, best, bestMoveIdx, bestMoveEnd);

    return best;
  }

  // --- AIPlayer class ---

  class AIPlayer {
    constructor(difficulty) {
      this.difficulty = difficulty || 'easy';
    }

    chooseMove(legalMoves, engine) {
      if (legalMoves.length === 0) return null;
      if (legalMoves.length === 1) {
        return { move: legalMoves[0], bestScore: 0, depth: 0, nodes: 0, analysis: [] };
      }

      if (this.difficulty === 'hard') {
        return this.chooseMoveHard(legalMoves, engine);
      }
      return this.chooseMoveEasy(legalMoves);
    }

    chooseMoveEasy(legalMoves) {
      var move = legalMoves[Math.floor(Math.random() * legalMoves.length)];
      return { move: move, bestScore: 0, depth: 0, nodes: 0, analysis: [] };
    }

    chooseMoveHard(legalMoves, engine) {
      var hand = engine.hand;
      var aiTiles = hand.aiHand.tiles.slice();
      var humanTiles = hand.humanHand.tiles.slice();
      var board = hand.board;
      var left = board.isEmpty() ? null : board.leftEnd;
      var right = board.isEmpty() ? null : board.rightEnd;

      var totalTiles = aiTiles.length + humanTiles.length;
      var depthCeiling = getMaxDepth(totalTiles);

      ttClear();
      clearMoveOrderingData();

      // Seed placement history from engine's moveHistory (last 2 non-pass entries)
      var p1Who = -1, p1L = 0, p1R = 0, p1Tile = null;
      var p2Who = -1, p2L = 0, p2R = 0;
      var history = hand.moveHistory;
      var placementCount = 0;
      for (var hi = history.length - 1; hi >= 0 && placementCount < 2; hi--) {
        if (!history[hi].pass) {
          if (placementCount === 0) {
            p1Who = (history[hi].player === 'ai') ? 1 : 0;
            p1L = history[hi].boardEnds.left;
            p1R = history[hi].boardEnds.right;
            p1Tile = history[hi].tile;
          } else {
            p2Who = (history[hi].player === 'ai') ? 1 : 0;
            p2L = history[hi].boardEnds.left;
            p2R = history[hi].boardEnds.right;
          }
          placementCount++;
        }
      }

      // Compute initial Zobrist hash for root position (AI to move)
      var rootHash = computeHash(aiTiles, humanTiles, left, right, true, 0);

      // Build root moves (reused across iterations)
      var rootMoves = getMoves(aiTiles, left, right);
      var numMoves = rootMoves.length / 2;

      var bestMove = legalMoves[0];
      var TIME_BUDGET = _cfg.TIME_BUDGET !== undefined ? _cfg.TIME_BUDGET : 2000; // milliseconds
      var startTime = Date.now();
      var prevScore = 0; // for aspiration windows
      var lastDepth = 0;
      var lastNodes = 0;
      var rootScores = {};
      var committedScores = {};

      // Iterative deepening loop: depth 1, 2, 3, ... up to ceiling
      for (var iterDepth = 1; iterDepth <= depthCeiling; iterDepth++) {
        nodeCount = 0;

        // Re-order root moves using TT PV from previous iteration + killers/history
        var orderedMoves = rootMoves;
        if (numMoves > 2) {
          orderedMoves = orderMoves(rootMoves, aiTiles, humanTiles, left, right, true, iterDepth);
        }

        // Check TT for PV move from previous iteration — move it to front (uses global tile index)
        var pvHit = ttProbe(rootHash, 0, -100000, 100000);
        if (pvHit && pvHit.bestIdx >= 0) {
          for (var mi = 1; mi < numMoves; mi++) {
            var pvGIdx = TILE_ID_TO_INDEX[aiTiles[orderedMoves[mi * 2]].id];
            if (pvGIdx === pvHit.bestIdx && orderedMoves[mi * 2 + 1] === pvHit.bestEnd) {
              var tmpI = orderedMoves[0], tmpE = orderedMoves[1];
              orderedMoves[0] = orderedMoves[mi * 2];
              orderedMoves[1] = orderedMoves[mi * 2 + 1];
              orderedMoves[mi * 2] = tmpI;
              orderedMoves[mi * 2 + 1] = tmpE;
              break;
            }
          }
        }

        // Aspiration window: use narrow window around previous score (skip for depth 1)
        var ASP_WINDOW = 30;
        var alpha, beta;
        if (iterDepth <= 1) {
          alpha = -100000;
          beta = 100000;
        } else {
          alpha = prevScore - ASP_WINDOW;
          beta = prevScore + ASP_WINDOW;
        }

        var iterBestScore = -100000;
        var iterBestMove = null;
        var iterComplete = true;
        var aspFailed = false;

        // Aspiration search with re-search on fail
        for (var aspRetry = 0; aspRetry < 3; aspRetry++) {
          iterBestScore = -100000;
          iterBestMove = null;
          iterComplete = true;
          var curAlpha = alpha;

          for (var i = 0; i < numMoves; i++) {
            var tIdx = orderedMoves[i * 2];
            var end = orderedMoves[i * 2 + 1];
            var tile = aiTiles[tIdx];
            var endStr = (end === 0 || end === -1) ? 'left' : 'right';
            var newEnds = simPlace(left, right, tile, endStr);
            var newAI = removeTile(aiTiles, tIdx);

            var score;

            // Terminal: AI domino
            if (newAI.length === 0) {
              score = scoreDomino(true, humanTiles, newEnds[0], newEnds[1]);
            }
            // Terminal: immediate lock — Puppeteer-aware
            else if (countMoves(humanTiles, newEnds[0], newEnds[1]) === 0 &&
                     countMoves(newAI, newEnds[0], newEnds[1]) === 0) {
              score = scoreBlockPuppeteer(newAI, humanTiles, newEnds[0], newEnds[1],
                                          1, newEnds[0], newEnds[1], tile,
                                          p1Who, p1L, p1R);
            }
            // Recurse
            else {
              var tileIdx = TILE_ID_TO_INDEX[tile.id];
              var childHash = rootHash;
              childHash ^= TILE_HASH[tileIdx][0];
              childHash ^= LEFT_HASH[left === null ? 7 : left];
              childHash ^= LEFT_HASH[newEnds[0]];
              childHash ^= RIGHT_HASH[right === null ? 7 : right];
              childHash ^= RIGHT_HASH[newEnds[1]];
              childHash ^= SIDE_HASH;

              score = minimax(newAI, humanTiles, newEnds[0], newEnds[1], false, iterDepth - 1, curAlpha, beta,
                              0, 1, newEnds[0], newEnds[1], tile, p1Who, p1L, p1R, childHash, 0);
            }

            rootScores[tile.id + '_' + endStr] = score;

            if (score > iterBestScore) {
              iterBestScore = score;
              iterBestMove = this.findLegalMove(legalMoves, tile, endStr);
            }
            if (score > curAlpha) curAlpha = score;

            // Check if NODE_LIMIT hit during this iteration
            if (nodeCount >= NODE_LIMIT) {
              iterComplete = false;
              break;
            }
          }

          // Check aspiration window failures
          if (iterComplete && iterBestScore <= alpha) {
            // Fail low — widen window downward and re-search
            alpha = -100000;
            aspFailed = true;
            continue;
          }
          if (iterComplete && iterBestScore >= beta) {
            // Fail high — widen window upward and re-search
            beta = 100000;
            aspFailed = true;
            continue;
          }
          break; // Search within window succeeded
        }

        // Update best move: use completed iterations always, partial iterations
        // only if the partial best matches the previous best (PV confirmation)
        // or if it found a clearly winning move (terminal score)
        if (iterComplete && iterBestMove) {
          bestMove = iterBestMove;
          prevScore = iterBestScore;
          lastDepth = iterDepth;
          lastNodes = nodeCount;
          for (var rk in rootScores) committedScores[rk] = rootScores[rk];
        } else if (iterBestMove) {
          // Partial iteration: use result if it confirms PV or finds a forced win
          if (iterBestMove === bestMove || iterBestScore > 500) {
            bestMove = iterBestMove;
          }
        }

        // Store root position in TT for PV reuse in next iteration (global tile index)
        if (iterComplete) {
          for (var si = 0; si < numMoves; si++) {
            var sTile = aiTiles[orderedMoves[si * 2]];
            var sEnd = orderedMoves[si * 2 + 1];
            var sEndStr = (sEnd === 0 || sEnd === -1) ? 'left' : 'right';
            var sLM = this.findLegalMove(legalMoves, sTile, sEndStr);
            if (sLM === bestMove) {
              var sGIdx = TILE_ID_TO_INDEX[sTile.id];
              ttStore(rootHash, iterDepth, TT_EXACT, iterBestScore, sGIdx, sEnd);
              break;
            }
          }
        }

        // Early termination: exact solve (searched everything within node limit)
        if (iterComplete && nodeCount < NODE_LIMIT && iterDepth >= totalTiles) {
          break;
        }

        // Time check: if we've used > 50% of budget, don't start next iteration
        var elapsed = Date.now() - startTime;
        if (elapsed > TIME_BUDGET * 0.5) {
          break;
        }
      }

      // Build analysis array from committed scores
      var analysis = [];
      for (var key in committedScores) {
        var lastUnderscore = key.lastIndexOf('_');
        var tid = key.substring(0, lastUnderscore);
        var estr = key.substring(lastUnderscore + 1);
        analysis.push({ tileId: tid, end: estr, score: committedScores[key] });
      }
      analysis.sort(function (a, b) { return b.score - a.score; });

      return { move: bestMove, bestScore: prevScore, depth: lastDepth, nodes: lastNodes, analysis: analysis };
    }

    // Map internal tile+end to the engine's legalMoves array entry
    findLegalMove(legalMoves, tile, endStr) {
      for (var i = 0; i < legalMoves.length; i++) {
        if (legalMoves[i].tile === tile && legalMoves[i].end === endStr) {
          return legalMoves[i];
        }
      }
      // Fallback: same tile, any end
      for (var i = 0; i < legalMoves.length; i++) {
        if (legalMoves[i].tile === tile) return legalMoves[i];
      }
      return legalMoves[0];
    }

    evaluatePosition(engine) {
      var hand = engine.hand;
      var board = hand.board;
      var left = board.isEmpty() ? null : board.leftEnd;
      var right = board.isEmpty() ? null : board.rightEnd;
      return evaluate(hand.aiHand.tiles, hand.humanHand.tiles, left, right);
    }
  }

  D.OldAIPlayer = AIPlayer;

})(window.Domino);
