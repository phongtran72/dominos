// ============================================================
// ai.js — ENHANCED AI for Draw Variant (Imperfect Information)
//
// Strategic advantages over human:
//   1. Perfect tile tracking (knows exactly which tiles are unseen)
//   2. Bayesian inference (deduces opponent hand from draw/pass)
//   3. Endpoint locking (forces opponent to draw on values they lack)
//   4. Monte Carlo lookahead (samples opponent hands, simulates 3-ply)
//   5. Draw event analysis (extracts max info from each draw cycle)
//   6. Draw-forcing (prefer board ends with few unseen matches)
//   7. Boneyard depletion aggression (scale up as boneyard shrinks)
//   8. Bloated hand exploitation (steer toward blocks when human drew many)
//   9. Proactive scarcity (dominate suits early to create future locks)
//  10. Chain detection (plan consecutive plays, keep hand connected)
//  11. Endgame urgency (prioritize going out when hand is small)
//
// Easy: random legal move
// Hard: full strategic engine with all advantages
// ============================================================

(function (D) {
  'use strict';

  // ============================================================
  // TileTracker — tracks all 28 tiles and deduces opponent hand
  // ============================================================
  class TileTracker {
    constructor() {
      this.allTileIds = [];
      for (var i = 0; i <= 6; i++) {
        for (var j = i; j <= 6; j++) {
          this.allTileIds.push(i + '-' + j);
        }
      }
      this.reset();
    }

    reset() {
      // Location of each tile: 'ai', 'board', 'unseen'
      // 'unseen' = could be in human hand OR boneyard
      this.tileLocation = {};
      for (var i = 0; i < this.allTileIds.length; i++) {
        this.tileLocation[this.allTileIds[i]] = 'unseen';
      }

      // Values the human definitely CANNOT have
      this.humanLacksValues = {};

      // Track human's hand size: 9 initial + draws - plays
      this.humanDrawCount = 0;
      this.humanHandSize = 9;
    }

    // Mark AI's own tiles at hand start
    setAIHand(aiTiles) {
      for (var i = 0; i < aiTiles.length; i++) {
        this.tileLocation[aiTiles[i].id] = 'ai';
      }
    }

    // Human played a tile
    onHumanPlayed(tileId) {
      this.tileLocation[tileId] = 'board';
      this.humanHandSize--;
    }

    // AI played a tile
    onAIPlayed(tileId) {
      this.tileLocation[tileId] = 'board';
    }

    // Human drew from boneyard (we don't know what)
    onHumanDrew() {
      this.humanDrawCount++;
      this.humanHandSize++;
    }

    // Human couldn't play — lacks both board end values
    onHumanCouldntPlay(boardEnds) {
      if (boardEnds.left !== null) {
        this.humanLacksValues[boardEnds.left] = true;
      }
      if (boardEnds.right !== null) {
        this.humanLacksValues[boardEnds.right] = true;
      }
    }

    // Human passed (boneyard empty) — lacks both board end values
    onHumanPassed(boardEnds) {
      if (boardEnds.left !== null) {
        this.humanLacksValues[boardEnds.left] = true;
      }
      if (boardEnds.right !== null) {
        this.humanLacksValues[boardEnds.right] = true;
      }
    }

    // Get all unseen tile IDs
    getUnseenTiles() {
      var unseen = [];
      for (var i = 0; i < this.allTileIds.length; i++) {
        if (this.tileLocation[this.allTileIds[i]] === 'unseen') {
          unseen.push(this.allTileIds[i]);
        }
      }
      return unseen;
    }

    // Tiles that COULD be in human's hand (unseen + not eliminated)
    getPossibleHumanTiles() {
      var unseen = this.getUnseenTiles();
      var possible = [];
      var self = this;
      for (var i = 0; i < unseen.length; i++) {
        var parts = unseen[i].split('-');
        var low = parseInt(parts[0]);
        var high = parseInt(parts[1]);
        // If human lacks value X, they have NO tile containing X
        if (self.humanLacksValues[low] || self.humanLacksValues[high]) continue;
        possible.push(unseen[i]);
      }
      return possible;
    }

    // How many values does the human definitely lack?
    getHumanLackedValueCount() {
      return Object.keys(this.humanLacksValues).length;
    }

    // Does human lack a specific value?
    humanLacks(value) {
      return !!this.humanLacksValues[value];
    }
  }

  // ============================================================
  // AIPlayer — Enhanced with tracking, inference, lookahead
  // ============================================================
  class AIPlayer {
    constructor(difficulty) {
      this.difficulty = difficulty || 'easy';
      this.tracker = new TileTracker();
    }

    // Call at start of each hand
    initHand(engine) {
      this.tracker.reset();
      this.tracker.setAIHand(engine.hand.aiHand.tiles);
    }

    // Rebuild tracker from complete move history
    // Advantage #5: Draw event analysis — extracts max info from each draw cycle
    updateTracker(engine) {
      var hand = engine.hand;
      this.tracker.reset();
      this.tracker.setAIHand(hand.aiHand.tiles);

      var history = hand.moveHistory;
      var boardEndsAtMove = { left: null, right: null };

      for (var i = 0; i < history.length; i++) {
        var move = history[i];

        if (move.draw) {
          if (move.player === 'human') {
            // Advantage #5: First draw in a sequence = human had NO legal moves
            // so they lack both board end values at that point
            var isFirstDraw = (i === 0 || !history[i - 1].draw || history[i - 1].player !== 'human');
            if (isFirstDraw) {
              this.tracker.onHumanCouldntPlay(boardEndsAtMove);
            }
            this.tracker.onHumanDrew();
          } else {
            // AI drew — we know the tile
            this.tracker.tileLocation[move.tile.id] = 'ai';
          }
          continue;
        }

        if (move.pass) {
          if (move.player === 'human') {
            this.tracker.onHumanPassed(boardEndsAtMove);
          }
          continue;
        }

        // Regular play
        if (move.player === 'human') {
          this.tracker.onHumanPlayed(move.tile.id);
        } else {
          this.tracker.onAIPlayed(move.tile.id);
        }

        // Update board ends after placement
        if (move.boardEnds) {
          boardEndsAtMove = move.boardEnds;
        }
      }

      // Also incorporate engine's tracked passed values
      var humanPassedValues = hand.opponentPassedValues.human || [];
      for (var i = 0; i < humanPassedValues.length; i++) {
        this.tracker.humanLacksValues[humanPassedValues[i]] = true;
      }
    }

    chooseMove(legalMoves, engine) {
      if (!legalMoves || legalMoves.length === 0) return null;
      if (legalMoves.length === 1) {
        return { move: legalMoves[0], bestScore: 0, depth: 0, nodes: 1, analysis: [] };
      }

      if (this.difficulty === 'easy') {
        var idx = Math.floor(Math.random() * legalMoves.length);
        return { move: legalMoves[idx], bestScore: 0, depth: 0, nodes: 1, analysis: [] };
      }

      // --- Hard: Full strategic engine ---

      // Advantage #1: Perfect tile tracking — rebuild from history
      this.updateTracker(engine);

      var hand = engine.hand;
      var aiHand = hand.aiHand;
      var board = hand.board;
      var boneyard = hand.boneyard || [];
      var opponentPassedValues = hand.opponentPassedValues.human || [];

      // Score each move with enhanced heuristics
      var scored = [];
      for (var i = 0; i < legalMoves.length; i++) {
        var m = legalMoves[i];
        var score = this.scoreMove(m, aiHand, board, opponentPassedValues, boneyard);
        scored.push({ move: m, score: score });
      }

      // Advantage #4: Monte Carlo lookahead — ALWAYS run (no inference gate)
      // Sample possible opponent hands and simulate 3 turns ahead
      scored = this.applyLookahead(scored, engine);

      // Sort by score descending
      scored.sort(function (a, b) { return b.score - a.score; });

      // Build analysis array
      var analysis = scored.map(function (s) {
        return {
          tileId: s.move.tile.id,
          tileLow: s.move.tile.low,
          tileHigh: s.move.tile.high,
          end: s.move.end,
          score: Math.round(s.score * 10) / 10
        };
      });

      return {
        move: scored[0].move,
        bestScore: scored[0].score,
        depth: 3,
        nodes: legalMoves.length,
        analysis: analysis
      };
    }

    scoreMove(move, aiHand, board, opponentPassedValues, boneyard) {
      var tile = move.tile;
      var end = move.end;
      var score = 0;
      var tracker = this.tracker;

      // === 1. Play heavy tiles first (reduce pip risk) ===
      // Reduced weight — important but shouldn't dominate strategy
      score += tile.pipCount() * 1;

      // === 2. Play doubles early ===
      if (tile.isDouble()) {
        score += 5;
      }

      // === 3. Exploit opponent's passed values (basic) ===
      var newEnd = this.getNewBoardEnd(tile, end, board);
      if (newEnd !== null) {
        for (var i = 0; i < opponentPassedValues.length; i++) {
          if (newEnd === opponentPassedValues[i]) {
            score += 15;
          }
        }
      }

      // === Advantage #3: Endpoint locking with Bayesian tracking ===
      if (newEnd !== null && tracker.humanLacks(newEnd)) {
        score += 25;
      }

      // Double lock: BOTH board ends are values human lacks
      if (newEnd !== null) {
        var otherEnd = this.getOtherBoardEnd(end, board, tile);
        if (otherEnd !== null && tracker.humanLacks(newEnd) && tracker.humanLacks(otherEnd)) {
          score += 20;
        }
      }

      // === 5. Flexibility: keep board ends matching our remaining tiles ===
      var remainingTiles = [];
      for (var i = 0; i < aiHand.tiles.length; i++) {
        if (aiHand.tiles[i] !== tile) remainingTiles.push(aiHand.tiles[i]);
      }

      if (newEnd !== null) {
        var otherEnd = this.getOtherBoardEnd(end, board, tile);
        var matchCount = 0;
        for (var i = 0; i < remainingTiles.length; i++) {
          if (remainingTiles[i].matches(newEnd)) matchCount++;
          if (otherEnd !== null && otherEnd !== newEnd && remainingTiles[i].matches(otherEnd)) matchCount++;
        }
        score += matchCount * 3;
      }

      // === 6. Board end diversity ===
      if (newEnd !== null) {
        var otherEnd = this.getOtherBoardEnd(end, board, tile);
        if (otherEnd !== null && newEnd !== otherEnd) {
          score += 4;
        }
      }

      // === 7. Suit dominance ===
      var suitCount = 0;
      var playedValue = (end === 'left') ?
        (board.isEmpty() ? null : board.leftEnd) :
        (board.isEmpty() ? null : board.rightEnd);
      if (playedValue !== null) {
        for (var i = 0; i < remainingTiles.length; i++) {
          if (remainingTiles[i].matches(playedValue)) suitCount++;
        }
      }
      score += suitCount * 1;

      // === Advantage #1+2: Board scarcity exploitation ===
      if (newEnd !== null) {
        var knownTilesWithValue = 0;
        for (var v = 0; v <= 6; v++) {
          var id = Math.min(newEnd, v) + '-' + Math.max(newEnd, v);
          if (tracker.tileLocation[id] === 'ai' || tracker.tileLocation[id] === 'board') {
            knownTilesWithValue++;
          }
        }
        score += knownTilesWithValue * 2;
      }

      // === Advantage #2: Penalize ends where human likely has tiles ===
      if (newEnd !== null) {
        var possibleHumanTiles = tracker.getPossibleHumanTiles();
        var humanMatchCount = 0;
        for (var i = 0; i < possibleHumanTiles.length; i++) {
          var parts = possibleHumanTiles[i].split('-');
          var lo = parseInt(parts[0]);
          var hi = parseInt(parts[1]);
          if (lo === newEnd || hi === newEnd) humanMatchCount++;
        }
        score -= humanMatchCount * 1.5;
      }

      // === 10. Hand coverage diversity ===
      if (remainingTiles.length > 0) {
        var valueCoverage = {};
        for (var i = 0; i < remainingTiles.length; i++) {
          valueCoverage[remainingTiles[i].low] = true;
          valueCoverage[remainingTiles[i].high] = true;
        }
        score += Object.keys(valueCoverage).length * 1;
      }

      // === Advantage #6: Draw-forcing ===
      if (newEnd !== null) {
        var unseenTiles = tracker.getUnseenTiles();
        var unseenMatchingNewEnd = 0;
        for (var ui = 0; ui < unseenTiles.length; ui++) {
          var parts = unseenTiles[ui].split('-');
          var lo = parseInt(parts[0]);
          var hi = parseInt(parts[1]);
          if (lo === newEnd || hi === newEnd) unseenMatchingNewEnd++;
        }
        var drawForceBonus = Math.max(0, 5 - unseenMatchingNewEnd) * 3;
        score += drawForceBonus;
      }

      // === Advantage #7: Boneyard depletion aggression ===
      var boneyardSize = boneyard.length;
      var boneyardTotal = 10;
      if (boneyardSize < boneyardTotal && newEnd !== null) {
        var depletionFactor = 1 - (boneyardSize / boneyardTotal);
        var knownForValue = 0;
        for (var v = 0; v <= 6; v++) {
          var id = Math.min(newEnd, v) + '-' + Math.max(newEnd, v);
          if (tracker.tileLocation[id] === 'ai' || tracker.tileLocation[id] === 'board') {
            knownForValue++;
          }
        }
        score += knownForValue * depletionFactor * 3;
        if (tracker.humanLacks(newEnd)) {
          score += depletionFactor * 15;
        }
      }

      // === Advantage #8: Bloated hand exploitation ===
      if (newEnd !== null && tracker.humanHandSize > 9) {
        var humanBloat = tracker.humanHandSize - 9;
        var unseenAll = tracker.getUnseenTiles();
        var matchingEnds = 0;
        var otherEnd = this.getOtherBoardEnd(end, board, tile);
        for (var ui = 0; ui < unseenAll.length; ui++) {
          var parts = unseenAll[ui].split('-');
          var lo = parseInt(parts[0]);
          var hi = parseInt(parts[1]);
          if (lo === newEnd || hi === newEnd) matchingEnds++;
          if (otherEnd !== null && (lo === otherEnd || hi === otherEnd)) matchingEnds++;
        }
        var tightness = Math.max(0, 8 - matchingEnds);
        score += tightness * Math.min(humanBloat, 5) * 1.5;
      }

      // === Advantage #9: Proactive scarcity (suit domination) ===
      if (newEnd !== null) {
        var aiHoldsWithNewEnd = 0;
        for (var i = 0; i < remainingTiles.length; i++) {
          if (remainingTiles[i].low === newEnd || remainingTiles[i].high === newEnd) {
            aiHoldsWithNewEnd++;
          }
        }
        if (aiHoldsWithNewEnd >= 3) {
          score += 10;
        } else if (aiHoldsWithNewEnd >= 2) {
          score += 5;
        }
      }

      // === Advantage #10: Chain detection ===
      // After playing this tile, can AI chain consecutive plays?
      // Depth-2 chain: play tile → set up next play → set up play after that
      if (newEnd !== null && remainingTiles.length > 0) {
        var chainScore = 0;
        var otherEnd = this.getOtherBoardEnd(end, board, tile);

        // Level 1: tiles that can play on newEnd
        for (var i = 0; i < remainingTiles.length; i++) {
          if (remainingTiles[i].matches(newEnd)) {
            var afterEnd = remainingTiles[i].otherSide(newEnd);
            chainScore += 3; // each continuation = good

            // Level 2: tiles that can play after level-1 tile
            for (var j = 0; j < remainingTiles.length; j++) {
              if (j === i) continue;
              if (remainingTiles[j].matches(afterEnd)) {
                chainScore += 2; // deeper chain = more value
              }
              // Also check the other board end for flexibility
              if (otherEnd !== null && remainingTiles[j].matches(otherEnd)) {
                chainScore += 1;
              }
            }
          }
        }
        score += chainScore;
      }

      // === Advantage #11: Endgame urgency ===
      // When AI hand is small, prioritize moves that lead to going out
      if (remainingTiles.length <= 3 && newEnd !== null) {
        var otherEnd = this.getOtherBoardEnd(end, board, tile);

        // If only 1 tile left, can it play on either board end?
        if (remainingTiles.length === 1) {
          var lastTile = remainingTiles[0];
          if (lastTile.matches(newEnd) || (otherEnd !== null && lastTile.matches(otherEnd))) {
            score += 50; // massive bonus: guaranteed domino next turn!
          } else {
            score -= 15; // bad: stuck with unplayable tile
          }
        }
        // If 2 tiles left, check if they chain to empty hand
        else if (remainingTiles.length === 2) {
          var canChainOut = false;
          for (var i = 0; i < 2; i++) {
            var first = remainingTiles[i];
            var second = remainingTiles[1 - i];
            // Can first play on newEnd, then second play on the result?
            if (first.matches(newEnd)) {
              var nextEnd = first.otherSide(newEnd);
              if (second.matches(nextEnd) || (otherEnd !== null && second.matches(otherEnd))) {
                canChainOut = true;
              }
            }
            // Can first play on otherEnd?
            if (otherEnd !== null && first.matches(otherEnd)) {
              var nextOther = first.otherSide(otherEnd);
              if (second.matches(newEnd) || second.matches(nextOther)) {
                canChainOut = true;
              }
            }
          }
          if (canChainOut) {
            score += 30; // strong bonus: can go out in 2 turns
          }
        }
        // If 3 tiles left, boost flexibility heavily
        else if (remainingTiles.length === 3) {
          var playableCount = 0;
          for (var i = 0; i < remainingTiles.length; i++) {
            if (remainingTiles[i].matches(newEnd) ||
                (otherEnd !== null && remainingTiles[i].matches(otherEnd))) {
              playableCount++;
            }
          }
          score += playableCount * 8;
        }
      }

      return score;
    }

    // ============================================================
    // Advantage #4: Monte Carlo 3-ply Lookahead
    // ALWAYS runs — no inference gate. Samples random opponent
    // hands from unseen tiles, simulates AI→Human→AI turns,
    // evaluates resulting position.
    // ============================================================
    applyLookahead(scored, engine) {
      var tracker = this.tracker;
      var SAMPLES = 30;
      var aiHand = engine.hand.aiHand;
      var board = engine.hand.board;
      var boneyard = engine.hand.boneyard || [];

      // Get unseen tiles for sampling (includes boneyard + human hand)
      var unseenTiles = tracker.getUnseenTiles();
      var humanHandSize = tracker.humanHandSize;

      if (unseenTiles.length < 1 || humanHandSize <= 0) {
        return scored;
      }

      // Clamp humanHandSize to unseen count
      var sampleSize = Math.min(humanHandSize, unseenTiles.length);

      for (var mi = 0; mi < scored.length; mi++) {
        var move = scored[mi].move;
        var totalOutcome = 0;

        for (var s = 0; s < SAMPLES; s++) {
          // Shuffle unseen tiles and take first N as human hand sample
          var shuffled = unseenTiles.slice();
          for (var k = shuffled.length - 1; k > 0; k--) {
            var j = Math.floor(Math.random() * (k + 1));
            var tmp = shuffled[k]; shuffled[k] = shuffled[j]; shuffled[j] = tmp;
          }
          var sampledHumanHand = shuffled.slice(0, sampleSize);

          var outcome = this.simulate3Ply(move, sampledHumanHand, aiHand, board, boneyard);
          totalOutcome += outcome;
        }

        // Weight lookahead heavily — this IS the AI's planning ability
        scored[mi].score += (totalOutcome / SAMPLES) * 5;
      }

      return scored;
    }

    // ============================================================
    // 3-ply simulation: AI plays → Human responds → AI responds
    // Returns a score for the resulting position.
    // ============================================================
    simulate3Ply(aiMove, sampledHumanHand, aiHand, board, boneyard) {
      var tile = aiMove.tile;
      var end = aiMove.end;

      // --- Ply 1: AI plays ---
      var newEnd = this.getNewBoardEnd(tile, end, board);
      var otherEnd = this.getOtherBoardEnd(end, board, tile);
      if (newEnd === null) return 0;

      // Board ends after AI plays
      var leftEnd1, rightEnd1;
      if (end === 'left') {
        leftEnd1 = newEnd;
        rightEnd1 = (board.isEmpty()) ? tile.high : board.rightEnd;
      } else {
        leftEnd1 = (board.isEmpty()) ? tile.low : board.leftEnd;
        rightEnd1 = newEnd;
      }

      // AI remaining tiles
      var aiRemaining = [];
      for (var i = 0; i < aiHand.tiles.length; i++) {
        if (aiHand.tiles[i] !== tile) aiRemaining.push(aiHand.tiles[i]);
      }

      // --- Ply 2: Human responds ---
      // Find human tiles that can play
      var humanPlayable = [];
      for (var i = 0; i < sampledHumanHand.length; i++) {
        var parts = sampledHumanHand[i].split('-');
        var lo = parseInt(parts[0]);
        var hi = parseInt(parts[1]);
        var pips = lo + hi;
        if (lo === leftEnd1 || hi === leftEnd1) {
          var hNewEnd = (hi === leftEnd1) ? lo : hi;
          humanPlayable.push({ idx: i, lo: lo, hi: hi, pips: pips, end: 'left', newLeft: hNewEnd, newRight: rightEnd1 });
        }
        if (lo === rightEnd1 || hi === rightEnd1) {
          var hNewEnd = (lo === rightEnd1) ? hi : lo;
          humanPlayable.push({ idx: i, lo: lo, hi: hi, pips: pips, end: 'right', newLeft: leftEnd1, newRight: hNewEnd });
        }
      }

      // Human can't play — must draw. Great for AI!
      if (humanPlayable.length === 0) {
        // Bonus: AI has options + human is stuck
        var aiOptions = 0;
        for (var i = 0; i < aiRemaining.length; i++) {
          if (aiRemaining[i].matches(leftEnd1) || aiRemaining[i].matches(rightEnd1)) aiOptions++;
        }
        return 8 + aiOptions * 2;
      }

      // Human picks their best response:
      // Prefer the move that leaves AI with FEWEST options (smartest opponent)
      var bestHumanMove = null;
      var worstForAI = Infinity;

      for (var h = 0; h < humanPlayable.length; h++) {
        var hp = humanPlayable[h];
        // Count AI options after this human move
        var aiOpts = 0;
        for (var i = 0; i < aiRemaining.length; i++) {
          if (aiRemaining[i].matches(hp.newLeft) || aiRemaining[i].matches(hp.newRight)) aiOpts++;
        }
        // Human picks move that minimizes AI options (ties broken by human pip dump)
        if (aiOpts < worstForAI || (aiOpts === worstForAI && (!bestHumanMove || hp.pips > bestHumanMove.pips))) {
          worstForAI = aiOpts;
          bestHumanMove = hp;
        }
      }

      if (!bestHumanMove) return 0;

      var leftEnd2 = bestHumanMove.newLeft;
      var rightEnd2 = bestHumanMove.newRight;

      // Remove human's played tile from their sampled hand
      var humanRemaining = sampledHumanHand.length - 1;

      // --- Ply 3: AI responds ---
      // Find AI tiles that can play on new board ends
      var aiPlayable = [];
      for (var i = 0; i < aiRemaining.length; i++) {
        if (aiRemaining[i].matches(leftEnd2)) {
          var aNewEnd = aiRemaining[i].otherSide(leftEnd2);
          aiPlayable.push({ tile: aiRemaining[i], end: 'left', newLeft: aNewEnd, newRight: rightEnd2 });
        }
        if (aiRemaining[i].matches(rightEnd2)) {
          var aNewEnd = aiRemaining[i].otherSide(rightEnd2);
          aiPlayable.push({ tile: aiRemaining[i], end: 'right', newLeft: leftEnd2, newRight: aNewEnd });
        }
      }

      // AI can't respond — bad
      if (aiPlayable.length === 0) {
        return -6;
      }

      // AI picks the move that maximizes its future options
      var bestAIScore = -Infinity;
      for (var a = 0; a < aiPlayable.length; a++) {
        var ap = aiPlayable[a];
        // Count remaining AI tiles that can play after this move
        var futureOpts = 0;
        var aiAfter = [];
        for (var i = 0; i < aiRemaining.length; i++) {
          if (aiRemaining[i] !== ap.tile) {
            aiAfter.push(aiRemaining[i]);
            if (aiRemaining[i].matches(ap.newLeft) || aiRemaining[i].matches(ap.newRight)) {
              futureOpts++;
            }
          }
        }
        // Count human tiles that could play (bad for AI)
        var humanThreats = 0;
        for (var i = 0; i < sampledHumanHand.length; i++) {
          if (i === bestHumanMove.idx) continue; // human already played this one
          var parts = sampledHumanHand[i].split('-');
          var lo = parseInt(parts[0]);
          var hi = parseInt(parts[1]);
          if (lo === ap.newLeft || hi === ap.newLeft || lo === ap.newRight || hi === ap.newRight) {
            humanThreats++;
          }
        }

        var moveScore = futureOpts * 2 - humanThreats * 1 + ap.tile.pipCount() * 0.3;

        // Endgame: about to go out?
        if (aiAfter.length === 0) {
          moveScore += 20; // domino!
        } else if (aiAfter.length === 1) {
          if (aiAfter[0].matches(ap.newLeft) || aiAfter[0].matches(ap.newRight)) {
            moveScore += 10; // one tile left and it's playable
          }
        }

        if (moveScore > bestAIScore) bestAIScore = moveScore;
      }

      // Final position score:
      // AI tile advantage + best AI move quality
      var tileAdvantage = (humanRemaining - (aiRemaining.length - 1)) * 2;
      return bestAIScore + tileAdvantage;
    }

    getNewBoardEnd(tile, end, board) {
      if (board.isEmpty()) {
        return (end === 'left') ? tile.low : tile.high;
      }
      if (end === 'left') {
        var matchVal = board.leftEnd;
        if (tile.high === matchVal) return tile.low;
        if (tile.low === matchVal) return tile.high;
      } else {
        var matchVal = board.rightEnd;
        if (tile.low === matchVal) return tile.high;
        if (tile.high === matchVal) return tile.low;
      }
      return null;
    }

    getOtherBoardEnd(end, board, tile) {
      if (board.isEmpty()) {
        return (end === 'left') ? tile.high : tile.low;
      }
      if (end === 'left') {
        return board.rightEnd;
      } else {
        return board.leftEnd;
      }
    }

    evaluatePosition(engine) {
      var hand = engine.hand;
      var aiPips = hand.aiHand.totalPips(hand.board);
      var humanTileCount = hand.humanHand.count();
      var aiTileCount = hand.aiHand.count();

      // Enhanced eval: factor in information advantage
      var infoBonus = this.tracker.getHumanLackedValueCount() * 3;

      var posEval = (humanTileCount - aiTileCount) * 5 - aiPips * 0.5 + infoBonus;
      return Math.max(-50, Math.min(50, posEval));
    }
  }

  D.AIPlayer = AIPlayer;

})(window.Domino);
