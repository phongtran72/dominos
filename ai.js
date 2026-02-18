// ============================================================
// ai.js — AI Decision Making (Easy + Hard modes)
// ============================================================

(function (D) {
  'use strict';

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
      var aiHand = hand.aiHand;
      var board = hand.board;
      var bestScore = -Infinity;
      var bestMoves = [];

      for (var i = 0; i < legalMoves.length; i++) {
        var move = legalMoves[i];
        var score = 0;

        // Simulate placement
        var simBoard = this.simulatePlace(board, move.tile, move.end);
        var simEnds = simBoard.getEnds();

        // Build remaining hand after play
        var remaining = [];
        for (var j = 0; j < aiHand.tiles.length; j++) {
          if (aiHand.tiles[j] !== move.tile) remaining.push(aiHand.tiles[j]);
        }

        // H1: Pip Dump — prefer high-pip tiles (weight 3)
        score += move.tile.pipCount() * 3;

        // H2: Board Control — set ends to values we hold many of (weight 5)
        score += this.boardControlScore(simEnds, remaining) * 5;

        // H3: Diversity — keep varied pip values (weight 2)
        score += this.diversityScore(remaining) * 2;

        // H4: Double Disposal — play doubles early (weight 4)
        if (move.tile.isDouble()) score += 4;

        // H5: Ghost 13 Awareness (weight 8)
        score += this.ghost13Score(move, simEnds, aiHand, remaining) * 8;

        // H6: Opponent Lockout — set ends to values opponent passed on (weight 3)
        score += this.opponentLockoutScore(simEnds, hand.opponentPassedValues.human) * 3;

        // H7: Blocking consideration (weight 2)
        score += this.blockingScore(simBoard, remaining, hand.humanHand, engine) * 2;

        if (score > bestScore) {
          bestScore = score;
          bestMoves = [move];
        } else if (score === bestScore) {
          bestMoves.push(move);
        }
      }

      return bestMoves[Math.floor(Math.random() * bestMoves.length)];
    }

    simulatePlace(board, tile, end) {
      var b = new D.Board();
      b.leftEnd = board.leftEnd;
      b.rightEnd = board.rightEnd;
      b.tiles = board.tiles.slice();

      if (b.isEmpty()) {
        b.leftEnd = tile.low;
        b.rightEnd = tile.high;
        return b;
      }

      if (end === 'left') {
        if (tile.high === b.leftEnd) b.leftEnd = tile.low;
        else if (tile.low === b.leftEnd) b.leftEnd = tile.high;
      } else {
        if (tile.low === b.rightEnd) b.rightEnd = tile.high;
        else if (tile.high === b.rightEnd) b.rightEnd = tile.low;
      }
      return b;
    }

    boardControlScore(simEnds, remaining) {
      var score = 0;
      for (var i = 0; i < remaining.length; i++) {
        if (remaining[i].matches(simEnds.left)) score++;
        if (simEnds.left !== simEnds.right && remaining[i].matches(simEnds.right)) score++;
      }
      return score;
    }

    diversityScore(remaining) {
      var seen = {};
      for (var i = 0; i < remaining.length; i++) {
        seen[remaining[i].low] = true;
        seen[remaining[i].high] = true;
      }
      return Object.keys(seen).length;
    }

    ghost13Score(move, simEnds, aiHand, remaining) {
      var score = 0;
      var tile = move.tile;

      // If we're playing the [0-0], big bonus
      if (tile.low === 0 && tile.high === 0) {
        score += 1;
      }

      // If we still hold [0-0] after this play, check if we can play it
      var still00 = false;
      for (var i = 0; i < remaining.length; i++) {
        if (remaining[i].low === 0 && remaining[i].high === 0) {
          still00 = true;
          break;
        }
      }

      if (still00) {
        // Prefer moves that keep a 0 end open
        if (simEnds.left === 0 || simEnds.right === 0) {
          score += 0.5;
        } else {
          score -= 1; // Bad — we might get stuck with ghost 13
        }
      }

      // If opponent might hold [0-0] (it's not on board and not in our hand)
      var we00 = aiHand.findById('0-0');
      if (!we00) {
        // Opponent might have it — avoid leaving 0 as end
        if (simEnds.left === 0 || simEnds.right === 0) {
          score -= 0.3;
        }
      }

      return score;
    }

    opponentLockoutScore(simEnds, passedValues) {
      var score = 0;
      if (!passedValues) return 0;
      if (passedValues.indexOf(simEnds.left) !== -1) score++;
      if (passedValues.indexOf(simEnds.right) !== -1) score++;
      return score;
    }

    blockingScore(simBoard, remaining, humanHand, engine) {
      if (remaining.length > 4) return 0;

      var simEnds = simBoard.getEnds();
      var humanMoves = humanHand.legalMoves(simEnds);

      // Build a temp Hand for remaining tiles
      var tempHand = new D.Hand();
      for (var i = 0; i < remaining.length; i++) tempHand.add(remaining[i]);
      var aiMoves = tempHand.legalMoves(simEnds);

      // If this move causes immediate block
      if (humanMoves.length === 0 && aiMoves.length === 0) {
        var aiPips = tempHand.totalPips(simEnds);
        var humanPips = humanHand.totalPips(simEnds);
        if (aiPips <= humanPips) {
          return 3; // We'd win this block
        } else {
          return -3; // We'd lose — avoid
        }
      }

      return 0;
    }
  }

  D.AIPlayer = AIPlayer;

})(window.Domino);
