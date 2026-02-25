// ============================================================
// ai-worker.js — Self-contained Web Worker for Dominos AI
//   (Bitboard Engine + WASM)
//
// This file is a complete, standalone AI engine that runs inside
// a Web Worker. It has NO imports, NO DOM access, NO `window`.
// All AI logic from ai.js is replicated here, adapted for the
// worker context.
//
// WASM mode: if dominos_ai.js + dominos_ai_bg.wasm are available,
// uses Rust WASM engine for search. Falls back to JS on failure.
//
// Uses 28-bit integer bitmasks for hands, make/unmake with XOR,
// pre-computed lookup tables, and zero allocation in the hot path.
// ============================================================

'use strict';

// =====================================================================
// WASM ENGINE LOADING
// On HTTP: loads .wasm via fetch (efficient, streaming)
// On file://: fetch fails, falls back to base64-encoded JS file
// =====================================================================
var wasmReady = false;
var wasmChooseMove = null;

function wasmLoadedOk() {
  wasmReady = true;
  wasmChooseMove = wasm_bindgen.wasm_choose_move;
}

function tryBase64Fallback() {
  try {
    importScripts('./dominos_ai_base64.js');
    var binary = atob(WASM_BASE64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    wasm_bindgen.initSync({ module: bytes });
    wasmLoadedOk();
    console.log('[AI Worker] WASM loaded via base64 fallback (file://)');
  } catch(e2) {
    console.warn('[AI Worker] WASM base64 fallback failed, using JS engine:', e2);
  }
}

try {
  importScripts('./dominos_ai.js');
  // Try fetch first (works on HTTP servers)
  wasm_bindgen('./dominos_ai_bg.wasm').then(function() {
    wasmLoadedOk();
    console.log('[AI Worker] WASM engine loaded via fetch');
  }).catch(function(err) {
    // fetch failed (file:// protocol) — try base64 fallback
    console.warn('[AI Worker] fetch failed, trying base64 fallback:', err.message || err);
    tryBase64Fallback();
  });
} catch(e) {
  console.warn('[AI Worker] WASM not available, using JS fallback:', e);
  wasmReady = false;
}

// =====================================================================
// TILE INDEXING: double-six set, 28 tiles
// =====================================================================

var TILE_LOW = new Int8Array(28);
var TILE_HIGH = new Int8Array(28);
var TILE_PIPS = new Int8Array(28);
var TILE_IS_DOUBLE = new Uint8Array(28);

var TILE_ID_TO_INDEX = {};
var SUIT_MASK = new Int32Array(7);
var DOUBLE_MASK = 0;
var TILE_00_BIT = 0;
var ZERO_SUIT_NO_00 = 0;

(function () {
  var idx = 0;
  for (var i = 0; i <= 6; i++) {
    for (var j = i; j <= 6; j++) {
      TILE_LOW[idx] = i;
      TILE_HIGH[idx] = j;
      TILE_PIPS[idx] = i + j;
      TILE_IS_DOUBLE[idx] = (i === j) ? 1 : 0;
      TILE_ID_TO_INDEX[i + '-' + j] = idx;

      SUIT_MASK[i] |= (1 << idx);
      if (i !== j) SUIT_MASK[j] |= (1 << idx);

      if (i === j) DOUBLE_MASK |= (1 << idx);
      if (i === 0 && j === 0) TILE_00_BIT = 1 << idx;

      idx++;
    }
  }
  ZERO_SUIT_NO_00 = SUIT_MASK[0] & ~TILE_00_BIT;
})();

// =====================================================================
// PRECOMPUTED: new board end after placing tile on left/right
// =====================================================================

var NEW_END_LEFT = new Int8Array(28 * 8);
var NEW_END_RIGHT = new Int8Array(28 * 8);

(function () {
  for (var t = 0; t < 28; t++) {
    var lo = TILE_LOW[t], hi = TILE_HIGH[t];
    for (var v = 0; v <= 6; v++) {
      if (hi === v) {
        NEW_END_LEFT[t * 8 + v] = lo;
      } else if (lo === v) {
        NEW_END_LEFT[t * 8 + v] = hi;
      } else {
        NEW_END_LEFT[t * 8 + v] = -1;
      }
      if (lo === v) {
        NEW_END_RIGHT[t * 8 + v] = hi;
      } else if (hi === v) {
        NEW_END_RIGHT[t * 8 + v] = lo;
      } else {
        NEW_END_RIGHT[t * 8 + v] = -1;
      }
    }
    NEW_END_LEFT[t * 8 + 7] = lo;
    NEW_END_RIGHT[t * 8 + 7] = hi;
  }
})();

// =====================================================================
// POPCOUNT
// =====================================================================

function popcount(x) {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >> 24;
}

// =====================================================================
// EVALUATION WEIGHTS
// Allow external injection for tuning: set EVAL_WEIGHTS before loading
// =====================================================================

var _cfg = (typeof EVAL_WEIGHTS === 'object' && EVAL_WEIGHTS) || {};

var W_PIP         = _cfg.W_PIP         !== undefined ? _cfg.W_PIP         : 2;
var W_MOBILITY    = _cfg.W_MOBILITY    !== undefined ? _cfg.W_MOBILITY    : 4;
var W_TILE        = _cfg.W_TILE        !== undefined ? _cfg.W_TILE        : 5;
var W_SUIT        = _cfg.W_SUIT        !== undefined ? _cfg.W_SUIT        : 3;
var W_LOCKIN      = _cfg.W_LOCKIN      !== undefined ? _cfg.W_LOCKIN      : 8;
var W_LOCKIN_BOTH = _cfg.W_LOCKIN_BOTH !== undefined ? _cfg.W_LOCKIN_BOTH : 15;
var W_GHOST       = _cfg.W_GHOST       !== undefined ? _cfg.W_GHOST       : 10;
var W_DOUBLE      = _cfg.W_DOUBLE      !== undefined ? _cfg.W_DOUBLE      : 1.5;

var MO_DOMINO     = _cfg.MO_DOMINO     !== undefined ? _cfg.MO_DOMINO     : 1000;
var MO_DOUBLE     = _cfg.MO_DOUBLE     !== undefined ? _cfg.MO_DOUBLE     : 12;
var MO_PIP_MULT   = _cfg.MO_PIP_MULT   !== undefined ? _cfg.MO_PIP_MULT   : 1.5;
var MO_FORCE_PASS = _cfg.MO_FORCE_PASS !== undefined ? _cfg.MO_FORCE_PASS : 25;
var MO_GHOST      = _cfg.MO_GHOST      !== undefined ? _cfg.MO_GHOST      : 15;

// =====================================================================
// ZOBRIST HASHING
// =====================================================================

var zobristSeed = 0x12345678;
function xorshift32() {
  zobristSeed ^= zobristSeed << 13;
  zobristSeed ^= zobristSeed >>> 17;
  zobristSeed ^= zobristSeed << 5;
  return zobristSeed >>> 0;
}

var TILE_HASH = new Array(28);
for (var ti = 0; ti < 28; ti++) {
  TILE_HASH[ti] = [xorshift32(), xorshift32()];
}
var LEFT_HASH = new Array(8);
for (var li = 0; li < 8; li++) LEFT_HASH[li] = xorshift32();
var RIGHT_HASH = new Array(8);
for (var ri = 0; ri < 8; ri++) RIGHT_HASH[ri] = xorshift32();
var SIDE_HASH = xorshift32();
var CONSPASS_HASH = [xorshift32(), xorshift32()];

// =====================================================================
// TRANSPOSITION TABLE
// =====================================================================

var TT_SIZE = 1 << 22;
var TT_MASK = TT_SIZE - 1;
var ttHash   = new Int32Array(TT_SIZE);
var ttDepth  = new Int8Array(TT_SIZE);
var ttFlag   = new Uint8Array(TT_SIZE);
var ttValue  = new Int16Array(TT_SIZE);
var ttBestIdx = new Int8Array(TT_SIZE);
var ttBestEnd = new Int8Array(TT_SIZE);
var ttGen    = new Uint8Array(TT_SIZE);
var ttGeneration = 0;

var TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;

function ttClear() {
  for (var i = 0; i < TT_SIZE; i++) ttFlag[i] = 0;
}

function ttProbe(hash, depth, alpha, beta) {
  var idx = (hash & TT_MASK) >>> 0;
  if (ttFlag[idx] === 0) return null;
  if ((ttHash[idx] | 0) !== (hash | 0)) return null;

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
  if (ttFlag[idx] === 0 || ttGen[idx] !== ttGeneration || depth >= ttDepth[idx]) {
    ttHash[idx] = hash | 0;
    ttDepth[idx] = depth;
    ttFlag[idx] = flag;
    ttValue[idx] = value;
    ttBestIdx[idx] = bestIdx;
    ttBestEnd[idx] = bestEnd;
    ttGen[idx] = ttGeneration;
  }
}

// =====================================================================
// GLOBAL MUTABLE STATE
// =====================================================================

var gAiHand = 0;
var gHumanHand = 0;
var gLeft = 7;
var gRight = 7;
var gHash = 0;
var gPly = 0;
var gConsPass = 0;
var gMatchDiff = 0;

var gP1Who = -1, gP1L = 0, gP1R = 0, gP1Tile = -1;
var gP2Who = -1, gP2L = 0, gP2R = 0;

// =====================================================================
// PER-PLY MOVE STACKS
// =====================================================================

var MAX_PLY = 64;
var MOVE_BUF_SIZE = MAX_PLY * 28;
var MOVE_TILE_BUF = new Int8Array(MOVE_BUF_SIZE);
var MOVE_END_BUF  = new Int8Array(MOVE_BUF_SIZE);
var MOVE_SCORE_BUF = new Float64Array(MOVE_BUF_SIZE);

// =====================================================================
// MOVE GENERATION
// =====================================================================

function generateMoves(hand, left, right, ply) {
  var base = ply * 28;
  var count = 0;

  if (left === 7) {
    var h = hand;
    while (h) {
      var bit = h & (-h);
      var idx = 31 - Math.clz32(bit);
      MOVE_TILE_BUF[base + count] = idx;
      MOVE_END_BUF[base + count] = 0;
      count++;
      h ^= bit;
    }
    return count;
  }

  var leftMask = SUIT_MASK[left] & hand;
  var rightMask = SUIT_MASK[right] & hand;

  var m = leftMask;
  while (m) {
    var bit = m & (-m);
    var idx = 31 - Math.clz32(bit);
    MOVE_TILE_BUF[base + count] = idx;
    MOVE_END_BUF[base + count] = 0;
    count++;
    m ^= bit;
  }

  if (left !== right) {
    m = rightMask;
    while (m) {
      var bit = m & (-m);
      var idx = 31 - Math.clz32(bit);
      MOVE_TILE_BUF[base + count] = idx;
      MOVE_END_BUF[base + count] = 1;
      count++;
      m ^= bit;
    }
  } else {
    m = rightMask & ~leftMask;
    while (m) {
      var bit = m & (-m);
      var idx = 31 - Math.clz32(bit);
      MOVE_TILE_BUF[base + count] = idx;
      MOVE_END_BUF[base + count] = 1;
      count++;
      m ^= bit;
    }
  }

  return count;
}

function countMovesBB(hand, left, right) {
  if (left === 7) return popcount(hand);
  var leftMask = SUIT_MASK[left] & hand;
  var rightMask = SUIT_MASK[right] & hand;
  if (left === right) {
    return popcount(leftMask);
  }
  return popcount(leftMask | rightMask);
}

// =====================================================================
// PIP COUNTING
// =====================================================================

function totalPipsBB(hand, bothHands) {
  var sum = 0;
  var ghost13 = (hand & TILE_00_BIT) && ((bothHands & ZERO_SUIT_NO_00) === 0);
  var h = hand;
  while (h) {
    var bit = h & (-h);
    var idx = 31 - Math.clz32(bit);
    if (idx === 0 && ghost13) {
      sum += 13;
    } else {
      sum += TILE_PIPS[idx];
    }
    h ^= bit;
  }
  return sum;
}

// =====================================================================
// TERMINAL SCORING
// =====================================================================

function scoreDominoBB(winnerIsAI, loserHand) {
  var pips = totalPipsBB(loserHand, loserHand);
  return winnerIsAI ? pips : -pips;
}

// =====================================================================
// PUPPETEER / AGGRESSOR DETECTION
// =====================================================================

function detectAggressorBB(p1Who, p1L, p1R, p1Tile, p2Who, p2L, p2R,
                            lastPlacerHand, otherHand) {
  if (p2Who === -1 || p1Tile === -1) return p1Who;

  var forcedHand = lastPlacerHand | (1 << p1Tile);

  var legalMask = 0;
  if (p2L === 7) {
    legalMask = forcedHand;
  } else {
    legalMask = (SUIT_MASK[p2L] | SUIT_MASK[p2R]) & forcedHand;
    if (p2L === p2R) legalMask = SUIT_MASK[p2L] & forcedHand;
  }

  var legalCount = popcount(legalMask);
  if (legalCount !== 1) return p1Who;

  var theTileIdx = 31 - Math.clz32(legalMask & (-legalMask));
  var lo = TILE_LOW[theTileIdx], hi = TILE_HIGH[theTileIdx];

  var canL = (lo === p2L || hi === p2L) && p2L !== 7;
  var canR = (lo === p2R || hi === p2R) && p2R !== 7;
  if (p2L === 7) { canL = true; canR = false; }
  if (p2L === p2R && canL) canR = false;

  var forcedHandAfter = lastPlacerHand;

  if (canL) {
    var newL = NEW_END_LEFT[theTileIdx * 8 + (p2L === 7 ? 7 : p2L)];
    var newR = (p2L === 7) ? NEW_END_RIGHT[theTileIdx * 8 + 7] : p2R;
    if (countMovesBB(otherHand, newL, newR) > 0 ||
        countMovesBB(forcedHandAfter, newL, newR) > 0) {
      return p1Who;
    }
  }
  if (canR) {
    var newR2 = NEW_END_RIGHT[theTileIdx * 8 + p2R];
    var newL2 = p2L;
    if (countMovesBB(otherHand, newL2, newR2) > 0 ||
        countMovesBB(forcedHandAfter, newL2, newR2) > 0) {
      return p1Who;
    }
  }

  return p2Who;
}

function scoreBlockBB() {
  var lastPlacerHand, otherHand;
  if (gP1Who === 1) {
    lastPlacerHand = gAiHand;
    otherHand = gHumanHand;
  } else {
    lastPlacerHand = gHumanHand;
    otherHand = gAiHand;
  }

  var aggressor = detectAggressorBB(gP1Who, gP1L, gP1R, gP1Tile,
                                     gP2Who, gP2L, gP2R,
                                     lastPlacerHand, otherHand);

  var bothHands = gAiHand | gHumanHand;
  var aiPips = totalPipsBB(gAiHand, bothHands);
  var humanPips = totalPipsBB(gHumanHand, bothHands);

  var aggrPips = (aggressor === 1) ? aiPips : humanPips;
  var oppPips = (aggressor === 1) ? humanPips : aiPips;

  if (aggrPips <= oppPips) {
    var pts = oppPips * 2;
    return (aggressor === 1) ? pts : -pts;
  } else {
    var pts = aiPips + humanPips;
    return (aggressor === 1) ? -pts : pts;
  }
}

// =====================================================================
// STATIC EVALUATION
// =====================================================================

function evaluateBB() {
  var left = gLeft, right = gRight;
  var aiHand = gAiHand, humanHand = gHumanHand;

  var bothHands = aiHand | humanHand;
  var aiPips = totalPipsBB(aiHand, bothHands);
  var humanPips = totalPipsBB(humanHand, bothHands);

  var pipScore = (humanPips - aiPips) * W_PIP;

  var aiMob = countMovesBB(aiHand, left, right);
  var humanMob = countMovesBB(humanHand, left, right);
  var mobScore = (aiMob - humanMob) * W_MOBILITY;

  var aiCount = popcount(aiHand);
  var humanCount = popcount(humanHand);
  var tileScore = (humanCount - aiCount) * W_TILE;

  var suitScore = 0;
  if (left !== 7) {
    if (left === right) {
      var aiL = popcount(SUIT_MASK[left] & aiHand);
      var hL = popcount(SUIT_MASK[left] & humanHand);
      suitScore = (aiL - hL) * W_SUIT * 2;
      if (hL === 0) suitScore += W_LOCKIN * 2 + W_LOCKIN_BOTH;
    } else {
      var aiL = popcount(SUIT_MASK[left] & aiHand);
      var aiR = popcount(SUIT_MASK[right] & aiHand);
      var hL = popcount(SUIT_MASK[left] & humanHand);
      var hR = popcount(SUIT_MASK[right] & humanHand);
      suitScore = (aiL + aiR - hL - hR) * W_SUIT;
      if (hL === 0) suitScore += W_LOCKIN;
      if (hR === 0) suitScore += W_LOCKIN;
      if (hL === 0 && hR === 0) suitScore += W_LOCKIN_BOTH;
    }
  }

  var ghost = 0;
  if ((bothHands & ZERO_SUIT_NO_00) === 0) {
    if (humanHand & TILE_00_BIT) ghost = W_GHOST;
    if (aiHand & TILE_00_BIT) ghost -= W_GHOST;
  }

  var doublePen = 0;
  var aiDoubles = aiHand & DOUBLE_MASK;
  while (aiDoubles) {
    var bit = aiDoubles & (-aiDoubles);
    var idx = 31 - Math.clz32(bit);
    doublePen -= (TILE_PIPS[idx] + 2) * W_DOUBLE;
    aiDoubles ^= bit;
  }
  var humanDoubles = humanHand & DOUBLE_MASK;
  while (humanDoubles) {
    var bit = humanDoubles & (-humanDoubles);
    var idx = 31 - Math.clz32(bit);
    doublePen += (TILE_PIPS[idx] + 2) * W_DOUBLE;
    humanDoubles ^= bit;
  }

  var totalRemaining = popcount(aiHand) + popcount(humanHand);
  var phasePip, phaseMob, phaseSuit, phaseDbl;
  if (totalRemaining >= 20) {
    phasePip = 0.7; phaseMob = 1.5; phaseSuit = 1.3; phaseDbl = 1.3;
  } else if (totalRemaining < 8) {
    phasePip = 1.5; phaseMob = 0.6; phaseSuit = 1.5; phaseDbl = 1.0;
  } else {
    phasePip = 1.0; phaseMob = 1.0; phaseSuit = 1.0; phaseDbl = 1.0;
  }

  if (gMatchDiff >= 50) {
    phasePip *= 1.4; phaseSuit *= 0.6;
  } else if (gMatchDiff <= -50) {
    phasePip *= 0.7; phaseSuit *= 1.5; phaseMob *= 1.3;
  }

  return pipScore * phasePip + mobScore * phaseMob + tileScore + suitScore * phaseSuit + ghost + doublePen * phaseDbl;
}

// =====================================================================
// MOVE ORDERING
// =====================================================================

var MAX_DEPTH_SLOTS = 64;
var killerTileId = new Int8Array(MAX_DEPTH_SLOTS * 2);
var killerEnd = new Int8Array(MAX_DEPTH_SLOTS * 2);

var historyScore = new Array(28);
for (var hi = 0; hi < 28; hi++) historyScore[hi] = [0, 0, 0];

function clearMoveOrderingData() {
  for (var k = 0; k < MAX_DEPTH_SLOTS * 2; k++) {
    killerTileId[k] = -1;
    killerEnd[k] = -2;
  }
  for (var h = 0; h < 28; h++) {
    historyScore[h][0] = 0;
    historyScore[h][1] = 0;
    historyScore[h][2] = 0;
  }
}

function orderMovesAtPly(ply, numMoves, isAI, depth) {
  if (numMoves <= 1) return;

  var base = ply * 28;
  var myHand = isAI ? gAiHand : gHumanHand;
  var oppHand = isAI ? gHumanHand : gAiHand;
  var left = gLeft, right = gRight;

  for (var i = 0; i < numMoves; i++) {
    var tIdx = MOVE_TILE_BUF[base + i];
    var end = MOVE_END_BUF[base + i];
    var s = 0;

    if (popcount(myHand) === 1) s += MO_DOMINO;

    if (depth >= 0 && depth < MAX_DEPTH_SLOTS) {
      var kd = depth * 2;
      if (killerTileId[kd] === tIdx && killerEnd[kd] === end) {
        s += 5000;
      } else if (killerTileId[kd + 1] === tIdx && killerEnd[kd + 1] === end) {
        s += 4500;
      }
    }

    s += historyScore[tIdx][end + 1];

    if (TILE_IS_DOUBLE[tIdx]) s += MO_DOUBLE;

    s += TILE_PIPS[tIdx] * MO_PIP_MULT;

    var newL, newR;
    if (left === 7) {
      newL = TILE_LOW[tIdx];
      newR = TILE_HIGH[tIdx];
    } else if (end === 0) {
      newL = NEW_END_LEFT[tIdx * 8 + left];
      newR = right;
    } else {
      newL = left;
      newR = NEW_END_RIGHT[tIdx * 8 + right];
    }
    if (countMovesBB(oppHand, newL, newR) === 0) s += MO_FORCE_PASS;

    if (isAI && (oppHand & TILE_00_BIT)) {
      var newBothHands = (myHand ^ (1 << tIdx)) | oppHand;
      if ((newBothHands & ZERO_SUIT_NO_00) === 0) s += MO_GHOST;
    }

    MOVE_SCORE_BUF[base + i] = s;
  }

  for (var i = 1; i < numMoves; i++) {
    var scoreI = MOVE_SCORE_BUF[base + i];
    var tileI = MOVE_TILE_BUF[base + i];
    var endI = MOVE_END_BUF[base + i];
    var j = i - 1;
    while (j >= 0 && MOVE_SCORE_BUF[base + j] < scoreI) {
      MOVE_SCORE_BUF[base + j + 1] = MOVE_SCORE_BUF[base + j];
      MOVE_TILE_BUF[base + j + 1] = MOVE_TILE_BUF[base + j];
      MOVE_END_BUF[base + j + 1] = MOVE_END_BUF[base + j];
      j--;
    }
    MOVE_SCORE_BUF[base + j + 1] = scoreI;
    MOVE_TILE_BUF[base + j + 1] = tileI;
    MOVE_END_BUF[base + j + 1] = endI;
  }
}

// =====================================================================
// MINIMAX WITH ALPHA-BETA
// =====================================================================

var nodeCount = 0;
var NODE_LIMIT = 20000000;
var timeStart = 0;
var TIME_BUDGET = _cfg.TIME_BUDGET !== undefined ? _cfg.TIME_BUDGET : 5000;

function minimaxBB(isAI, depth, alpha, beta, ext) {
  nodeCount++;

  if (nodeCount >= NODE_LIMIT) {
    return evaluateBB();
  }

  var myHand = isAI ? gAiHand : gHumanHand;
  var numMoves = generateMoves(myHand, gLeft, gRight, gPly);

  // No legal moves: must pass
  if (numMoves === 0) {
    var newConsPass = gConsPass + 1;
    if (newConsPass >= 2) {
      return scoreBlockBB();
    }
    var savedConsPass = gConsPass;
    var savedHash = gHash;

    gHash ^= SIDE_HASH;
    if (gConsPass > 0) gHash ^= CONSPASS_HASH[1];
    gConsPass = newConsPass;
    if (gConsPass > 0) gHash ^= CONSPASS_HASH[1];

    var score = minimaxBB(!isAI, depth, alpha, beta, ext);

    gHash = savedHash;
    gConsPass = savedConsPass;
    return score;
  }

  // Depth limit with quiescence
  if (depth <= 0) {
    var totalRemaining = popcount(gAiHand) + popcount(gHumanHand);
    var maxExt = 6 + Math.max(0, 12 - totalRemaining);
    var extended = false;
    if (ext < maxExt) {
      if (numMoves === 1) {
        extended = true;
      } else if (gConsPass > 0) {
        extended = true; // after a pass = tactically sharp
      } else if (totalRemaining <= 8) {
        var oppHand = isAI ? gHumanHand : gAiHand;
        if (countMovesBB(oppHand, gLeft, gRight) <= 1) extended = true;
      }
    }
    if (extended) {
      depth = 1;
      ext = ext + 1;
    } else {
      return evaluateBB();
    }
  }

  // TT probe
  var ttHit = ttProbe(gHash, depth, alpha, beta);
  var ttBestTile = -1, ttBestEndVal = -1;
  if (ttHit) {
    if (ttHit.score !== null) return ttHit.score;
    ttBestTile = ttHit.bestIdx;
    ttBestEndVal = ttHit.bestEnd;
  }

  // Move ordering
  if (numMoves > 2) {
    orderMovesAtPly(gPly, numMoves, isAI, depth);
  }

  // TT best move to front
  if (ttBestTile >= 0) {
    var base = gPly * 28;
    for (var mi = 1; mi < numMoves; mi++) {
      if (MOVE_TILE_BUF[base + mi] === ttBestTile &&
          MOVE_END_BUF[base + mi] === ttBestEndVal) {
        var tmpT = MOVE_TILE_BUF[base];
        var tmpE = MOVE_END_BUF[base];
        MOVE_TILE_BUF[base] = MOVE_TILE_BUF[base + mi];
        MOVE_END_BUF[base] = MOVE_END_BUF[base + mi];
        MOVE_TILE_BUF[base + mi] = tmpT;
        MOVE_END_BUF[base + mi] = tmpE;
        break;
      }
    }
  }

  // Save state for unmake
  var savedLeft = gLeft;
  var savedRight = gRight;
  var savedHash = gHash;
  var savedConsPass = gConsPass;
  var savedP1Who = gP1Who, savedP1L = gP1L, savedP1R = gP1R, savedP1Tile = gP1Tile;
  var savedP2Who = gP2Who, savedP2L = gP2L, savedP2R = gP2R;
  var savedPly = gPly;

  var who = isAI ? 1 : 0;
  var bestMoveIdx = -1, bestMoveEnd = -1;
  var origAlpha = alpha;
  var origBeta = beta;
  var base = gPly * 28;

  if (isAI) {
    // === MAXIMIZING ===
    var best = -100000;
    for (var i = 0; i < numMoves; i++) {
      var tIdx = MOVE_TILE_BUF[base + i];
      var end = MOVE_END_BUF[base + i];

      var bit = 1 << tIdx;
      gAiHand ^= bit;

      var newL, newR;
      if (savedLeft === 7) {
        newL = TILE_LOW[tIdx];
        newR = TILE_HIGH[tIdx];
      } else if (end === 0) {
        newL = NEW_END_LEFT[tIdx * 8 + savedLeft];
        newR = savedRight;
      } else {
        newL = savedLeft;
        newR = NEW_END_RIGHT[tIdx * 8 + savedRight];
      }
      gLeft = newL;
      gRight = newR;

      gHash = savedHash;
      gHash ^= TILE_HASH[tIdx][0];
      gHash ^= LEFT_HASH[savedLeft];
      gHash ^= LEFT_HASH[newL];
      gHash ^= RIGHT_HASH[savedRight];
      gHash ^= RIGHT_HASH[newR];
      gHash ^= SIDE_HASH;
      if (savedConsPass > 0) gHash ^= CONSPASS_HASH[1];
      gConsPass = 0;

      gP2Who = savedP1Who; gP2L = savedP1L; gP2R = savedP1R;
      gP1Who = 1; gP1L = newL; gP1R = newR; gP1Tile = tIdx;

      gPly = savedPly + 1;

      var sc;

      if (gAiHand === 0) {
        sc = scoreDominoBB(true, gHumanHand);
      } else if (countMovesBB(gHumanHand, newL, newR) === 0 &&
                 countMovesBB(gAiHand, newL, newR) === 0) {
        sc = scoreBlockBB();
      } else {
        sc = minimaxBB(false, depth - 1, alpha, beta, ext);
      }

      gAiHand ^= bit;
      gLeft = savedLeft; gRight = savedRight;
      gHash = savedHash; gConsPass = savedConsPass;
      gP1Who = savedP1Who; gP1L = savedP1L; gP1R = savedP1R; gP1Tile = savedP1Tile;
      gP2Who = savedP2Who; gP2L = savedP2L; gP2R = savedP2R;
      gPly = savedPly;

      if (sc > best) { best = sc; bestMoveIdx = tIdx; bestMoveEnd = end; }
      if (best > alpha) alpha = best;
      if (beta <= alpha) {
        if (depth >= 0 && depth < MAX_DEPTH_SLOTS) {
          var kd = depth * 2;
          if (killerTileId[kd] !== tIdx || killerEnd[kd] !== end) {
            killerTileId[kd + 1] = killerTileId[kd];
            killerEnd[kd + 1] = killerEnd[kd];
            killerTileId[kd] = tIdx;
            killerEnd[kd] = end;
          }
        }
        var hv = historyScore[tIdx][end + 1] + depth * depth;
        historyScore[tIdx][end + 1] = hv > 10000 ? 10000 : hv;
        break;
      }
    }

  } else {
    // === MINIMIZING ===
    var best = 100000;
    for (var i = 0; i < numMoves; i++) {
      var tIdx = MOVE_TILE_BUF[base + i];
      var end = MOVE_END_BUF[base + i];

      var bit = 1 << tIdx;
      gHumanHand ^= bit;

      var newL, newR;
      if (savedLeft === 7) {
        newL = TILE_LOW[tIdx];
        newR = TILE_HIGH[tIdx];
      } else if (end === 0) {
        newL = NEW_END_LEFT[tIdx * 8 + savedLeft];
        newR = savedRight;
      } else {
        newL = savedLeft;
        newR = NEW_END_RIGHT[tIdx * 8 + savedRight];
      }
      gLeft = newL;
      gRight = newR;

      gHash = savedHash;
      gHash ^= TILE_HASH[tIdx][1];
      gHash ^= LEFT_HASH[savedLeft];
      gHash ^= LEFT_HASH[newL];
      gHash ^= RIGHT_HASH[savedRight];
      gHash ^= RIGHT_HASH[newR];
      gHash ^= SIDE_HASH;
      if (savedConsPass > 0) gHash ^= CONSPASS_HASH[1];
      gConsPass = 0;

      gP2Who = savedP1Who; gP2L = savedP1L; gP2R = savedP1R;
      gP1Who = 0; gP1L = newL; gP1R = newR; gP1Tile = tIdx;

      gPly = savedPly + 1;

      var sc;

      if (gHumanHand === 0) {
        sc = scoreDominoBB(false, gAiHand);
      } else if (countMovesBB(gAiHand, newL, newR) === 0 &&
                 countMovesBB(gHumanHand, newL, newR) === 0) {
        sc = scoreBlockBB();
      } else {
        sc = minimaxBB(true, depth - 1, alpha, beta, ext);
      }

      gHumanHand ^= bit;
      gLeft = savedLeft; gRight = savedRight;
      gHash = savedHash; gConsPass = savedConsPass;
      gP1Who = savedP1Who; gP1L = savedP1L; gP1R = savedP1R; gP1Tile = savedP1Tile;
      gP2Who = savedP2Who; gP2L = savedP2L; gP2R = savedP2R;
      gPly = savedPly;

      if (sc < best) { best = sc; bestMoveIdx = tIdx; bestMoveEnd = end; }
      if (best < beta) beta = best;
      if (beta <= alpha) {
        if (depth >= 0 && depth < MAX_DEPTH_SLOTS) {
          var kd = depth * 2;
          if (killerTileId[kd] !== tIdx || killerEnd[kd] !== end) {
            killerTileId[kd + 1] = killerTileId[kd];
            killerEnd[kd + 1] = killerEnd[kd];
            killerTileId[kd] = tIdx;
            killerEnd[kd] = end;
          }
        }
        var hv = historyScore[tIdx][end + 1] + depth * depth;
        historyScore[tIdx][end + 1] = hv > 10000 ? 10000 : hv;
        break;
      }
    }
  }

  // TT store
  var ttF;
  if (best <= origAlpha) {
    ttF = TT_UPPER;
  } else if (best >= origBeta) {
    ttF = TT_LOWER;
  } else {
    ttF = TT_EXACT;
  }
  ttStore(gHash, depth, ttF, best, bestMoveIdx, bestMoveEnd);

  return best;
}

// =====================================================================
// COMPUTE ROOT HASH
// =====================================================================

function computeRootHash(aiHand, humanHand, left, right, isAI, consPass) {
  var h = 0;
  var a = aiHand;
  while (a) {
    var bit = a & (-a);
    var idx = 31 - Math.clz32(bit);
    h ^= TILE_HASH[idx][0];
    a ^= bit;
  }
  var hu = humanHand;
  while (hu) {
    var bit = hu & (-hu);
    var idx = 31 - Math.clz32(bit);
    h ^= TILE_HASH[idx][1];
    hu ^= bit;
  }
  h ^= LEFT_HASH[left];
  h ^= RIGHT_HASH[right];
  if (!isAI) h ^= SIDE_HASH;
  if (consPass > 0) h ^= CONSPASS_HASH[1];
  return h;
}

// =====================================================================
// MAIN SEARCH ENTRY POINT (for worker)
// =====================================================================

function chooseMoveHard(aiTileDescs, humanTileDescs, left, right, moveHistory, legalMoves, matchScore) {
  // Convert to bitmasks
  gAiHand = 0;
  for (var i = 0; i < aiTileDescs.length; i++) {
    var lo = Math.min(aiTileDescs[i].low, aiTileDescs[i].high);
    var hi = Math.max(aiTileDescs[i].low, aiTileDescs[i].high);
    gAiHand |= (1 << TILE_ID_TO_INDEX[lo + '-' + hi]);
  }
  gHumanHand = 0;
  for (var i = 0; i < humanTileDescs.length; i++) {
    var lo = Math.min(humanTileDescs[i].low, humanTileDescs[i].high);
    var hi = Math.max(humanTileDescs[i].low, humanTileDescs[i].high);
    gHumanHand |= (1 << TILE_ID_TO_INDEX[lo + '-' + hi]);
  }

  gLeft = (left === null) ? 7 : left;
  gRight = (right === null) ? 7 : right;
  gPly = 0;
  gConsPass = 0;
  gMatchDiff = (matchScore ? matchScore.ai - matchScore.human : 0);

  // Seed Puppeteer history
  gP1Who = -1; gP1L = 0; gP1R = 0; gP1Tile = -1;
  gP2Who = -1; gP2L = 0; gP2R = 0;
  var placementCount = 0;
  for (var hi = moveHistory.length - 1; hi >= 0 && placementCount < 2; hi--) {
    if (!moveHistory[hi].pass) {
      if (placementCount === 0) {
        gP1Who = (moveHistory[hi].player === 'ai') ? 1 : 0;
        gP1L = moveHistory[hi].boardLeft;
        gP1R = moveHistory[hi].boardRight;
        // Reconstruct tile index
        var tLo = Math.min(moveHistory[hi].tileLow, moveHistory[hi].tileHigh);
        var tHi = Math.max(moveHistory[hi].tileLow, moveHistory[hi].tileHigh);
        gP1Tile = TILE_ID_TO_INDEX[tLo + '-' + tHi];
      } else {
        gP2Who = (moveHistory[hi].player === 'ai') ? 1 : 0;
        gP2L = moveHistory[hi].boardLeft;
        gP2R = moveHistory[hi].boardRight;
      }
      placementCount++;
    }
  }

  var totalTiles = popcount(gAiHand) + popcount(gHumanHand);
  gHash = computeRootHash(gAiHand, gHumanHand, gLeft, gRight, true, 0);

  ttGeneration = (ttGeneration + 1) & 0xFF;
  clearMoveOrderingData();

  var bestMove = legalMoves[0];
  var prevScore = 0;
  var lastDepth = 0;
  var lastNodes = 0;
  var rootScores = {};
  var committedScores = {};
  timeStart = Date.now();

  // Adaptive time budget: more time for opening (wide tree), less for endgame (solved fast)
  var moveBudget;
  if (totalTiles >= 24) moveBudget = TIME_BUDGET * 2;       // Opening: 2x budget
  else if (totalTiles >= 18) moveBudget = TIME_BUDGET * 1.2; // Early mid: 1.2x budget
  else if (totalTiles >= 12) moveBudget = TIME_BUDGET;       // Mid-game: normal budget
  else moveBudget = Math.min(TIME_BUDGET, 1000);             // Endgame: 1s max (solves instantly)

  // Iterative deepening
  for (var iterDepth = 1; iterDepth <= 50; iterDepth++) {
    nodeCount = 0;

    var numMoves = generateMoves(gAiHand, gLeft, gRight, 0);

    if (numMoves > 2) {
      orderMovesAtPly(0, numMoves, true, iterDepth);
    }

    // TT PV move to front
    var pvHit = ttProbe(gHash, 0, -100000, 100000);
    if (pvHit && pvHit.bestIdx >= 0) {
      for (var mi = 1; mi < numMoves; mi++) {
        if (MOVE_TILE_BUF[mi] === pvHit.bestIdx &&
            MOVE_END_BUF[mi] === pvHit.bestEnd) {
          var tmpT = MOVE_TILE_BUF[0], tmpE = MOVE_END_BUF[0];
          MOVE_TILE_BUF[0] = MOVE_TILE_BUF[mi];
          MOVE_END_BUF[0] = MOVE_END_BUF[mi];
          MOVE_TILE_BUF[mi] = tmpT;
          MOVE_END_BUF[mi] = tmpE;
          break;
        }
      }
    }

    // Aspiration window
    var ASP_WINDOW = (iterDepth >= 6) ? 15 : 30;
    var alphaW, betaW;
    if (iterDepth <= 1) {
      alphaW = -100000;
      betaW = 100000;
    } else {
      alphaW = prevScore - ASP_WINDOW;
      betaW = prevScore + ASP_WINDOW;
    }

    var iterBestScore = -100000;
    var iterBestTileIdx = -1;
    var iterBestEnd = -1;
    var iterComplete = true;

    for (var aspRetry = 0; aspRetry < 3; aspRetry++) {
      iterBestScore = -100000;
      iterBestTileIdx = -1;
      iterBestEnd = -1;
      iterComplete = true;
      var curAlpha = alphaW;

      var rootAiHand = gAiHand;
      var rootHash = gHash;

      for (var i = 0; i < numMoves; i++) {
        var tIdx = MOVE_TILE_BUF[i];
        var end = MOVE_END_BUF[i];

        var bit = 1 << tIdx;
        gAiHand = rootAiHand ^ bit;

        var newL, newR;
        if (gLeft === 7) {
          newL = TILE_LOW[tIdx];
          newR = TILE_HIGH[tIdx];
        } else if (end === 0) {
          newL = NEW_END_LEFT[tIdx * 8 + gLeft];
          newR = gRight;
        } else {
          newL = gLeft;
          newR = NEW_END_RIGHT[tIdx * 8 + gRight];
        }

        var savedRootLeft = gLeft, savedRootRight = gRight;
        gLeft = newL; gRight = newR;

        gHash = rootHash;
        gHash ^= TILE_HASH[tIdx][0];
        gHash ^= LEFT_HASH[savedRootLeft];
        gHash ^= LEFT_HASH[newL];
        gHash ^= RIGHT_HASH[savedRootRight];
        gHash ^= RIGHT_HASH[newR];
        gHash ^= SIDE_HASH;

        gConsPass = 0;

        var savedRP1Who = gP1Who, savedRP1L = gP1L, savedRP1R = gP1R, savedRP1Tile = gP1Tile;
        var savedRP2Who = gP2Who, savedRP2L = gP2L, savedRP2R = gP2R;
        gP2Who = gP1Who; gP2L = gP1L; gP2R = gP1R;
        gP1Who = 1; gP1L = newL; gP1R = newR; gP1Tile = tIdx;

        gPly = 1;

        var score;

        if (gAiHand === 0) {
          score = scoreDominoBB(true, gHumanHand);
        } else if (countMovesBB(gHumanHand, newL, newR) === 0 &&
                   countMovesBB(gAiHand, newL, newR) === 0) {
          score = scoreBlockBB();
        } else {
          if (i === 0) {
            score = minimaxBB(false, iterDepth - 1, curAlpha, betaW, 0);
          } else {
            score = minimaxBB(false, iterDepth - 1, curAlpha, curAlpha + 1, 0);
            if (score > curAlpha && score < betaW) {
              score = minimaxBB(false, iterDepth - 1, curAlpha, betaW, 0);
            }
          }
        }

        gAiHand = rootAiHand;
        gLeft = savedRootLeft; gRight = savedRootRight;
        gHash = rootHash;
        gP1Who = savedRP1Who; gP1L = savedRP1L; gP1R = savedRP1R; gP1Tile = savedRP1Tile;
        gP2Who = savedRP2Who; gP2L = savedRP2L; gP2R = savedRP2R;
        gPly = 0;
        gConsPass = 0;

        rootScores[tIdx + '_' + end] = score;

        if (score > iterBestScore) {
          iterBestScore = score;
          iterBestTileIdx = tIdx;
          iterBestEnd = end;
        }
        if (score > curAlpha) curAlpha = score;

        if (nodeCount >= NODE_LIMIT) {
          iterComplete = false;
          break;
        }
      }

      if (iterComplete && iterBestScore <= alphaW) {
        alphaW = -100000;
        continue;
      }
      if (iterComplete && iterBestScore >= betaW) {
        betaW = 100000;
        continue;
      }
      break;
    }

    // Map result to legalMoves
    if (iterBestTileIdx >= 0) {
      var endStr = (iterBestEnd === 0) ? 'left' : 'right';
      var tileId = TILE_LOW[iterBestTileIdx] + '-' + TILE_HIGH[iterBestTileIdx];
      var mapped = findLegalMove(legalMoves, tileId, endStr);

      if (iterComplete && mapped) {
        bestMove = mapped;
        prevScore = iterBestScore;
        lastDepth = iterDepth;
        lastNodes = nodeCount;
        for (var key in rootScores) committedScores[key] = rootScores[key];
      } else if (mapped) {
        if (mapped === bestMove || iterBestScore > 500) {
          bestMove = mapped;
        }
      }
    }

    if (iterComplete && iterBestTileIdx >= 0) {
      ttStore(gHash, iterDepth, TT_EXACT, iterBestScore, iterBestTileIdx, iterBestEnd);
    }

    if (iterComplete && nodeCount < NODE_LIMIT && iterDepth >= totalTiles) {
      break;
    }

    // Time check (uses adaptive budget per move)
    var elapsed = Date.now() - timeStart;
    if (elapsed > moveBudget * 0.75) {
      break;
    }
  }

  // Build analysis array
  var analysis = [];
  for (var key in committedScores) {
    var parts = key.split('_');
    var ti = parseInt(parts[0]);
    var ei = parseInt(parts[1]);
    analysis.push({
      tileId: TILE_LOW[ti] + '-' + TILE_HIGH[ti],
      end: ei === 0 ? 'left' : 'right',
      score: committedScores[key]
    });
  }
  analysis.sort(function (a, b) { return b.score - a.score; });

  return { move: bestMove, bestScore: prevScore, depth: lastDepth, nodes: lastNodes, analysis: analysis };
}

function findLegalMove(legalMoves, tileId, endStr) {
  for (var i = 0; i < legalMoves.length; i++) {
    var lm = legalMoves[i];
    var lmId = Math.min(lm.tileLow, lm.tileHigh) + '-' + Math.max(lm.tileLow, lm.tileHigh);
    if (lmId === tileId && lm.end === endStr) {
      return lm;
    }
  }
  for (var i = 0; i < legalMoves.length; i++) {
    var lm = legalMoves[i];
    var lmId = Math.min(lm.tileLow, lm.tileHigh) + '-' + Math.max(lm.tileLow, lm.tileHigh);
    if (lmId === tileId) return lm;
  }
  return legalMoves[0];
}

// =====================================================================
// WORKER MESSAGE HANDLER
// =====================================================================

onmessage = function (e) {
  var data = e.data;

  // Allow per-message time budget override (for analysis mode)
  if (data.timeBudget !== undefined) {
    TIME_BUDGET = data.timeBudget;
  }

  var left = data.boardEmpty ? null : data.left;
  var right = data.boardEmpty ? null : data.right;

  var moveHistory = data.moveHistory || [];
  var legalMoves = data.legalMoves || [];

  // Trivial cases
  if (legalMoves.length === 0) {
    postMessage(null);
    return;
  }
  if (legalMoves.length === 1) {
    var lm = legalMoves[0];
    postMessage({ tileId: Math.min(lm.tileLow, lm.tileHigh) + '-' + Math.max(lm.tileLow, lm.tileHigh), end: lm.end, bestScore: 0, depth: 0, nodes: 0, analysis: [] });
    return;
  }

  // =====================================================================
  // WASM dispatch: send JSON to Rust engine, parse JSON response
  // Falls back to JS engine if WASM is not ready or fails
  // =====================================================================
  if (wasmReady && wasmChooseMove) {
    try {
      var wasmInput = JSON.stringify(data);
      var wasmOutput = wasmChooseMove(wasmInput);
      var wasmResult = JSON.parse(wasmOutput);

      if (wasmResult && wasmResult.tileId) {
        // Log TT diagnostics
        if (wasmResult.ttProbes !== undefined) {
          console.log('[WASM TT] probes=' + wasmResult.ttProbes +
            ' hits=' + wasmResult.ttHits +
            ' cutoffs=' + wasmResult.ttCutoffs +
            ' hints=' + wasmResult.ttHints +
            ' depth=' + wasmResult.depth +
            ' nodes=' + wasmResult.nodes +
            ' hitRate=' + (wasmResult.ttHits * 100 / Math.max(1, wasmResult.ttProbes)).toFixed(1) + '%' +
            ' cutoffRate=' + (wasmResult.ttCutoffs * 100 / Math.max(1, wasmResult.ttProbes)).toFixed(1) + '%');
        }
        postMessage(wasmResult);
        return;
      }
      // If WASM returned empty result, fall through to JS
      console.warn('[AI Worker] WASM returned empty result, falling back to JS');
    } catch (wasmErr) {
      console.warn('[AI Worker] WASM search failed, falling back to JS:', wasmErr);
    }
  }

  // =====================================================================
  // JS fallback: run the JS bitboard engine
  // =====================================================================
  var result = chooseMoveHard(data.aiTiles, data.humanTiles, left, right, moveHistory, legalMoves, data.matchScore);
  var best = result.move;

  // Post result back
  var bestId = Math.min(best.tileLow, best.tileHigh) + '-' + Math.max(best.tileLow, best.tileHigh);
  postMessage({ tileId: bestId, end: best.end, bestScore: result.bestScore, depth: result.depth, nodes: result.nodes, analysis: result.analysis });
};
