// ============================================================
// ai-worker.js — Self-contained Web Worker for Dominos AI
//
// This file is a complete, standalone AI engine that runs inside
// a Web Worker. It has NO imports, NO DOM access, NO `window`.
// All AI logic from ai.js is replicated here, adapted for the
// worker context.
// ============================================================

'use strict';

// --- Minimal Tile class ---

function Tile(low, high) {
  this.low = Math.min(low, high);
  this.high = Math.max(low, high);
  this.id = this.low + '-' + this.high;
}

Tile.prototype.matches = function (value) {
  return this.low === value || this.high === value;
};

Tile.prototype.isDouble = function () {
  return this.low === this.high;
};

Tile.prototype.pipCount = function () {
  return this.low + this.high;
};

Tile.prototype.otherSide = function (value) {
  if (this.low === value) return this.high;
  if (this.high === value) return this.low;
  return null;
};

// --- Tile cache: shared instances ---

var tileCache = {};

function getTile(low, high) {
  var lo = Math.min(low, high);
  var hi = Math.max(low, high);
  var key = lo + '-' + hi;
  if (!tileCache[key]) {
    tileCache[key] = new Tile(lo, hi);
  }
  return tileCache[key];
}

// Pre-populate cache with all 28 domino tiles
(function () {
  for (var i = 0; i <= 6; i++) {
    for (var j = i; j <= 6; j++) {
      getTile(i, j);
    }
  }
})();

// --- Configurable evaluation weights ---

var W_PIP         = 2;
var W_MOBILITY    = 4;
var W_TILE        = 5;
var W_SUIT        = 3;
var W_LOCKIN      = 8;
var W_LOCKIN_BOTH = 15;
var W_GHOST       = 10;
var W_DOUBLE      = 0.5;

// Move ordering weights
var MO_DOMINO     = 1000;
var MO_DOUBLE     = 12;
var MO_PIP_MULT   = 1.5;
var MO_FORCE_PASS = 25;
var MO_GHOST      = 15;

// --- Zobrist hashing setup ---

var zobristSeed = 0x12345678;
function xorshift32() {
  zobristSeed ^= zobristSeed << 13;
  zobristSeed ^= zobristSeed >>> 17;
  zobristSeed ^= zobristSeed << 5;
  return zobristSeed >>> 0;
}

// Map tile id strings to indices 0-27
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

// --- Transposition Table ---

var TT_SIZE = 1 << 18;
var TT_MASK = TT_SIZE - 1;
var ttHash   = new Int32Array(TT_SIZE);
var ttDepth  = new Int8Array(TT_SIZE);
var ttFlag   = new Uint8Array(TT_SIZE);
var ttValue  = new Int16Array(TT_SIZE);
var ttBestIdx = new Int8Array(TT_SIZE);
var ttBestEnd = new Int8Array(TT_SIZE);

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
  if (totalTiles <= 10) return 50;
  if (totalTiles <= 14) return 14;
  if (totalTiles <= 20) return 10;
  return 8;
}

// --- Lightweight helpers ---

function simPlace(left, right, tile, end) {
  if (left === null) {
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

function getMoves(tiles, left, right) {
  var moves = [];
  if (left === null) {
    for (var i = 0; i < tiles.length; i++) {
      moves.push(i, -1);
    }
    return moves;
  }
  for (var i = 0; i < tiles.length; i++) {
    var t = tiles[i];
    var canL = (t.low === left || t.high === left);
    var canR = (t.low === right || t.high === right);
    if (canL) moves.push(i, 0);
    if (canR && left !== right) {
      moves.push(i, 1);
    } else if (canR && left === right && !canL) {
      moves.push(i, 1);
    }
  }
  return moves;
}

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

function removeTile(tiles, idx) {
  var a = new Array(tiles.length - 1);
  for (var i = 0, j = 0; i < tiles.length; i++) {
    if (i !== idx) a[j++] = tiles[i];
  }
  return a;
}

function has00(tiles) {
  for (var i = 0; i < tiles.length; i++) {
    if (tiles[i].low === 0 && tiles[i].high === 0) return true;
  }
  return false;
}

// --- Terminal scoring ---

function scoreDomino(winnerIsAI, loserTiles, left, right) {
  var pips = totalPips(loserTiles, left, right);
  return winnerIsAI ? pips : -pips;
}

// Puppeteer detection
function detectAggressor(p1Who, p1L, p1R, p1Tile, p2Who, p2L, p2R,
                         lastPlacerTiles, otherTiles) {
  if (p2Who === -1 || p1Tile === null) return p1Who;

  var forcedHand = new Array(lastPlacerTiles.length + 1);
  for (var i = 0; i < lastPlacerTiles.length; i++) {
    forcedHand[i] = lastPlacerTiles[i];
  }
  forcedHand[lastPlacerTiles.length] = p1Tile;

  var uniqueCount = 0;
  var theTile = null;
  for (var i = 0; i < forcedHand.length; i++) {
    var t = forcedHand[i];
    var canPlay = (t.low === p2L || t.high === p2L ||
                   t.low === p2R || t.high === p2R);
    if (canPlay) {
      if (theTile === null || theTile !== t) {
        if (uniqueCount === 0) {
          theTile = t;
          uniqueCount = 1;
        } else if (uniqueCount === 1 && theTile !== t) {
          return p1Who;
        }
      }
    }
  }

  if (uniqueCount !== 1) return p1Who;

  var canL = (theTile.low === p2L || theTile.high === p2L);
  var canR = (theTile.low === p2R || theTile.high === p2R);
  if (p2L === p2R && canL) canR = false;

  var forcedHandAfter = lastPlacerTiles;

  if (canL) {
    var newEnds = simPlace(p2L, p2R, theTile, 'left');
    if (countMoves(otherTiles, newEnds[0], newEnds[1]) > 0 ||
        countMoves(forcedHandAfter, newEnds[0], newEnds[1]) > 0) {
      return p1Who;
    }
  }
  if (canR) {
    var newEnds = simPlace(p2L, p2R, theTile, 'right');
    if (countMoves(otherTiles, newEnds[0], newEnds[1]) > 0 ||
        countMoves(forcedHandAfter, newEnds[0], newEnds[1]) > 0) {
      return p1Who;
    }
  }

  return p2Who;
}

function scoreBlockPuppeteer(aiTiles, humanTiles, left, right,
                             p1Who, p1L, p1R, p1Tile, p2Who, p2L, p2R) {
  var lastPlacerTiles = (p1Who === 1) ? aiTiles : humanTiles;
  var otherTiles = (p1Who === 1) ? humanTiles : aiTiles;

  var aggressor = detectAggressor(p1Who, p1L, p1R, p1Tile, p2Who, p2L, p2R,
                                  lastPlacerTiles, otherTiles);

  var aiPips = totalPips(aiTiles, left, right);
  var humanPips = totalPips(humanTiles, left, right);

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

// --- Static evaluation ---

function evaluate(aiTiles, humanTiles, left, right) {
  var aiPips = totalPips(aiTiles, left, right);
  var humanPips = totalPips(humanTiles, left, right);

  var pipScore = (humanPips - aiPips) * W_PIP;

  var aiMob = countMoves(aiTiles, left, right);
  var humanMob = countMoves(humanTiles, left, right);
  var mobScore = (aiMob - humanMob) * W_MOBILITY;

  var tileScore = (humanTiles.length - aiTiles.length) * W_TILE;

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
    suitScore = (aiL + aiR - hL - hR) * W_SUIT;

    if (hL === 0 && left !== right) suitScore += W_LOCKIN;
    if (hR === 0 && left !== right) suitScore += W_LOCKIN;
    if (hL === 0 && hR === 0) suitScore += W_LOCKIN_BOTH;
  }

  var ghost = 0;
  if (has00(humanTiles) && left !== null && left !== 0 && right !== 0) {
    ghost = W_GHOST;
  }
  if (has00(aiTiles) && left !== null && left !== 0 && right !== 0) {
    ghost -= W_GHOST;
  }

  var doublePen = 0;
  for (var i = 0; i < aiTiles.length; i++) {
    if (aiTiles[i].isDouble()) doublePen -= (aiTiles[i].pipCount() + 2) * W_DOUBLE;
  }
  for (var i = 0; i < humanTiles.length; i++) {
    if (humanTiles[i].isDouble()) doublePen += (humanTiles[i].pipCount() + 2) * W_DOUBLE;
  }

  return pipScore + mobScore + tileScore + suitScore + ghost + doublePen;
}

// --- Move ordering ---

var MAX_DEPTH_SLOTS = 60;
var killerTileId = new Int8Array(MAX_DEPTH_SLOTS);
var killerEnd = new Int8Array(MAX_DEPTH_SLOTS);

var historyScore = new Array(28);
for (var hi = 0; hi < 28; hi++) historyScore[hi] = [0, 0, 0];

function clearMoveOrderingData() {
  for (var k = 0; k < MAX_DEPTH_SLOTS; k++) {
    killerTileId[k] = -1;
    killerEnd[k] = -2;
  }
  for (var h = 0; h < 28; h++) {
    historyScore[h][0] = 0;
    historyScore[h][1] = 0;
    historyScore[h][2] = 0;
  }
}

function orderMoves(moves, myTiles, oppTiles, left, right, isAI, depth) {
  var n = moves.length / 2;
  if (n <= 1) return moves;

  var scored = new Array(n);
  for (var i = 0; i < n; i++) {
    var tIdx = moves[i * 2];
    var end = moves[i * 2 + 1];
    var tile = myTiles[tIdx];
    var s = 0;

    if (myTiles.length === 1) s += MO_DOMINO;

    if (depth >= 0 && depth < MAX_DEPTH_SLOTS &&
        killerTileId[depth] === tIdx && killerEnd[depth] === end) {
      s += 5000;
    }

    var tileGlobalIdx = TILE_ID_TO_INDEX[tile.id];
    var endCode = end + 1;
    s += historyScore[tileGlobalIdx][endCode];

    if (tile.isDouble()) s += MO_DOUBLE;

    s += tile.pipCount() * MO_PIP_MULT;

    var endStr = (end === 0 || end === -1) ? 'left' : 'right';
    var newEnds = simPlace(left, right, tile, endStr);
    var oppMob = countMoves(oppTiles, newEnds[0], newEnds[1]);
    if (oppMob === 0) s += MO_FORCE_PASS;

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

// --- Minimax with Alpha-Beta ---

var nodeCount = 0;
var NODE_LIMIT = 1000000;

function minimax(aiTiles, humanTiles, left, right, isAI, depth, alpha, beta,
                 consPass, p1Who, p1L, p1R, p1Tile, p2Who, p2L, p2R, hash, ext) {
  nodeCount++;

  if (nodeCount >= NODE_LIMIT) {
    return evaluate(aiTiles, humanTiles, left, right);
  }

  var myTiles = isAI ? aiTiles : humanTiles;
  var oppTiles = isAI ? humanTiles : aiTiles;
  var moves = getMoves(myTiles, left, right);
  var numMoves = moves.length / 2;

  // No legal moves — must pass
  if (numMoves === 0) {
    var newConsPass = consPass + 1;
    if (newConsPass >= 2) {
      return scoreBlockPuppeteer(aiTiles, humanTiles, left, right,
                                 p1Who, p1L, p1R, p1Tile, p2Who, p2L, p2R);
    }
    var passHash = hash ^ SIDE_HASH;
    passHash ^= CONSPASS_HASH[Math.min(consPass, 1)];
    passHash ^= CONSPASS_HASH[Math.min(newConsPass, 1)];
    return minimax(aiTiles, humanTiles, left, right, !isAI, depth, alpha, beta,
                   newConsPass, p1Who, p1L, p1R, p1Tile, p2Who, p2L, p2R, passHash, ext);
  }

  // Depth limit with quiescence extension
  if (depth <= 0) {
    var extended = false;
    if (ext < 4) {
      var myMoveCount = numMoves;
      var oppMoveCount = countMoves(oppTiles, left, right);
      if (myMoveCount === 1 || oppMoveCount === 1) {
        extended = true;
      } else {
        for (var qi = 0; qi < numMoves; qi++) {
          var qTile = myTiles[moves[qi * 2]];
          var qEndStr = (moves[qi * 2 + 1] === 0 || moves[qi * 2 + 1] === -1) ? 'left' : 'right';
          var qEnds = simPlace(left, right, qTile, qEndStr);
          if (countMoves(oppTiles, qEnds[0], qEnds[1]) === 0) {
            extended = true;
            break;
          }
        }
      }
    }
    if (extended) {
      depth = 2;
      ext = ext + 2;
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

  // Order moves
  if (numMoves > 2) {
    moves = orderMoves(moves, myTiles, oppTiles, left, right, isAI, depth);
    numMoves = moves.length / 2;
  }

  // If TT has a best move, move it to front
  if (ttBestMoveIdx >= 0) {
    for (var mi = 1; mi < numMoves; mi++) {
      if (moves[mi * 2] === ttBestMoveIdx && moves[mi * 2 + 1] === ttBestMoveEnd) {
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

      // Terminal: AI domino
      if (newAI.length === 0) {
        var sc = scoreDomino(true, humanTiles, newEnds[0], newEnds[1]);
        if (sc > best) { best = sc; bestMoveIdx = tIdx; bestMoveEnd = end; }
        if (best > alpha) alpha = best;
        if (beta <= alpha) break;
        continue;
      }

      // Terminal: immediate lock
      if (countMoves(humanTiles, newEnds[0], newEnds[1]) === 0 &&
          countMoves(newAI, newEnds[0], newEnds[1]) === 0) {
        var sc = scoreBlockPuppeteer(newAI, humanTiles, newEnds[0], newEnds[1],
                                     who, newEnds[0], newEnds[1], tile,
                                     p1Who, p1L, p1R);
        if (sc > best) { best = sc; bestMoveIdx = tIdx; bestMoveEnd = end; }
        if (best > alpha) alpha = best;
        if (beta <= alpha) break;
        continue;
      }

      // Incremental hash update
      var tileIdx = TILE_ID_TO_INDEX[tile.id];
      var childHash = hash;
      childHash ^= TILE_HASH[tileIdx][0];
      childHash ^= LEFT_HASH[left === null ? 7 : left];
      childHash ^= LEFT_HASH[newEnds[0]];
      childHash ^= RIGHT_HASH[right === null ? 7 : right];
      childHash ^= RIGHT_HASH[newEnds[1]];
      childHash ^= SIDE_HASH;
      if (consPass > 0) childHash ^= CONSPASS_HASH[Math.min(consPass, 1)];

      var sc = minimax(newAI, humanTiles, newEnds[0], newEnds[1], false, depth - 1, alpha, beta,
                       0, who, newEnds[0], newEnds[1], tile, p1Who, p1L, p1R, childHash, ext);
      if (sc > best) { best = sc; bestMoveIdx = tIdx; bestMoveEnd = end; }
      if (best > alpha) alpha = best;
      if (beta <= alpha) {
        if (depth >= 0 && depth < MAX_DEPTH_SLOTS) {
          killerTileId[depth] = tIdx;
          killerEnd[depth] = end;
        }
        var gi = TILE_ID_TO_INDEX[tile.id];
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

      // Terminal: human domino
      if (newHuman.length === 0) {
        var sc = scoreDomino(false, aiTiles, newEnds[0], newEnds[1]);
        if (sc < best) { best = sc; bestMoveIdx = tIdx; bestMoveEnd = end; }
        if (best < beta) beta = best;
        if (beta <= alpha) break;
        continue;
      }

      // Terminal: immediate lock
      if (countMoves(aiTiles, newEnds[0], newEnds[1]) === 0 &&
          countMoves(newHuman, newEnds[0], newEnds[1]) === 0) {
        var sc = scoreBlockPuppeteer(aiTiles, newHuman, newEnds[0], newEnds[1],
                                     who, newEnds[0], newEnds[1], tile,
                                     p1Who, p1L, p1R);
        if (sc < best) { best = sc; bestMoveIdx = tIdx; bestMoveEnd = end; }
        if (best < beta) beta = best;
        if (beta <= alpha) break;
        continue;
      }

      // Incremental hash update
      var tileIdx = TILE_ID_TO_INDEX[tile.id];
      var childHash = hash;
      childHash ^= TILE_HASH[tileIdx][1];
      childHash ^= LEFT_HASH[left === null ? 7 : left];
      childHash ^= LEFT_HASH[newEnds[0]];
      childHash ^= RIGHT_HASH[right === null ? 7 : right];
      childHash ^= RIGHT_HASH[newEnds[1]];
      childHash ^= SIDE_HASH;
      if (consPass > 0) childHash ^= CONSPASS_HASH[Math.min(consPass, 1)];

      var sc = minimax(aiTiles, newHuman, newEnds[0], newEnds[1], true, depth - 1, alpha, beta,
                       0, who, newEnds[0], newEnds[1], tile, p1Who, p1L, p1R, childHash, ext);
      if (sc < best) { best = sc; bestMoveIdx = tIdx; bestMoveEnd = end; }
      if (best < beta) beta = best;
      if (beta <= alpha) {
        if (depth >= 0 && depth < MAX_DEPTH_SLOTS) {
          killerTileId[depth] = tIdx;
          killerEnd[depth] = end;
        }
        var gi = TILE_ID_TO_INDEX[tile.id];
        historyScore[gi][end + 1] += depth * depth;
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
  ttStore(hash, depth, ttF, best, bestMoveIdx, bestMoveEnd);

  return best;
}

// --- Find legal move helper (maps internal tile+end to legalMoves entry) ---

function findLegalMove(legalMoves, tile, endStr) {
  for (var i = 0; i < legalMoves.length; i++) {
    var lm = legalMoves[i];
    var lmTile = getTile(lm.tileLow, lm.tileHigh);
    if (lmTile === tile && lm.end === endStr) {
      return lm;
    }
  }
  // Fallback: same tile, any end
  for (var i = 0; i < legalMoves.length; i++) {
    var lm = legalMoves[i];
    var lmTile = getTile(lm.tileLow, lm.tileHigh);
    if (lmTile === tile) return lm;
  }
  return legalMoves[0];
}

// --- Hard AI search (top-level, mirrors AIPlayer.chooseMoveHard) ---

function chooseMoveHard(aiTiles, humanTiles, left, right, moveHistory, legalMoves) {
  var totalTiles = aiTiles.length + humanTiles.length;
  var depthCeiling = getMaxDepth(totalTiles);

  ttClear();
  clearMoveOrderingData();

  // Seed placement history from moveHistory (last 2 non-pass entries)
  var p1Who = -1, p1L = 0, p1R = 0, p1Tile = null;
  var p2Who = -1, p2L = 0, p2R = 0;
  var placementCount = 0;
  for (var hi = moveHistory.length - 1; hi >= 0 && placementCount < 2; hi--) {
    var entry = moveHistory[hi];
    if (!entry.pass) {
      if (placementCount === 0) {
        p1Who = (entry.player === 'ai') ? 1 : 0;
        p1L = entry.boardLeft;
        p1R = entry.boardRight;
        p1Tile = getTile(entry.tileLow, entry.tileHigh);
      } else {
        p2Who = (entry.player === 'ai') ? 1 : 0;
        p2L = entry.boardLeft;
        p2R = entry.boardRight;
      }
      placementCount++;
    }
  }

  // Compute initial Zobrist hash for root position (AI to move)
  var rootHash = computeHash(aiTiles, humanTiles, left, right, true, 0);

  // Build root moves
  var rootMoves = getMoves(aiTiles, left, right);
  var numMoves = rootMoves.length / 2;

  var bestMove = legalMoves[0];
  var TIME_BUDGET = 400;
  var startTime = Date.now();

  // Iterative deepening
  for (var iterDepth = 2; iterDepth <= depthCeiling; iterDepth += 2) {
    nodeCount = 0;

    var orderedMoves = rootMoves;
    if (numMoves > 2) {
      orderedMoves = orderMoves(rootMoves, aiTiles, humanTiles, left, right, true, iterDepth);
    }

    // Check TT for PV move from previous iteration
    var pvHit = ttProbe(rootHash, 0, -100000, 100000);
    if (pvHit && pvHit.bestIdx >= 0) {
      for (var mi = 1; mi < numMoves; mi++) {
        if (orderedMoves[mi * 2] === pvHit.bestIdx && orderedMoves[mi * 2 + 1] === pvHit.bestEnd) {
          var tmpI = orderedMoves[0], tmpE = orderedMoves[1];
          orderedMoves[0] = orderedMoves[mi * 2];
          orderedMoves[1] = orderedMoves[mi * 2 + 1];
          orderedMoves[mi * 2] = tmpI;
          orderedMoves[mi * 2 + 1] = tmpE;
          break;
        }
      }
    }

    var alpha = -100000;
    var beta = 100000;
    var iterBestScore = -100000;
    var iterBestMove = null;
    var iterComplete = true;

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
      // Terminal: immediate lock
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

        score = minimax(newAI, humanTiles, newEnds[0], newEnds[1], false, iterDepth - 1, alpha, beta,
                        0, 1, newEnds[0], newEnds[1], tile, p1Who, p1L, p1R, childHash, 0);
      }

      if (score > iterBestScore) {
        iterBestScore = score;
        iterBestMove = findLegalMove(legalMoves, tile, endStr);
      }
      if (score > alpha) alpha = score;

      if (nodeCount >= NODE_LIMIT) {
        iterComplete = false;
        break;
      }
    }

    if (iterComplete && iterBestMove) {
      bestMove = iterBestMove;
    } else if (iterBestMove && !bestMove) {
      bestMove = iterBestMove;
    }

    // Store root position in TT for PV reuse
    if (iterComplete) {
      for (var si = 0; si < numMoves; si++) {
        var sTile = aiTiles[orderedMoves[si * 2]];
        var sEnd = orderedMoves[si * 2 + 1];
        var sEndStr = (sEnd === 0 || sEnd === -1) ? 'left' : 'right';
        var sLM = findLegalMove(legalMoves, sTile, sEndStr);
        if (sLM === bestMove) {
          ttStore(rootHash, iterDepth, TT_EXACT, iterBestScore,
                  orderedMoves[si * 2], orderedMoves[si * 2 + 1]);
          break;
        }
      }
    }

    // Early termination: exact solve
    if (iterComplete && nodeCount < NODE_LIMIT && iterDepth >= totalTiles) {
      break;
    }

    // Time check
    var elapsed = Date.now() - startTime;
    if (elapsed > TIME_BUDGET * 0.6) {
      break;
    }
  }

  return bestMove;
}

// --- Worker message handler ---

onmessage = function (e) {
  var data = e.data;

  // Reconstruct Tile objects from plain {low, high} descriptors
  var aiTiles = [];
  for (var i = 0; i < data.aiTiles.length; i++) {
    aiTiles.push(getTile(data.aiTiles[i].low, data.aiTiles[i].high));
  }

  var humanTiles = [];
  for (var i = 0; i < data.humanTiles.length; i++) {
    humanTiles.push(getTile(data.humanTiles[i].low, data.humanTiles[i].high));
  }

  var left = data.boardEmpty ? null : data.left;
  var right = data.boardEmpty ? null : data.right;

  var moveHistory = data.moveHistory || [];
  var legalMoves = data.legalMoves || [];

  // Trivial cases: 0 or 1 legal moves
  if (legalMoves.length === 0) {
    postMessage(null);
    return;
  }
  if (legalMoves.length === 1) {
    var lm = legalMoves[0];
    postMessage({ tileId: Math.min(lm.tileLow, lm.tileHigh) + '-' + Math.max(lm.tileLow, lm.tileHigh), end: lm.end });
    return;
  }

  // Run the hard AI search
  var best = chooseMoveHard(aiTiles, humanTiles, left, right, moveHistory, legalMoves);

  // Post result back
  var resultTile = getTile(best.tileLow, best.tileHigh);
  postMessage({ tileId: resultTile.id, end: best.end });
};
