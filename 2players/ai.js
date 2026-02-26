// ============================================================
// ai.js — ENHANCED AI for Draw Variant (Imperfect Information)
//
// 9 strategic advantages over human:
//   1. Perfect tile tracking (knows exactly which tiles are unseen)
//   2. Bayesian inference (deduces opponent hand from draw/pass)
//   3. Endpoint locking (forces opponent to draw on values they lack)
//   4. Determinization (Monte Carlo sampling of possible hands)
//   5. Draw event analysis (extracts max info from each draw cycle)
//   6. Draw-forcing (prefer board ends with few unseen matches)
//   7. Boneyard depletion aggression (scale up as boneyard shrinks)
//   8. Bloated hand exploitation (steer toward blocks when human drew many)
//   9. Proactive scarcity (dominate suits early to create future locks)
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
  // AIPlayer — Enhanced with tracking, inference, determinization
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

      // Advantage #4: Determinization — Monte Carlo sampling
      if (this.tracker.getHumanLackedValueCount() >= 1) {
        scored = this.applyDeterminization(scored, engine);
      }

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
        depth: 1,
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
      score += tile.pipCount() * 2;

      // === 2. Play doubles early ===
      if (tile.isDouble()) {
        score += 8;
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
      // If tracker knows human lacks a value, MASSIVE bonus for leaving
      // that value as a board end — forces them to draw
      if (newEnd !== null && tracker.humanLacks(newEnd)) {
        score += 25;
      }

      // Double lock: BOTH board ends are values human lacks
      if (newEnd !== null) {
        var otherEnd = this.getOtherBoardEnd(end, board, tile);
        if (otherEnd !== null && tracker.humanLacks(newEnd) && tracker.humanLacks(otherEnd)) {
          score += 20; // devastating: human MUST draw, guaranteed
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
      // If many tiles of a suit are already played/in AI hand,
      // leaving that value on the board makes it hard for human
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
      // Even without inference, prefer board ends where few unseen tiles match.
      // Fewer unseen matches = higher chance human must draw.
      // This works from turn 1 — no inference needed.
      if (newEnd !== null) {
        var unseenTiles = tracker.getUnseenTiles();
        var unseenMatchingNewEnd = 0;
        for (var ui = 0; ui < unseenTiles.length; ui++) {
          var parts = unseenTiles[ui].split('-');
          var lo = parseInt(parts[0]);
          var hi = parseInt(parts[1]);
          if (lo === newEnd || hi === newEnd) unseenMatchingNewEnd++;
        }
        // Max unseen matching a value = ~6. Fewer = better for AI.
        // Bonus: (6 - matching) * weight. If only 1 unseen tile matches, big bonus.
        var drawForceBonus = Math.max(0, 5 - unseenMatchingNewEnd) * 3;
        score += drawForceBonus;
      }

      // === Advantage #7: Boneyard depletion aggression ===
      // As boneyard shrinks, scarcity and locking become more powerful.
      // Scale up key heuristics based on how empty the boneyard is.
      var boneyardSize = boneyard.length;
      var boneyardTotal = 10; // 28 - 9 - 9 = 10 tiles in boneyard at start
      if (boneyardSize < boneyardTotal && newEnd !== null) {
        // depletionFactor: 0.0 (full boneyard) to 1.0 (empty)
        var depletionFactor = 1 - (boneyardSize / boneyardTotal);
        // Amplify scarcity + draw-forcing as boneyard empties
        // At empty boneyard: up to +10 extra on scarce ends
        var knownForValue = 0;
        for (var v = 0; v <= 6; v++) {
          var id = Math.min(newEnd, v) + '-' + Math.max(newEnd, v);
          if (tracker.tileLocation[id] === 'ai' || tracker.tileLocation[id] === 'board') {
            knownForValue++;
          }
        }
        score += knownForValue * depletionFactor * 3;

        // Stronger endpoint locking when boneyard low/empty
        if (tracker.humanLacks(newEnd)) {
          score += depletionFactor * 15;
        }
      }

      // === Advantage #8: Bloated hand exploitation ===
      // If human has drawn many tiles (hand > 9), they have more pips.
      // Steer toward blocks / tight board positions.
      if (newEnd !== null && tracker.humanHandSize > 9) {
        var humanBloat = tracker.humanHandSize - 9; // how many extra tiles
        // Count unseen tiles matching board ends (tightness measure)
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
        // Tighter board = fewer matching = closer to block
        var tightness = Math.max(0, 8 - matchingEnds);
        // Bonus scales with how bloated human's hand is
        score += tightness * Math.min(humanBloat, 5) * 1.5;
      }

      // === Advantage #9: Proactive scarcity (suit domination) ===
      // Prefer playing tiles from suits we dominate (own most tiles of that value).
      // This depletes the suit, making future board ends harder for human.
      if (newEnd !== null) {
        // Count how many tiles with newEnd value the AI currently holds
        var aiHoldsWithNewEnd = 0;
        for (var i = 0; i < remainingTiles.length; i++) {
          if (remainingTiles[i].low === newEnd || remainingTiles[i].high === newEnd) {
            aiHoldsWithNewEnd++;
          }
        }
        // If AI holds 3+ tiles of this value, it dominates the suit
        // Leaving this value on the board means AI can always play, human often can't
        if (aiHoldsWithNewEnd >= 3) {
          score += 10;
        } else if (aiHoldsWithNewEnd >= 2) {
          score += 5;
        }
      }

      return score;
    }

    // ============================================================
    // Advantage #4: Determinization — Monte Carlo sampling
    // Sample N random consistent opponent hands, simulate each,
    // and adjust move scores based on average outcomes
    // ============================================================
    applyDeterminization(scored, engine) {
      var tracker = this.tracker;
      var SAMPLES = 30;

      var possibleHumanTiles = tracker.getPossibleHumanTiles();
      var humanHandSize = tracker.humanHandSize;

      if (possibleHumanTiles.length < humanHandSize || humanHandSize <= 0) {
        return scored;
      }

      for (var mi = 0; mi < scored.length; mi++) {
        var move = scored[mi].move;
        var totalOutcome = 0;

        for (var s = 0; s < SAMPLES; s++) {
          // Randomly assign possible tiles to human hand
          var shuffled = possibleHumanTiles.slice();
          for (var k = shuffled.length - 1; k > 0; k--) {
            var j = Math.floor(Math.random() * (k + 1));
            var tmp = shuffled[k]; shuffled[k] = shuffled[j]; shuffled[j] = tmp;
          }
          var sampledHumanHand = shuffled.slice(0, Math.min(humanHandSize, shuffled.length));

          var outcome = this.evaluateMoveInWorld(move, sampledHumanHand, engine);
          totalOutcome += outcome;
        }

        scored[mi].score += (totalOutcome / SAMPLES) * 3;
      }

      return scored;
    }

    // Evaluate a move in a simulated world
    evaluateMoveInWorld(move, sampledHumanHand, engine) {
      var board = engine.hand.board;
      var newEnd = this.getNewBoardEnd(move.tile, move.end, board);
      var otherEnd = this.getOtherBoardEnd(move.end, board, move.tile);

      if (newEnd === null) return 0;

      // Check if human can respond to the new board state
      var humanCanPlay = false;
      for (var i = 0; i < sampledHumanHand.length; i++) {
        var parts = sampledHumanHand[i].split('-');
        var lo = parseInt(parts[0]);
        var hi = parseInt(parts[1]);
        if (lo === newEnd || hi === newEnd || lo === otherEnd || hi === otherEnd) {
          humanCanPlay = true;
          break;
        }
      }

      // Human can't play = great for us (they must draw)
      if (!humanCanPlay) return 5;

      // Estimate pip advantage from human's weakest response
      var minHumanResponsePips = Infinity;
      for (var i = 0; i < sampledHumanHand.length; i++) {
        var parts = sampledHumanHand[i].split('-');
        var lo = parseInt(parts[0]);
        var hi = parseInt(parts[1]);
        if (lo === newEnd || hi === newEnd || lo === otherEnd || hi === otherEnd) {
          var pips = lo + hi;
          if (pips < minHumanResponsePips) minHumanResponsePips = pips;
        }
      }

      return (minHumanResponsePips - 5) * 0.3;
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
