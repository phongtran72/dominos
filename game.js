// ============================================================
// game.js — Core Domino Game Engine (pure logic, no DOM)
// ============================================================

window.Domino = window.Domino || {};

(function (D) {
  'use strict';

  // --- Tile ---
  class Tile {
    constructor(low, high) {
      this.low = Math.min(low, high);
      this.high = Math.max(low, high);
      this.id = this.low + '-' + this.high;
    }

    pipCount() {
      return this.low + this.high;
    }

    pipCountWithGhost(boardEnds) {
      if (this.low === 0 && this.high === 0) {
        // Ghost 13: if [0-0] is in hand and unplayable on current board
        if (boardEnds && boardEnds.left !== null && boardEnds.right !== null) {
          if (boardEnds.left !== 0 && boardEnds.right !== 0) {
            return 13;
          }
        }
      }
      return this.pipCount();
    }

    matches(value) {
      return this.low === value || this.high === value;
    }

    isDouble() {
      return this.low === this.high;
    }

    otherSide(value) {
      if (this.low === value) return this.high;
      if (this.high === value) return this.low;
      return null;
    }

    toString() {
      return '[' + this.low + '|' + this.high + ']';
    }
  }

  // --- Hand ---
  class Hand {
    constructor() {
      this.tiles = [];
    }

    add(tile) {
      this.tiles.push(tile);
    }

    remove(tile) {
      var idx = this.tiles.indexOf(tile);
      if (idx !== -1) this.tiles.splice(idx, 1);
    }

    count() {
      return this.tiles.length;
    }

    isEmpty() {
      return this.tiles.length === 0;
    }

    has(tile) {
      return this.tiles.indexOf(tile) !== -1;
    }

    findById(id) {
      for (var i = 0; i < this.tiles.length; i++) {
        if (this.tiles[i].id === id) return this.tiles[i];
      }
      return null;
    }

    legalMoves(boardEnds) {
      var moves = [];
      if (!boardEnds || boardEnds.left === null) {
        // Empty board — any tile, any orientation
        for (var i = 0; i < this.tiles.length; i++) {
          moves.push({ tile: this.tiles[i], end: 'left' });
        }
        return moves;
      }
      for (var i = 0; i < this.tiles.length; i++) {
        var t = this.tiles[i];
        var canLeft = t.matches(boardEnds.left);
        var canRight = t.matches(boardEnds.right);
        if (canLeft) moves.push({ tile: t, end: 'left' });
        if (canRight && boardEnds.left !== boardEnds.right) {
          moves.push({ tile: t, end: 'right' });
        } else if (canRight && boardEnds.left === boardEnds.right && !canLeft) {
          moves.push({ tile: t, end: 'right' });
        }
      }
      return moves;
    }

    totalPips(boardEnds) {
      var sum = 0;
      for (var i = 0; i < this.tiles.length; i++) {
        sum += this.tiles[i].pipCountWithGhost(boardEnds);
      }
      return sum;
    }

    clone() {
      var h = new Hand();
      for (var i = 0; i < this.tiles.length; i++) {
        h.add(this.tiles[i]);
      }
      return h;
    }
  }

  // --- Board ---
  class Board {
    constructor() {
      this.tiles = [];       // placed tiles in order
      this.leftEnd = null;
      this.rightEnd = null;
    }

    isEmpty() {
      return this.tiles.length === 0;
    }

    getEnds() {
      return { left: this.leftEnd, right: this.rightEnd };
    }

    place(tile, end) {
      var placement = { tile: tile, end: end, flipped: false };

      if (this.isEmpty()) {
        // First tile: low on left, high on right
        this.leftEnd = tile.low;
        this.rightEnd = tile.high;
        placement.newLeftEnd = tile.low;
        placement.newRightEnd = tile.high;
        this.tiles.push(placement);
        return placement;
      }

      if (end === 'left') {
        var matchVal = this.leftEnd;
        if (tile.high === matchVal) {
          this.leftEnd = tile.low;
          placement.flipped = false;
        } else if (tile.low === matchVal) {
          this.leftEnd = tile.high;
          placement.flipped = true;
        }
        placement.newLeftEnd = this.leftEnd;
        placement.newRightEnd = this.rightEnd;
        this.tiles.unshift(placement);
      } else {
        var matchVal = this.rightEnd;
        if (tile.low === matchVal) {
          this.rightEnd = tile.high;
          placement.flipped = false;
        } else if (tile.high === matchVal) {
          this.rightEnd = tile.low;
          placement.flipped = true;
        }
        placement.newLeftEnd = this.leftEnd;
        placement.newRightEnd = this.rightEnd;
        this.tiles.push(placement);
      }

      return placement;
    }

    canMatch(value) {
      return value === this.leftEnd || value === this.rightEnd;
    }

    clone() {
      var b = new Board();
      b.leftEnd = this.leftEnd;
      b.rightEnd = this.rightEnd;
      b.tiles = this.tiles.slice();
      return b;
    }
  }

  // --- Tile Set ---
  function createTileSet() {
    var tiles = [];
    for (var i = 0; i <= 6; i++) {
      for (var j = i; j <= 6; j++) {
        tiles.push(new Tile(i, j));
      }
    }
    return tiles;
  }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  // --- GameEngine ---
  class GameEngine {
    constructor() {
      this.matchScore = { human: 0, ai: 0 };
      this.targetScore = 100;
      this.aiDifficulty = 'easy';
      this.previousHandWinner = null;
      this.handNumber = 0;
      this.hand = null; // current HandState
    }

    newMatch(difficulty) {
      this.matchScore = { human: 0, ai: 0 };
      this.aiDifficulty = difficulty || 'easy';
      this.previousHandWinner = null;
      this.handNumber = 0;
    }

    dealHand(leader) {
      this.handNumber++;
      var allTiles = shuffle(createTileSet());
      var humanHand = new Hand();
      var aiHand = new Hand();

      for (var i = 0; i < 14; i++) {
        humanHand.add(allTiles[i]);
      }
      for (var i = 14; i < 28; i++) {
        aiHand.add(allTiles[i]);
      }

      // Sort human hand for display (by low value, then high)
      humanHand.tiles.sort(function (a, b) {
        return a.low - b.low || a.high - b.high;
      });

      this.hand = {
        humanHand: humanHand,
        aiHand: aiHand,
        board: new Board(),
        currentPlayer: leader,
        consecutivePasses: 0,
        lastPlacer: null,
        moveHistory: [],
        opponentPassedValues: { human: [], ai: [] }
      };

      return this.hand;
    }

    dealHandFromTiles(leader, humanTileData, aiTileData) {
      this.handNumber++;
      var humanHand = new Hand();
      var aiHand = new Hand();

      for (var i = 0; i < humanTileData.length; i++) {
        humanHand.add(new Tile(humanTileData[i].low, humanTileData[i].high));
      }
      for (var i = 0; i < aiTileData.length; i++) {
        aiHand.add(new Tile(aiTileData[i].low, aiTileData[i].high));
      }

      humanHand.tiles.sort(function (a, b) {
        return a.low - b.low || a.high - b.high;
      });

      this.hand = {
        humanHand: humanHand,
        aiHand: aiHand,
        board: new Board(),
        currentPlayer: leader,
        consecutivePasses: 0,
        lastPlacer: null,
        moveHistory: [],
        opponentPassedValues: { human: [], ai: [] }
      };

      return this.hand;
    }

    getHand(player) {
      return player === 'human' ? this.hand.humanHand : this.hand.aiHand;
    }

    getOpponent(player) {
      return player === 'human' ? 'ai' : 'human';
    }

    getLegalMoves(player) {
      var hand = this.getHand(player);
      return hand.legalMoves(this.hand.board.getEnds());
    }

    playTile(player, tile, end) {
      var hand = this.getHand(player);

      // Validate tile is in hand
      if (!hand.has(tile)) return { error: 'Tile not in hand' };

      // Validate legal move
      var legal = this.getLegalMoves(player);
      var isLegal = false;
      for (var i = 0; i < legal.length; i++) {
        if (legal[i].tile === tile && legal[i].end === end) {
          isLegal = true;
          break;
        }
      }
      if (!isLegal) return { error: 'Illegal move' };

      // Place tile
      var placement = this.hand.board.place(tile, end);
      hand.remove(tile);

      // Record move
      this.hand.moveHistory.push({
        player: player,
        tile: tile,
        end: end,
        boardEnds: this.hand.board.getEnds()
      });

      this.hand.lastPlacer = player;
      this.hand.consecutivePasses = 0;

      // Check hand end
      var handEnd = this.checkHandEnd(player);

      // Switch player
      if (!handEnd) {
        this.hand.currentPlayer = this.getOpponent(player);
      }

      return { success: true, placement: placement, handEnd: handEnd };
    }

    pass(player) {
      // Record what values the player passed on
      var ends = this.hand.board.getEnds();
      if (ends.left !== null) {
        var pv = this.hand.opponentPassedValues[player];
        if (pv.indexOf(ends.left) === -1) pv.push(ends.left);
        if (pv.indexOf(ends.right) === -1) pv.push(ends.right);
      }

      this.hand.consecutivePasses++;
      this.hand.moveHistory.push({
        player: player,
        tile: null,
        end: null,
        pass: true,
        boardEnds: this.hand.board.getEnds()
      });

      // Check for confirmed lock (pass-pass)
      if (this.hand.consecutivePasses >= 2) {
        return this.resolveBlock();
      }

      this.hand.currentPlayer = this.getOpponent(player);
      return null;
    }

    checkHandEnd(lastPlayer) {
      var hand = this.getHand(lastPlayer);

      // Domino: player emptied their hand
      if (hand.isEmpty()) {
        return this.resolveDomino(lastPlayer);
      }

      // Immediate Lock: after placement, neither player has legal moves
      var humanMoves = this.hand.humanHand.legalMoves(this.hand.board.getEnds());
      var aiMoves = this.hand.aiHand.legalMoves(this.hand.board.getEnds());

      if (humanMoves.length === 0 && aiMoves.length === 0) {
        return this.resolveBlock();
      }

      return null;
    }

    resolveDomino(winner) {
      var loser = this.getOpponent(winner);
      var loserHand = this.getHand(loser);
      var points = loserHand.totalPips(this.hand.board.getEnds());

      this.matchScore[winner] += points;
      this.previousHandWinner = winner;

      return {
        type: 'domino',
        winner: winner,
        points: points,
        loserPips: points,
        ghost13: this.checkGhost13Info(loser)
      };
    }

    resolveBlock() {
      var aggressor = this.determineAggressor();
      var opponent = this.getOpponent(aggressor);
      var boardEnds = this.hand.board.getEnds();

      var aggressorPips = this.getHand(aggressor).totalPips(boardEnds);
      var opponentPips = this.getHand(opponent).totalPips(boardEnds);

      var result;

      if (aggressorPips <= opponentPips) {
        // Successful block: aggressor wins
        var points = opponentPips * 2;
        this.matchScore[aggressor] += points;
        this.previousHandWinner = aggressor;
        result = {
          type: 'successful_block',
          winner: aggressor,
          aggressor: aggressor,
          points: points,
          aggressorPips: aggressorPips,
          opponentPips: opponentPips
        };
      } else {
        // Failed block: opponent wins
        var points = aggressorPips + opponentPips;
        this.matchScore[opponent] += points;
        this.previousHandWinner = opponent;
        result = {
          type: 'failed_block',
          winner: opponent,
          aggressor: aggressor,
          points: points,
          aggressorPips: aggressorPips,
          opponentPips: opponentPips
        };
      }

      result.ghost13Human = this.checkGhost13Info('human');
      result.ghost13AI = this.checkGhost13Info('ai');

      return result;
    }

    checkGhost13Info(player) {
      var hand = this.getHand(player);
      var tile00 = hand.findById('0-0');
      if (!tile00) return null;

      var ends = this.hand.board.getEnds();
      if (ends.left !== 0 && ends.right !== 0) {
        return { player: player, triggered: true };
      }
      return { player: player, triggered: false };
    }

    determineAggressor() {
      var history = this.hand.moveHistory;

      // Find last two tile placements (not passes)
      var placements = [];
      for (var i = history.length - 1; i >= 0; i--) {
        if (!history[i].pass) {
          placements.unshift(history[i]);
          if (placements.length === 2) break;
        }
      }

      // Puppeteer Rule check
      if (placements.length >= 2) {
        var puppeteerCandidate = placements[0]; // second-to-last placer
        var forcedMove = placements[1];          // last placer

        // Check if forced player had exactly 1 legal tile at time of their move
        if (this.checkPuppeteer(puppeteerCandidate, forcedMove)) {
          return puppeteerCandidate.player;
        }
      }

      // Direct Block: last player to place a tile
      return this.hand.lastPlacer;
    }

    checkPuppeteer(puppeteerMove, forcedMove) {
      // Reconstruct: after puppeteer's move, did the forced player have exactly 1 legal tile?
      // And did every placement of that tile cause a block?
      // We use the move history to check.

      // The forced player's hand at the time = current hand + the tile they played
      var forcedPlayer = forcedMove.player;
      var forcedHand = this.getHand(forcedPlayer).clone();
      forcedHand.add(forcedMove.tile);

      // Board state after puppeteer's move (before forced move)
      // Use a board with a dummy tile so isEmpty() returns false
      var boardAfterPuppeteer = new Board();
      boardAfterPuppeteer.leftEnd = puppeteerMove.boardEnds.left;
      boardAfterPuppeteer.rightEnd = puppeteerMove.boardEnds.right;
      boardAfterPuppeteer.tiles = [null]; // non-empty so place() works correctly

      // Get legal moves for forced player at that point
      var legalMoves = forcedHand.legalMoves(boardAfterPuppeteer.getEnds());

      // Deduplicate by tile (a tile might appear for left and right end)
      var uniqueTiles = [];
      var seen = {};
      for (var i = 0; i < legalMoves.length; i++) {
        if (!seen[legalMoves[i].tile.id]) {
          uniqueTiles.push(legalMoves[i].tile);
          seen[legalMoves[i].tile.id] = true;
        }
      }

      // Must have exactly 1 legal tile
      if (uniqueTiles.length !== 1) return false;

      // Check: every legal placement of that tile results in a blocked board
      var theTile = uniqueTiles[0];
      var tileMoves = legalMoves.filter(function (m) { return m.tile === theTile; });

      // Simulate remaining hands after forced player plays the tile
      var otherPlayer = this.getOpponent(forcedPlayer);
      var otherHand = this.getHand(otherPlayer);
      var forcedHandAfter = forcedHand.clone();
      forcedHandAfter.remove(theTile);

      for (var i = 0; i < tileMoves.length; i++) {
        var move = tileMoves[i];
        // Simulate place using a board clone (has tiles so isEmpty() is false)
        var sb = boardAfterPuppeteer.clone();
        sb.place(theTile, move.end);

        var otherMoves = otherHand.legalMoves(sb.getEnds());
        var forcedMoves = forcedHandAfter.legalMoves(sb.getEnds());

        if (otherMoves.length > 0 || forcedMoves.length > 0) {
          return false; // This placement doesn't cause a block
        }
      }

      return true; // All placements of the forced tile cause a block
    }

    checkMatchEnd() {
      if (this.matchScore.human >= this.targetScore) return 'human';
      if (this.matchScore.ai >= this.targetScore) return 'ai';
      return null;
    }
  }

  // Exports
  D.Tile = Tile;
  D.Hand = Hand;
  D.Board = Board;
  D.GameEngine = GameEngine;
  D.createTileSet = createTileSet;
  D.shuffle = shuffle;

})(window.Domino);
