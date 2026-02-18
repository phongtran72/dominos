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

  // --- Search depth by game phase ---
  function getMaxDepth(totalTiles) {
    if (totalTiles <= 10) return 50;  // full solve
    if (totalTiles <= 14) return 14;
    if (totalTiles <= 20) return 10;
    return 8;
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

  function scoreBlock(aiTiles, humanTiles, left, right, lastPlacer) {
    var aiPips = totalPips(aiTiles, left, right);
    var humanPips = totalPips(humanTiles, left, right);

    var aggrPips = (lastPlacer === 1) ? aiPips : humanPips;
    var oppPips = (lastPlacer === 1) ? humanPips : aiPips;

    if (aggrPips <= oppPips) {
      // Successful block: aggressor wins, scores oppPips * 2
      var pts = oppPips * 2;
      return (lastPlacer === 1) ? pts : -pts;
    } else {
      // Failed block: opponent of aggressor wins, scores ALL pips
      var pts = aiPips + humanPips;
      return (lastPlacer === 1) ? -pts : pts;
    }
  }

  // --- Static evaluation for non-terminal nodes ---

  function evaluate(aiTiles, humanTiles, left, right) {
    var aiPips = totalPips(aiTiles, left, right);
    var humanPips = totalPips(humanTiles, left, right);

    // 1. Pip advantage (lower pips = better for AI)
    var pipScore = (humanPips - aiPips) * 2;

    // 2. Mobility advantage
    var aiMob = countMoves(aiTiles, left, right);
    var humanMob = countMoves(humanTiles, left, right);
    var mobScore = (aiMob - humanMob) * 4;

    // 3. Tile count advantage (fewer AI tiles = closer to domino)
    var tileScore = (humanTiles.length - aiTiles.length) * 5;

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
      suitScore = (aiL + aiR - hL - hR) * 3;

      // 5. Lock-in bonus: if human has 0 tiles for an end value → huge bonus
      if (hL === 0 && left !== right) suitScore += 8;
      if (hR === 0 && left !== right) suitScore += 8;
      if (hL === 0 && hR === 0) suitScore += 15; // total lock-in
    }

    // 6. Ghost 13 pressure: human has [0-0] and no 0 on either end
    var ghost = 0;
    if (has00(humanTiles) && left !== null && left !== 0 && right !== 0) {
      ghost = 10;
    }
    // AI has [0-0] and no 0 on ends — bad for AI
    if (has00(aiTiles) && left !== null && left !== 0 && right !== 0) {
      ghost -= 10;
    }

    // 7. Double liability: unplayed doubles are risky (only match one suit)
    var doublePen = 0;
    for (var i = 0; i < aiTiles.length; i++) {
      if (aiTiles[i].isDouble()) doublePen -= (aiTiles[i].pipCount() + 2) * 0.5;
    }
    for (var i = 0; i < humanTiles.length; i++) {
      if (humanTiles[i].isDouble()) doublePen += (humanTiles[i].pipCount() + 2) * 0.5;
    }

    return pipScore + mobScore + tileScore + suitScore + ghost + doublePen;
  }

  // --- Move ordering (for alpha-beta efficiency) ---
  // Returns indices into the moves flat array, sorted best-first.
  // moves is flat: [tileIdx, end, tileIdx, end, ...]

  function orderMoves(moves, myTiles, oppTiles, left, right, isAI) {
    var n = moves.length / 2;
    if (n <= 1) return moves;

    var scored = new Array(n);
    for (var i = 0; i < n; i++) {
      var tIdx = moves[i * 2];
      var end = moves[i * 2 + 1];
      var tile = myTiles[tIdx];
      var s = 0;

      // Domino detection (last tile → instant win)
      if (myTiles.length === 1) s += 1000;

      // Doubles first (dispose liability)
      if (tile.isDouble()) s += 12;

      // High-pip tiles (shed weight)
      s += tile.pipCount() * 1.5;

      // Check if this move forces opponent to have no moves
      var endStr = (end === 0 || end === -1) ? 'left' : 'right';
      var newEnds = simPlace(left, right, tile, endStr);
      var oppMob = countMoves(oppTiles, newEnds[0], newEnds[1]);
      if (oppMob === 0) s += 25; // forces pass

      // Ghost 13 exploitation
      if (isAI && has00(oppTiles) && newEnds[0] !== 0 && newEnds[1] !== 0) {
        s += 15;
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

  // lastPlacer: 1 = AI, 0 = human
  // isAI: true = AI's turn (maximizing), false = human's turn (minimizing)
  function minimax(aiTiles, humanTiles, left, right, isAI, depth, alpha, beta, lastPlacer, consPass) {
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
        // Block: both players stuck
        return scoreBlock(aiTiles, humanTiles, left, right, lastPlacer);
      }
      // Pass — don't consume depth (pass doesn't change state)
      return minimax(aiTiles, humanTiles, left, right, !isAI, depth, alpha, beta, lastPlacer, newConsPass);
    }

    // Depth limit → static eval
    if (depth <= 0) {
      return evaluate(aiTiles, humanTiles, left, right);
    }

    // Order moves for better pruning (only if enough moves to matter)
    if (numMoves > 2) {
      moves = orderMoves(moves, myTiles, oppTiles, left, right, isAI);
      numMoves = moves.length / 2;
    }

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
          if (sc > best) best = sc;
          if (best > alpha) alpha = best;
          if (beta <= alpha) break;
          continue;
        }

        // Terminal: immediate lock
        if (countMoves(humanTiles, newEnds[0], newEnds[1]) === 0 &&
            countMoves(newAI, newEnds[0], newEnds[1]) === 0) {
          var sc = scoreBlock(newAI, humanTiles, newEnds[0], newEnds[1], 1);
          if (sc > best) best = sc;
          if (best > alpha) alpha = best;
          if (beta <= alpha) break;
          continue;
        }

        var sc = minimax(newAI, humanTiles, newEnds[0], newEnds[1], false, depth - 1, alpha, beta, 1, 0);
        if (sc > best) best = sc;
        if (best > alpha) alpha = best;
        if (beta <= alpha) break;
      }
      return best;

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
          if (sc < best) best = sc;
          if (best < beta) beta = best;
          if (beta <= alpha) break;
          continue;
        }

        // Terminal: immediate lock
        if (countMoves(aiTiles, newEnds[0], newEnds[1]) === 0 &&
            countMoves(newHuman, newEnds[0], newEnds[1]) === 0) {
          var sc = scoreBlock(aiTiles, newHuman, newEnds[0], newEnds[1], 0);
          if (sc < best) best = sc;
          if (best < beta) beta = best;
          if (beta <= alpha) break;
          continue;
        }

        var sc = minimax(aiTiles, newHuman, newEnds[0], newEnds[1], true, depth - 1, alpha, beta, 0, 0);
        if (sc < best) best = sc;
        if (best < beta) beta = best;
        if (beta <= alpha) break;
      }
      return best;
    }
  }

  // --- AIPlayer class ---

  class AIPlayer {
    constructor(difficulty) {
      this.difficulty = difficulty || 'easy';
    }

    chooseMove(legalMoves, engine) {
      if (legalMoves.length === 0) return null;
      if (legalMoves.length === 1) return legalMoves[0];

      if (this.difficulty === 'hard') {
        return this.chooseMoveHard(legalMoves, engine);
      }
      return this.chooseMoveEasy(legalMoves);
    }

    chooseMoveEasy(legalMoves) {
      return legalMoves[Math.floor(Math.random() * legalMoves.length)];
    }

    chooseMoveHard(legalMoves, engine) {
      var hand = engine.hand;
      var aiTiles = hand.aiHand.tiles.slice();
      var humanTiles = hand.humanHand.tiles.slice();
      var board = hand.board;
      var left = board.isEmpty() ? null : board.leftEnd;
      var right = board.isEmpty() ? null : board.rightEnd;

      var totalTiles = aiTiles.length + humanTiles.length;
      var maxDepth = getMaxDepth(totalTiles);

      nodeCount = 0;

      var bestScore = -100000;
      var bestMove = legalMoves[0];

      // Build root moves and order them
      var rootMoves = getMoves(aiTiles, left, right);
      if (rootMoves.length / 2 > 2) {
        rootMoves = orderMoves(rootMoves, aiTiles, humanTiles, left, right, true);
      }

      var alpha = -100000;
      var beta = 100000;
      var numMoves = rootMoves.length / 2;

      for (var i = 0; i < numMoves; i++) {
        var tIdx = rootMoves[i * 2];
        var end = rootMoves[i * 2 + 1];
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
          score = scoreBlock(newAI, humanTiles, newEnds[0], newEnds[1], 1);
        }
        // Recurse
        else {
          score = minimax(newAI, humanTiles, newEnds[0], newEnds[1], false, maxDepth - 1, alpha, beta, 1, 0);
        }

        if (score > bestScore) {
          bestScore = score;
          // Map back to the legalMoves format expected by the engine
          bestMove = this.findLegalMove(legalMoves, tile, endStr);
        }

        if (score > alpha) alpha = score;
      }

      return bestMove;
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
  }

  D.AIPlayer = AIPlayer;

})(window.Domino);
