// ============================================================
// game.js — 3-Player Domino Game Engine (pure logic, no DOM)
//
// 27 tiles (no [0|0]), 9 per player, no boneyard.
// Block winner = lowest pip count.
// Scoring: winner gets sum of all opponents' pips.
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

    totalPips() {
      var sum = 0;
      for (var i = 0; i < this.tiles.length; i++) {
        sum += this.tiles[i].pipCount();
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

  // --- Tile Set (27 tiles, no [0|0]) ---
  function createTileSet() {
    var tiles = [];
    for (var i = 0; i <= 6; i++) {
      for (var j = i; j <= 6; j++) {
        // Exclude [0|0]
        if (i === 0 && j === 0) continue;
        tiles.push(new Tile(i, j));
      }
    }
    return tiles; // 27 tiles
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

  // --- Player constants ---
  var PLAYERS = ['human', 'ai1', 'ai2'];

  function getNextPlayer(player) {
    var idx = PLAYERS.indexOf(player);
    return PLAYERS[(idx + 1) % 3];
  }

  function getOtherPlayers(player) {
    return PLAYERS.filter(function (p) { return p !== player; });
  }

  // --- GameEngine ---
  class GameEngine {
    constructor() {
      this.matchScore = { human: 0, ai1: 0, ai2: 0 };
      this.targetScore = 100;
      this.aiDifficulty = 'easy';
      this.previousHandWinner = null;
      this.handNumber = 0;
      this.hand = null; // current HandState
      this.gameMode = 'quick'; // 'quick' or 'match' (placeholder)
    }

    newMatch(difficulty, gameMode) {
      this.matchScore = { human: 0, ai1: 0, ai2: 0 };
      this.aiDifficulty = difficulty || 'easy';
      this.gameMode = gameMode || 'quick';
      this.previousHandWinner = null;
      this.handNumber = 0;
    }

    dealHand(leader) {
      this.handNumber++;
      var allTiles = shuffle(createTileSet());
      var humanHand = new Hand();
      var ai1Hand = new Hand();
      var ai2Hand = new Hand();

      // 9 tiles each = 27 total (all tiles dealt)
      for (var i = 0; i < 9; i++) {
        humanHand.add(allTiles[i]);
      }
      for (var i = 9; i < 18; i++) {
        ai1Hand.add(allTiles[i]);
      }
      for (var i = 18; i < 27; i++) {
        ai2Hand.add(allTiles[i]);
      }

      // Sort human hand for display
      humanHand.tiles.sort(function (a, b) {
        return a.low - b.low || a.high - b.high;
      });

      this.hand = {
        humanHand: humanHand,
        ai1Hand: ai1Hand,
        ai2Hand: ai2Hand,
        board: new Board(),
        currentPlayer: leader,
        consecutivePasses: 0,
        lastPlacer: null,
        moveHistory: [],
        passedValues: { human: [], ai1: [], ai2: [] }
      };

      return this.hand;
    }

    getHand(player) {
      if (player === 'human') return this.hand.humanHand;
      if (player === 'ai1') return this.hand.ai1Hand;
      return this.hand.ai2Hand;
    }

    getNextPlayer(player) {
      return getNextPlayer(player);
    }

    getOtherPlayers(player) {
      return getOtherPlayers(player);
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
        this.hand.currentPlayer = getNextPlayer(player);
      }

      return { success: true, placement: placement, handEnd: handEnd };
    }

    pass(player) {
      // Record what values the player passed on
      var ends = this.hand.board.getEnds();
      if (ends.left !== null) {
        var pv = this.hand.passedValues[player];
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

      // Block: all 3 players passed consecutively
      if (this.hand.consecutivePasses >= 3) {
        return this.resolveBlock();
      }

      this.hand.currentPlayer = getNextPlayer(player);
      return null;
    }

    checkHandEnd(lastPlayer) {
      var hand = this.getHand(lastPlayer);

      // Domino: player emptied their hand
      if (hand.isEmpty()) {
        return this.resolveDomino(lastPlayer);
      }

      // Immediate Lock: after placement, no player has legal moves
      var ends = this.hand.board.getEnds();
      var anyCanPlay = false;
      for (var i = 0; i < PLAYERS.length; i++) {
        var moves = this.getHand(PLAYERS[i]).legalMoves(ends);
        if (moves.length > 0) {
          anyCanPlay = true;
          break;
        }
      }

      if (!anyCanPlay) {
        return this.resolveBlock();
      }

      return null;
    }

    resolveDomino(winner) {
      var others = getOtherPlayers(winner);
      var totalOpponentPips = 0;
      var pipDetails = {};

      for (var i = 0; i < others.length; i++) {
        var pips = this.getHand(others[i]).totalPips();
        pipDetails[others[i]] = pips;
        totalOpponentPips += pips;
      }

      var points = totalOpponentPips;
      this.matchScore[winner] += points;
      this.previousHandWinner = winner;

      return {
        type: 'domino',
        winner: winner,
        points: points,
        pipDetails: pipDetails
      };
    }

    resolveBlock() {
      // Find player with lowest pip count
      var pipCounts = {};
      var lowestPips = Infinity;
      var winner = null;

      for (var i = 0; i < PLAYERS.length; i++) {
        var pips = this.getHand(PLAYERS[i]).totalPips();
        pipCounts[PLAYERS[i]] = pips;
        if (pips < lowestPips) {
          lowestPips = pips;
          winner = PLAYERS[i];
        }
      }

      // Tie-breaker: first player in order with lowest pips wins
      // (Already handled by the loop — first found wins ties)

      var others = getOtherPlayers(winner);
      var totalOpponentPips = 0;
      for (var i = 0; i < others.length; i++) {
        totalOpponentPips += pipCounts[others[i]];
      }

      // Net scoring: winner gets opponents' pips minus own pips
      var points = totalOpponentPips - pipCounts[winner];
      this.matchScore[winner] += points;
      this.previousHandWinner = winner;

      return {
        type: 'block',
        winner: winner,
        points: points,
        pipCounts: pipCounts
      };
    }

    checkMatchEnd() {
      if (this.gameMode === 'quick') {
        // Single round — always ends after first hand
        return this.previousHandWinner;
      }
      // Match mode (placeholder)
      for (var i = 0; i < PLAYERS.length; i++) {
        if (this.matchScore[PLAYERS[i]] >= this.targetScore) {
          return PLAYERS[i];
        }
      }
      return null;
    }

    getPlayerLabel(player) {
      if (player === 'human') return 'You';
      if (player === 'ai1') return 'AI-1';
      if (player === 'ai2') return 'AI-2';
      return player;
    }
  }

  // Exports
  D.Tile = Tile;
  D.Hand = Hand;
  D.Board = Board;
  D.GameEngine = GameEngine;
  D.createTileSet = createTileSet;
  D.shuffle = shuffle;
  D.PLAYERS = PLAYERS;
  D.getNextPlayer = getNextPlayer;
  D.getOtherPlayers = getOtherPlayers;

})(window.Domino);
