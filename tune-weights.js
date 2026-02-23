// ============================================================
// tune-weights.js — Texel-style eval weight tuner
//
// Uses coordinate descent to optimize evaluation weights by
// playing candidate-vs-baseline self-play tournaments.
//
// Run: node tune-weights.js [options]
//   --games N        Paired games per trial (default: 100)
//   --cycles N       Max descent cycles (default: 5)
//   --time-budget N  AI time budget in ms (default: 500)
//   --eval-only      Only tune eval weights, skip move ordering
//   --verbose        Print per-game results
//   --seed N         Base RNG seed (default: 42)
// ============================================================

'use strict';

// --- Parse CLI arguments ---
var args = process.argv.slice(2);
function getArg(name, defaultVal) {
  var idx = args.indexOf('--' + name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return defaultVal;
}
function hasFlag(name) {
  return args.indexOf('--' + name) >= 0;
}

var NUM_GAMES    = parseInt(getArg('games', '100'));
var MAX_CYCLES   = parseInt(getArg('cycles', '5'));
var TUNE_BUDGET  = parseInt(getArg('time-budget', '500'));
var BASE_SEED    = parseInt(getArg('seed', '42'));
var EVAL_ONLY    = hasFlag('eval-only');
var VERBOSE      = hasFlag('verbose');

// --- Default weights (current production values) ---
var DEFAULT_WEIGHTS = {
  W_PIP:         2,
  W_MOBILITY:    4,
  W_TILE:        5,
  W_SUIT:        3,
  W_LOCKIN:      8,
  W_LOCKIN_BOTH: 15,
  W_GHOST:       10,
  W_DOUBLE:      0.5,
  MO_DOMINO:     1000,
  MO_DOUBLE:     12,
  MO_PIP_MULT:   1.5,
  MO_FORCE_PASS: 25,
  MO_GHOST:      15
};

// --- Parameters to tune with step sizes and ranges ---
var EVAL_PARAMS = [
  { name: 'W_PIP',         step: 0.5,  min: 0, max: 10 },
  { name: 'W_MOBILITY',    step: 1,    min: 0, max: 20 },
  { name: 'W_TILE',        step: 1,    min: 0, max: 20 },
  { name: 'W_SUIT',        step: 1,    min: 0, max: 15 },
  { name: 'W_LOCKIN',      step: 2,    min: 0, max: 30 },
  { name: 'W_LOCKIN_BOTH', step: 3,    min: 0, max: 40 },
  { name: 'W_GHOST',       step: 2,    min: 0, max: 30 },
  { name: 'W_DOUBLE',      step: 0.25, min: 0, max: 5  }
];

var MO_PARAMS = [
  { name: 'MO_DOUBLE',     step: 3,   min: 0, max: 50 },
  { name: 'MO_PIP_MULT',   step: 0.5, min: 0, max: 5  },
  { name: 'MO_FORCE_PASS', step: 5,   min: 0, max: 100 },
  { name: 'MO_GHOST',      step: 3,   min: 0, max: 50 }
  // MO_DOMINO (1000) excluded — playing last tile is always best
];

// --- Shim browser globals for Node.js ---
global.window = global;
window.Domino = {};

// --- Load game engine once (shared by all AI instances) ---
require('./game.js');
var D = window.Domino;

// --- Seeded PRNG (same as compare-engines.js) ---
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

// --- Create AI with specific weights ---
// Each call clears require.cache and re-requires ai.js with new weights,
// creating an independent closure with its own eval/search functions.
function createAIWithWeights(weights) {
  var cfg = {};
  for (var k in weights) cfg[k] = weights[k];
  cfg.TIME_BUDGET = TUNE_BUDGET; // Reduced time budget for fast tuning

  D._evalWeights = cfg;
  delete require.cache[require.resolve('./ai.js')];
  require('./ai.js');
  var ai = new D.AIPlayer('hard');
  D._evalWeights = null;
  return ai;
}

// --- Create swapped proxy (same as compare-engines.js) ---
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
      moveResult = aiRolePlayer.chooseMove(legalMoves, engine);
    } else {
      moveResult = humanRolePlayer.chooseMove(legalMoves, swappedEngine);
    }

    // chooseMove returns { move: {tile, end}, bestScore, ... }
    var move = (moveResult && moveResult.move) ? moveResult.move : legalMoves[0];

    var result = engine.playTile(currentPlayer, move.tile, move.end);

    if (result.error) {
      if (VERBOSE) {
        console.error('ERROR: ' + result.error + ' player=' + currentPlayer +
                       ' tile=' + (move.tile ? move.tile.toString() : '?') + ' end=' + move.end);
      }
      return null;
    }

    if (result.handEnd) {
      return result.handEnd;
    }
  }

  if (VERBOSE) console.error('ERROR: hand exceeded max turns');
  return null;
}

// --- Run a tournament: candidate vs baseline ---
// Plays numGames paired games (same deal, swapped roles).
// Returns { candidateWins, baselineWins, candidatePoints, baselinePoints, errors, totalHands }
function tournament(candidateAI, baselineAI, numGames, startSeed) {
  var stats = {
    candidateWins: 0,
    baselineWins: 0,
    candidatePoints: 0,
    baselinePoints: 0,
    errors: 0,
    totalHands: 0
  };

  for (var g = 0; g < numGames; g++) {
    rngState = startSeed + g * 7919;
    var savedSeed = rngState;

    // Hand A: candidate as "ai" role (goes first)
    var engineA = new D.GameEngine();
    engineA.newMatch('hard');

    var resultA = playHand(engineA, candidateAI, baselineAI, 'ai');
    stats.totalHands++;

    if (!resultA) {
      stats.errors++;
    } else {
      if (resultA.winner === 'ai') {
        stats.candidateWins++;
        stats.candidatePoints += resultA.points;
      } else {
        stats.baselineWins++;
        stats.baselinePoints += resultA.points;
      }
    }

    // Hand B: baseline as "ai" role (goes first), same deal
    rngState = savedSeed;
    var engineB = new D.GameEngine();
    engineB.newMatch('hard');

    var resultB = playHand(engineB, baselineAI, candidateAI, 'ai');
    stats.totalHands++;

    if (!resultB) {
      stats.errors++;
    } else {
      if (resultB.winner === 'ai') {
        stats.baselineWins++;
        stats.baselinePoints += resultB.points;
      } else {
        stats.candidateWins++;
        stats.candidatePoints += resultB.points;
      }
    }
  }

  return stats;
}

// --- Evaluate whether candidate weights are better ---
// Returns 'better', 'worse', or 'neutral'
function evaluateWeights(candidateWeights, baselineWeights, numGames) {
  var candidateAI = createAIWithWeights(candidateWeights);
  var baselineAI = createAIWithWeights(baselineWeights);
  var stats = tournament(candidateAI, baselineAI, numGames, BASE_SEED);

  var total = stats.candidateWins + stats.baselineWins;
  if (total === 0) return 'neutral';

  var winRate = stats.candidateWins / total;

  if (VERBOSE) {
    console.log('      Result: ' + stats.candidateWins + 'W / ' +
                stats.baselineWins + 'L (' + (winRate * 100).toFixed(1) + '%)' +
                ' pts: ' + stats.candidatePoints + ' vs ' + stats.baselinePoints);
  }

  // Need >52% win rate with enough games to consider it an improvement
  // (~14 Elo difference threshold)
  if (winRate > 0.52) return 'better';
  if (winRate < 0.48) return 'worse';
  return 'neutral';
}

// --- Print weights in copy-paste format ---
function reportWeights(weights, label) {
  console.log('');
  console.log('--- ' + (label || 'Current Best Weights') + ' ---');
  console.log('  // Evaluation weights');
  console.log('  var W_PIP         = ' + weights.W_PIP + ';');
  console.log('  var W_MOBILITY    = ' + weights.W_MOBILITY + ';');
  console.log('  var W_TILE        = ' + weights.W_TILE + ';');
  console.log('  var W_SUIT        = ' + weights.W_SUIT + ';');
  console.log('  var W_LOCKIN      = ' + weights.W_LOCKIN + ';');
  console.log('  var W_LOCKIN_BOTH = ' + weights.W_LOCKIN_BOTH + ';');
  console.log('  var W_GHOST       = ' + weights.W_GHOST + ';');
  console.log('  var W_DOUBLE      = ' + weights.W_DOUBLE + ';');
  if (!EVAL_ONLY) {
    console.log('');
    console.log('  // Move ordering weights');
    console.log('  var MO_DOMINO     = ' + weights.MO_DOMINO + ';');
    console.log('  var MO_DOUBLE     = ' + weights.MO_DOUBLE + ';');
    console.log('  var MO_PIP_MULT   = ' + weights.MO_PIP_MULT + ';');
    console.log('  var MO_FORCE_PASS = ' + weights.MO_FORCE_PASS + ';');
    console.log('  var MO_GHOST      = ' + weights.MO_GHOST + ';');
  }
  console.log('');
  console.log('  JSON: ' + JSON.stringify(weights));
  console.log('');
}

// --- Coordinate Descent ---
function coordinateDescent(startWeights, params) {
  var weights = {};
  for (var k in startWeights) weights[k] = startWeights[k];

  var improved = true;
  var cycle = 0;
  var totalImprovements = 0;

  while (improved && cycle < MAX_CYCLES) {
    improved = false;
    cycle++;
    var cycleImprovements = 0;

    console.log('');
    console.log('========================================');
    console.log('  CYCLE ' + cycle + ' / ' + MAX_CYCLES);
    console.log('========================================');

    for (var p = 0; p < params.length; p++) {
      var param = params[p];
      var currentVal = weights[param.name];

      process.stdout.write('  ' + param.name + ' = ' + currentVal + ' ... ');

      // Try step UP
      var upVal = Math.min(currentVal + param.step, param.max);
      if (upVal !== currentVal) {
        var upWeights = {};
        for (var k in weights) upWeights[k] = weights[k];
        upWeights[param.name] = upVal;

        var upResult = evaluateWeights(upWeights, weights, NUM_GAMES);

        if (upResult === 'better') {
          console.log('+' + param.step + ' => ' + upVal + '  IMPROVED');
          weights[param.name] = upVal;
          improved = true;
          cycleImprovements++;
          totalImprovements++;
          continue;
        }
      }

      // Try step DOWN
      var downVal = Math.max(currentVal - param.step, param.min);
      if (downVal !== currentVal) {
        var downWeights = {};
        for (var k in weights) downWeights[k] = weights[k];
        downWeights[param.name] = downVal;

        var downResult = evaluateWeights(downWeights, weights, NUM_GAMES);

        if (downResult === 'better') {
          console.log('-' + param.step + ' => ' + downVal + '  IMPROVED');
          weights[param.name] = downVal;
          improved = true;
          cycleImprovements++;
          totalImprovements++;
          continue;
        }
      }

      console.log('no change');
    }

    console.log('');
    console.log('Cycle ' + cycle + ' complete: ' + cycleImprovements + ' improvement(s)');
    reportWeights(weights, 'Weights after cycle ' + cycle);
  }

  return { weights: weights, improvements: totalImprovements, cycles: cycle };
}

// ============================================================
// MAIN
// ============================================================

console.log('========================================');
console.log('  DOMINOS AI — EVAL WEIGHT TUNER');
console.log('========================================');
console.log('');
console.log('Games per trial:  ' + NUM_GAMES + ' (paired = ' + (NUM_GAMES * 2) + ' hands)');
console.log('Max cycles:       ' + MAX_CYCLES);
console.log('AI time budget:   ' + TUNE_BUDGET + 'ms (production: 5000ms)');
console.log('Tuning:           ' + (EVAL_ONLY ? 'eval weights only' : 'eval + move ordering'));
console.log('Base seed:        ' + BASE_SEED);
console.log('');

// Show starting weights
reportWeights(DEFAULT_WEIGHTS, 'Starting Weights (production defaults)');

// Sanity check: baseline vs itself should be ~50%
console.log('--- Sanity check: baseline vs itself ---');
var sanityAI1 = createAIWithWeights(DEFAULT_WEIGHTS);
var sanityAI2 = createAIWithWeights(DEFAULT_WEIGHTS);
var sanityStats = tournament(sanityAI1, sanityAI2, Math.min(20, NUM_GAMES), BASE_SEED);
var sanityTotal = sanityStats.candidateWins + sanityStats.baselineWins;
var sanityRate = sanityTotal > 0 ? (sanityStats.candidateWins / sanityTotal * 100).toFixed(1) : '?';
console.log('  Self-play: ' + sanityStats.candidateWins + 'W / ' +
            sanityStats.baselineWins + 'L (' + sanityRate + '%) — should be ~50%');
console.log('');

// Build parameter list
var params = EVAL_PARAMS.slice();
if (!EVAL_ONLY) {
  params = params.concat(MO_PARAMS);
}

// Run coordinate descent
var startTime = Date.now();
var result = coordinateDescent(DEFAULT_WEIGHTS, params);
var elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

// Final report
console.log('');
console.log('========================================');
console.log('           TUNING COMPLETE');
console.log('========================================');
console.log('');
console.log('Total time:        ' + elapsed + 's (' + (elapsed / 60).toFixed(1) + ' min)');
console.log('Cycles completed:  ' + result.cycles);
console.log('Total improvements: ' + result.improvements);
console.log('');

if (result.improvements > 0) {
  reportWeights(result.weights, 'OPTIMIZED WEIGHTS — copy to ai.js');

  // Validate: optimized vs original
  console.log('--- Validation: optimized vs original defaults ---');
  var optimizedAI = createAIWithWeights(result.weights);
  var originalAI = createAIWithWeights(DEFAULT_WEIGHTS);
  var valStats = tournament(optimizedAI, originalAI, NUM_GAMES, BASE_SEED + 999999);
  var valTotal = valStats.candidateWins + valStats.baselineWins;
  var valRate = valTotal > 0 ? (valStats.candidateWins / valTotal * 100).toFixed(1) : '?';
  console.log('  Optimized: ' + valStats.candidateWins + 'W / ' +
              valStats.baselineWins + 'L (' + valRate + '%)');
  console.log('  Points: optimized ' + valStats.candidatePoints +
              ' vs original ' + valStats.baselinePoints);
} else {
  console.log('No improvements found. Current weights may already be near-optimal.');
  reportWeights(result.weights, 'Unchanged weights');
}

console.log('');
console.log('========================================');
