// ============================================================
// compare-engines.js — Head-to-head: Old Minimax vs New Bitboard
//
// Run: node compare-engines.js [numGames]
// Default: 100 games
//
// Both AI engines always search from the "ai" role perspective.
// To make one play the "human" side, we create a proxy engine
// that swaps aiHand/humanHand so the AI thinks it's the "ai" role.
// ============================================================

'use strict';

// --- Shim browser globals for Node.js ---
global.window = global;
window.Domino = {};

// --- Load game engine ---
require('./game.js');

var D = window.Domino;

// --- Load OLD AI (into its own namespace) ---
var oldNamespace = {};
(function () {
  var savedD = window.Domino;
  window.Domino = oldNamespace;
  oldNamespace.Tile = D.Tile;
  oldNamespace.Hand = D.Hand;
  oldNamespace.Board = D.Board;
  oldNamespace.GameEngine = D.GameEngine;
  oldNamespace.createTileSet = D.createTileSet;
  oldNamespace.shuffle = D.shuffle;
  require('./ai-old.js');
  window.Domino = savedD;
})();

// --- Load NEW AI (bitboard) ---
require('./ai.js');

var OldAI = oldNamespace.OldAIPlayer;
var NewAI = D.AIPlayer;

// --- Seeded PRNG for reproducible games ---
var rngState = 42;
function seededRandom() {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return (rngState >>> 0) / 0x80000000;
}

function seededShuffle(arr) {
  for (var i = arr.length - 1; i > 0; i--) {
    var j = Math.floor(seededRandom() * (i + 1));
    var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}

// --- Create a proxy engine that swaps ai/human perspective ---
// Both AI engines always call engine.hand.aiHand to get "my" tiles.
// When an AI plays the "human" role, we need to swap the hands
// so it sees humanHand as aiHand and vice versa.
function createSwappedProxy(engine) {
  var proxy = Object.create(engine);
  Object.defineProperty(proxy, 'hand', {
    get: function () {
      var realHand = engine.hand;
      return {
        aiHand: realHand.humanHand,
        humanHand: realHand.aiHand,
        board: realHand.board,
        currentPlayer: realHand.currentPlayer,
        consecutivePasses: realHand.consecutivePasses,
        lastPlacer: realHand.lastPlacer,
        moveHistory: realHand.moveHistory.map(function (m) {
          // Swap player labels in history so the AI's search sees correct perspective
          var swappedPlayer = m.player === 'ai' ? 'human' : 'ai';
          return {
            player: swappedPlayer,
            tile: m.tile,
            end: m.end,
            pass: m.pass,
            boardEnds: m.boardEnds
          };
        }),
        opponentPassedValues: {
          human: realHand.opponentPassedValues.ai,
          ai: realHand.opponentPassedValues.human
        }
      };
    }
  });
  return proxy;
}

// --- Play a single hand ---
function playHand(engine, aiRolePlayer, humanRolePlayer, leader) {
  var origShuffle = D.shuffle;
  D.shuffle = seededShuffle;
  var hand = engine.dealHand(leader);
  D.shuffle = origShuffle;

  // Create swapped proxy for the human-role player
  var swappedEngine = createSwappedProxy(engine);

  var maxTurns = 200;
  var turn = 0;

  while (turn < maxTurns) {
    turn++;
    var currentPlayer = hand.currentPlayer;
    var legalMoves = engine.getLegalMoves(currentPlayer);

    if (legalMoves.length === 0) {
      var result = engine.pass(currentPlayer);
      if (result) return result;
      continue;
    }

    var moveResult;
    if (currentPlayer === 'ai') {
      // AI role player sees the real engine (aiHand = their hand)
      moveResult = aiRolePlayer.chooseMove(legalMoves, engine);
    } else {
      // Human role player sees swapped engine (aiHand = humanHand)
      moveResult = humanRolePlayer.chooseMove(legalMoves, swappedEngine);
    }

    // chooseMove returns { move: {tile, end}, bestScore, ... }
    var move = (moveResult && moveResult.move) ? moveResult.move : legalMoves[0];

    var result = engine.playTile(currentPlayer, move.tile, move.end);

    if (result.error) {
      console.error('ERROR: ' + result.error + ' player=' + currentPlayer +
                     ' tile=' + (move.tile ? move.tile.toString() : '?') + ' end=' + move.end);
      return null;
    }

    if (result.handEnd) {
      return result.handEnd;
    }
  }

  console.error('ERROR: hand exceeded max turns');
  return null;
}

// --- Main comparison ---
var numGames = parseInt(process.argv[2]) || 100;

console.log('=== Engine Comparison: Old Minimax vs New Bitboard ===');
console.log('Games: ' + numGames + ' (each plays 2 hands with swapped roles)');
console.log('');

var oldAI = new OldAI('hard');
var newAI = new NewAI('hard');

var stats = {
  newWins: 0,
  oldWins: 0,
  newPoints: 0,
  oldPoints: 0,
  newWinsGoingFirst: 0,
  oldWinsGoingFirst: 0,
  newWinsGoingSecond: 0,
  oldWinsGoingSecond: 0,
  errors: 0,
  totalHands: 0,
  newTimeMs: 0,
  oldTimeMs: 0
};

for (var g = 0; g < numGames; g++) {
  rngState = 42 + g * 7919;

  // --- Hand A: NEW plays "ai" role (goes first), OLD plays "human" role ---
  var engineA = new D.GameEngine();
  engineA.newMatch('hard');
  var savedSeed = rngState;

  var t0 = Date.now();
  var resultA = playHand(engineA, newAI, oldAI, 'ai');
  stats.newTimeMs += Date.now() - t0;
  stats.totalHands++;

  if (!resultA) {
    stats.errors++;
  } else {
    // In this hand, "ai" role = NEW engine, "human" role = OLD engine
    if (resultA.winner === 'ai') {
      stats.newWins++;
      stats.newPoints += resultA.points;
      stats.newWinsGoingFirst++;
    } else {
      stats.oldWins++;
      stats.oldPoints += resultA.points;
      stats.oldWinsGoingSecond++;
    }
  }

  // --- Hand B: OLD plays "ai" role (goes first), NEW plays "human" role ---
  // Same deal seed for fair comparison
  rngState = savedSeed;

  var engineB = new D.GameEngine();
  engineB.newMatch('hard');

  var t1 = Date.now();
  var resultB = playHand(engineB, oldAI, newAI, 'ai');
  stats.oldTimeMs += Date.now() - t1;
  stats.totalHands++;

  if (!resultB) {
    stats.errors++;
  } else {
    // In this hand, "ai" role = OLD engine, "human" role = NEW engine
    if (resultB.winner === 'ai') {
      stats.oldWins++;
      stats.oldPoints += resultB.points;
      stats.oldWinsGoingFirst++;
    } else {
      stats.newWins++;
      stats.newPoints += resultB.points;
      stats.newWinsGoingSecond++;
    }
  }

  // Progress
  if ((g + 1) % 10 === 0 || g === numGames - 1) {
    process.stdout.write('\rGame ' + (g + 1) + '/' + numGames +
      '  New: ' + stats.newWins + '  Old: ' + stats.oldWins +
      '  Errors: ' + stats.errors + '    ');
  }
}

console.log('\n');
console.log('========================================');
console.log('           FINAL RESULTS');
console.log('========================================');
console.log('');

var totalValid = stats.totalHands - stats.errors;
console.log('Total hands played: ' + totalValid);
console.log('');

console.log('NEW Bitboard Engine:');
console.log('  Total wins:     ' + stats.newWins + ' / ' + totalValid +
            ' (' + (100 * stats.newWins / totalValid).toFixed(1) + '%)');
console.log('  Wins going 1st: ' + stats.newWinsGoingFirst);
console.log('  Wins going 2nd: ' + stats.newWinsGoingSecond);
console.log('  Total points:   ' + stats.newPoints);
console.log('  Avg pts/win:    ' + (stats.newWins > 0 ? (stats.newPoints / stats.newWins).toFixed(1) : 'N/A'));
console.log('');

console.log('OLD Minimax Engine:');
console.log('  Total wins:     ' + stats.oldWins + ' / ' + totalValid +
            ' (' + (100 * stats.oldWins / totalValid).toFixed(1) + '%)');
console.log('  Wins going 1st: ' + stats.oldWinsGoingFirst);
console.log('  Wins going 2nd: ' + stats.oldWinsGoingSecond);
console.log('  Total points:   ' + stats.oldPoints);
console.log('  Avg pts/win:    ' + (stats.oldWins > 0 ? (stats.oldPoints / stats.oldWins).toFixed(1) : 'N/A'));
console.log('');

if (stats.errors > 0) {
  console.log('Errors: ' + stats.errors);
  console.log('');
}

var winDiff = stats.newWins - stats.oldWins;
console.log('========================================');
if (winDiff > 0) {
  console.log(' NEW Bitboard wins by +' + winDiff + ' hands');
} else if (winDiff < 0) {
  console.log(' OLD Minimax wins by +' + (-winDiff) + ' hands');
} else {
  console.log(' TIED');
}
console.log(' Point differential: New ' + stats.newPoints + ' vs Old ' + stats.oldPoints);
console.log('========================================');
