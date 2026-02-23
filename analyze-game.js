// ============================================================
// analyze-game.js — Post-Game Analysis: Perfect Play Comparison
//
// Replays a completed game and re-solves every position at full
// depth to find the perfect move. Reports where each player
// deviated from perfect play, like chess engine analysis.
//
// Run: node analyze-game.js <game.json> [options]
//   --time-budget N   AI thinking time per move in ms (default: 30000)
//   --verbose         Show per-move AI search details
//   --human-only      Only analyze human moves
//   --ai-only         Only analyze AI moves
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

var GAME_FILE    = args.find(function (a) { return !a.startsWith('--'); });
var TIME_BUDGET  = parseInt(getArg('time-budget', '30000'));
var VERBOSE      = hasFlag('verbose');
var HUMAN_ONLY   = hasFlag('human-only');
var AI_ONLY      = hasFlag('ai-only');

if (!GAME_FILE) {
  console.log('Usage: node analyze-game.js <game.json> [options]');
  console.log('');
  console.log('Options:');
  console.log('  --time-budget N   AI thinking time per move in ms (default: 30000)');
  console.log('  --verbose         Show per-move AI search details (depth, nodes)');
  console.log('  --human-only      Only analyze human moves');
  console.log('  --ai-only         Only analyze AI moves');
  console.log('');
  console.log('Game JSON format:');
  console.log('  {');
  console.log('    "leader": "human"|"ai",');
  console.log('    "humanTiles": [{"low":0,"high":1}, ...],');
  console.log('    "aiTiles":    [{"low":4,"high":5}, ...],');
  console.log('    "moves": [');
  console.log('      {"player":"human", "tile":{"low":0,"high":1}, "end":"left"},');
  console.log('      {"player":"ai",    "pass": true},');
  console.log('      ...');
  console.log('    ]');
  console.log('  }');
  process.exit(1);
}

// --- Shim browser globals for Node.js ---
global.window = global;
window.Domino = {};

// --- Load game engine ---
require('./game.js');
var D = window.Domino;

// --- Load AI with configurable time budget ---
function createAnalysisAI() {
  D._evalWeights = { TIME_BUDGET: TIME_BUDGET };
  delete require.cache[require.resolve('./ai.js')];
  require('./ai.js');
  var ai = new D.AIPlayer('hard');
  D._evalWeights = null;
  return ai;
}

// --- Create swapped proxy for human-perspective analysis ---
// (Reused from compare-engines.js / tune-weights.js)
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

// --- Load game data ---
function loadGame(filePath) {
  var fs = require('fs');
  var raw = fs.readFileSync(filePath, 'utf8');
  var data = JSON.parse(raw);

  // Validate required fields
  if (!data.leader) throw new Error('Missing "leader" field');
  if (!data.humanTiles || !data.aiTiles) throw new Error('Missing tile arrays');
  if (!data.moves) throw new Error('Missing "moves" array');
  if (data.humanTiles.length !== 14) throw new Error('humanTiles must have 14 tiles');
  if (data.aiTiles.length !== 14) throw new Error('aiTiles must have 14 tiles');

  return data;
}

// --- Reconstruct position at a given move index ---
// Creates a fresh engine, deals the same tiles, replays moves 0..moveIndex-1
function reconstructPosition(gameData, moveIndex) {
  var engine = new D.GameEngine();
  engine.newMatch('hard');
  engine.dealHandFromTiles(gameData.leader, gameData.humanTiles, gameData.aiTiles);

  for (var i = 0; i < moveIndex; i++) {
    var m = gameData.moves[i];
    if (m.pass) {
      engine.pass(m.player);
    } else {
      // Find the tile in the current hand
      var hand = engine.getHand(m.player);
      var tileId = Math.min(m.tile.low, m.tile.high) + '-' + Math.max(m.tile.low, m.tile.high);
      var tile = hand.findById(tileId);
      if (!tile) {
        throw new Error('Move ' + i + ': tile ' + tileId + ' not found in ' + m.player + ' hand');
      }
      var result = engine.playTile(m.player, tile, m.end);
      if (result.error) {
        throw new Error('Move ' + i + ': ' + result.error);
      }
    }
  }

  return engine;
}

// --- Move classification ---
function classifyMove(scoreDiff) {
  if (scoreDiff === 0) return { grade: 'Perfect',     symbol: '\u2713' };   // ✓
  if (scoreDiff <= 4)  return { grade: 'Good',         symbol: '~' };
  if (scoreDiff <= 14) return { grade: 'Inaccuracy',   symbol: '?!' };
  if (scoreDiff <= 29) return { grade: 'Mistake',      symbol: '?' };
  return                       { grade: 'Blunder',      symbol: '??' };
}

// --- Find actual move's score in analysis array ---
function findActualScore(analysis, tileId, end) {
  for (var i = 0; i < analysis.length; i++) {
    if (analysis[i].tileId === tileId && analysis[i].end === end) {
      return analysis[i].score;
    }
  }
  // Fallback: same tile, different end (shouldn't happen, but safe)
  for (var i = 0; i < analysis.length; i++) {
    if (analysis[i].tileId === tileId) {
      return analysis[i].score;
    }
  }
  return null;
}

// --- Pad string for alignment ---
function pad(str, len) {
  str = String(str);
  while (str.length < len) str = ' ' + str;
  return str;
}
function padRight(str, len) {
  str = String(str);
  while (str.length < len) str += ' ';
  return str;
}

// --- Main analysis ---
function analyzeGame(gameData) {
  var ai = createAnalysisAI();
  var results = [];
  var totalMoves = gameData.moves.length;

  console.log('=== Game Analysis ===');
  console.log('Time budget: ' + (TIME_BUDGET / 1000) + 's per move | Moves: ' + totalMoves);
  if (HUMAN_ONLY) console.log('Analyzing: human moves only');
  if (AI_ONLY) console.log('Analyzing: AI moves only');
  console.log('');

  for (var i = 0; i < totalMoves; i++) {
    var move = gameData.moves[i];
    var moveNum = i + 1;

    // Skip passes — no choice to analyze
    if (move.pass) {
      results.push({
        moveNum: moveNum,
        player: move.player,
        actual: 'PASS',
        best: 'PASS',
        scoreDiff: 0,
        classification: classifyMove(0),
        forced: true,
        depth: 0,
        nodes: 0
      });
      continue;
    }

    // Skip based on filter flags
    if (HUMAN_ONLY && move.player !== 'human') {
      results.push({
        moveNum: moveNum,
        player: move.player,
        actual: '[' + move.tile.low + '|' + move.tile.high + ']' + move.end[0].toUpperCase(),
        best: '-',
        scoreDiff: 0,
        classification: { grade: 'Skipped', symbol: '-' },
        forced: false,
        skipped: true
      });
      continue;
    }
    if (AI_ONLY && move.player !== 'ai') {
      results.push({
        moveNum: moveNum,
        player: move.player,
        actual: '[' + move.tile.low + '|' + move.tile.high + ']' + move.end[0].toUpperCase(),
        best: '-',
        scoreDiff: 0,
        classification: { grade: 'Skipped', symbol: '-' },
        forced: false,
        skipped: true
      });
      continue;
    }

    // Reconstruct position
    var engine = reconstructPosition(gameData, i);
    var currentPlayer = engine.hand.currentPlayer;
    var legalMoves = engine.getLegalMoves(currentPlayer);

    // Forced move (only 1 legal move)
    if (legalMoves.length <= 1) {
      var tileStr = '[' + move.tile.low + '|' + move.tile.high + ']' + move.end[0].toUpperCase();
      results.push({
        moveNum: moveNum,
        player: move.player,
        actual: tileStr,
        best: tileStr,
        scoreDiff: 0,
        classification: classifyMove(0),
        forced: true,
        depth: 0,
        nodes: 0
      });
      process.stdout.write('\rMove ' + moveNum + '/' + totalMoves + ' (forced)        ');
      continue;
    }

    // Run AI analysis
    var t0 = Date.now();
    var aiResult;
    if (currentPlayer === 'human') {
      // Swap perspective so AI searches from human's viewpoint
      var swapped = createSwappedProxy(engine);
      aiResult = ai.chooseMove(legalMoves, swapped);
    } else {
      aiResult = ai.chooseMove(legalMoves, engine);
    }
    var elapsed = Date.now() - t0;

    // Extract AI's best move info
    var bestMove = aiResult.move;
    var bestScore = aiResult.bestScore;
    var analysis = aiResult.analysis || [];
    var depth = aiResult.depth || 0;
    var nodes = aiResult.nodes || 0;

    // Find the actual move's score in analysis
    var actualTileId = Math.min(move.tile.low, move.tile.high) + '-' + Math.max(move.tile.low, move.tile.high);
    var actualScore = findActualScore(analysis, actualTileId, move.end);

    // Calculate score difference
    var scoreDiff = 0;
    if (actualScore !== null && bestScore !== null) {
      scoreDiff = bestScore - actualScore;
      // Clamp to 0 — negative diff means actual was better (rounding/depth variance)
      if (scoreDiff < 0) scoreDiff = 0;
    }

    var bestStr = '[' + bestMove.tile.low + '|' + bestMove.tile.high + ']' + bestMove.end[0].toUpperCase();
    var actualStr = '[' + move.tile.low + '|' + move.tile.high + ']' + move.end[0].toUpperCase();

    var classification = classifyMove(scoreDiff);

    results.push({
      moveNum: moveNum,
      player: move.player,
      actual: actualStr,
      best: bestStr,
      scoreDiff: scoreDiff,
      classification: classification,
      forced: false,
      depth: depth,
      nodes: nodes,
      elapsed: elapsed,
      bestScore: bestScore,
      actualScore: actualScore
    });

    process.stdout.write('\rMove ' + moveNum + '/' + totalMoves +
      ' ' + move.player + ' ' + actualStr +
      ' -> ' + classification.symbol +
      ' (d=' + depth + ', ' + (elapsed / 1000).toFixed(1) + 's)        ');

    if (VERBOSE) {
      console.log('');
      console.log('  Legal moves: ' + legalMoves.length +
        ' | Depth: ' + depth + ' | Nodes: ' + nodes.toLocaleString() +
        ' | Time: ' + (elapsed / 1000).toFixed(1) + 's');
      console.log('  Best: ' + bestStr + ' (score: ' + bestScore + ')');
      console.log('  Actual: ' + actualStr + ' (score: ' + (actualScore !== null ? actualScore : '?') + ')');
      if (analysis.length > 0) {
        console.log('  All moves:');
        for (var a = 0; a < analysis.length; a++) {
          var entry = analysis[a];
          console.log('    [' + entry.tileId + ']' + entry.end[0].toUpperCase() +
            ': ' + entry.score);
        }
      }
    }
  }

  console.log('\r' + pad('', 60)); // Clear progress line
  return results;
}

// --- Print final report ---
function printReport(results, gameData) {
  console.log('');
  console.log('Move  Player  Actual       Best         Diff  Grade');
  console.log('----  ------  -----------  -----------  ----  ----------');

  var humanStats = { total: 0, perfect: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
  var aiStats    = { total: 0, perfect: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
  var criticalMoments = [];

  for (var i = 0; i < results.length; i++) {
    var r = results[i];

    // Print move line
    console.log(
      pad(r.moveNum, 4) + '  ' +
      padRight(r.player, 6) + '  ' +
      padRight(r.actual, 11) + '  ' +
      padRight(r.best, 11) + '  ' +
      pad(r.skipped ? '-' : (r.forced ? '0' : '+' + r.scoreDiff), 4) + '  ' +
      r.classification.symbol + ' ' + r.classification.grade
    );

    // Track stats (skip passes and filtered moves)
    if (r.skipped) continue;

    var stats = r.player === 'human' ? humanStats : aiStats;
    if (!r.forced || r.classification.grade === 'Perfect') {
      stats.total++;
      switch (r.classification.grade) {
        case 'Perfect':    stats.perfect++;    break;
        case 'Good':       stats.good++;       break;
        case 'Inaccuracy': stats.inaccuracy++; break;
        case 'Mistake':    stats.mistake++;    break;
        case 'Blunder':    stats.blunder++;    break;
      }
    }

    // Track critical moments (Inaccuracy or worse, non-forced)
    if (!r.forced && !r.skipped && r.scoreDiff >= 5) {
      criticalMoments.push(r);
    }
  }

  console.log('');
  console.log('=== Summary ===');

  if (!AI_ONLY) {
    var hAcc = humanStats.total > 0 ? (100 * humanStats.perfect / humanStats.total).toFixed(0) : 'N/A';
    console.log('Human: ' + hAcc + '% accuracy (' +
      humanStats.perfect + '/' + humanStats.total + ' perfect' +
      (humanStats.good > 0 ? ', ' + humanStats.good + ' good' : '') +
      (humanStats.inaccuracy > 0 ? ', ' + humanStats.inaccuracy + ' inaccuracy' : '') +
      (humanStats.mistake > 0 ? ', ' + humanStats.mistake + ' mistake' : '') +
      (humanStats.blunder > 0 ? ', ' + humanStats.blunder + ' blunder' : '') +
      ')');
  }

  if (!HUMAN_ONLY) {
    var aAcc = aiStats.total > 0 ? (100 * aiStats.perfect / aiStats.total).toFixed(0) : 'N/A';
    console.log('AI:    ' + aAcc + '% accuracy (' +
      aiStats.perfect + '/' + aiStats.total + ' perfect' +
      (aiStats.good > 0 ? ', ' + aiStats.good + ' good' : '') +
      (aiStats.inaccuracy > 0 ? ', ' + aiStats.inaccuracy + ' inaccuracy' : '') +
      (aiStats.mistake > 0 ? ', ' + aiStats.mistake + ' mistake' : '') +
      (aiStats.blunder > 0 ? ', ' + aiStats.blunder + ' blunder' : '') +
      ')');
  }

  if (criticalMoments.length > 0) {
    console.log('');
    console.log('Critical moments:');
    for (var c = 0; c < criticalMoments.length; c++) {
      var cm = criticalMoments[c];
      console.log('  Move ' + pad(cm.moveNum, 2) + ': ' + cm.player +
        ' played ' + cm.actual + ' instead of ' + cm.best +
        ' (diff: +' + cm.scoreDiff + ', ' + cm.classification.grade + ')');
    }
  } else {
    console.log('');
    console.log('No critical moments found — all moves were good or perfect!');
  }

  // Try to determine game result by replaying to completion
  try {
    var engine = reconstructPosition(gameData, gameData.moves.length);
    // After all moves, check if the hand ended (last move might have ended it)
    var lastMove = gameData.moves[gameData.moves.length - 1];
    if (lastMove && !lastMove.pass) {
      // The hand may have ended on the last move — check remaining tiles
      var humanLeft = engine.hand.humanHand.count();
      var aiLeft = engine.hand.aiHand.count();
      if (humanLeft === 0) {
        console.log('');
        console.log('Result: Human wins by domino');
      } else if (aiLeft === 0) {
        console.log('');
        console.log('Result: AI wins by domino');
      }
    }
  } catch (e) {
    // Last move ended the hand via handEnd — that's OK
  }

  console.log('');
  console.log('========================================');
}

// --- Main ---
try {
  var gameData = loadGame(GAME_FILE);
  console.log('Loaded game: ' + gameData.moves.length + ' moves, leader: ' + gameData.leader);
  console.log('Human tiles: ' + gameData.humanTiles.map(function (t) {
    return '[' + t.low + '|' + t.high + ']';
  }).join(' '));
  console.log('AI tiles:    ' + gameData.aiTiles.map(function (t) {
    return '[' + t.low + '|' + t.high + ']';
  }).join(' '));
  console.log('');

  var results = analyzeGame(gameData);
  printReport(results, gameData);

} catch (e) {
  console.error('Error: ' + e.message);
  if (VERBOSE) console.error(e.stack);
  process.exit(1);
}
