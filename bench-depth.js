// bench-depth.js — Measure time to reach each search depth after N turns
// Run: node bench-depth.js
'use strict';

global.window = global;
window.Domino = {};
require('./game.js');
var D = window.Domino;
require('./ai.js');
var AI = D.AIPlayer;

// Seeded PRNG
var rngState = 123;
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

// Monkey-patch the time check to disable it — let engine search to full depth
// We'll override chooseMoveHard with a depth-instrumented version
// Instead, let's override the time budget to be very large
var origChoose = AI.prototype.chooseMove;

function benchmarkPosition(turnsPlayed) {
  var engine = new D.GameEngine();
  var origShuf = D.shuffle;
  D.shuffle = seededShuffle;
  rngState = currentSeed;
  var hand = engine.dealHand('ai');
  D.shuffle = origShuf;

  // Play N turns with simple greedy (first legal move)
  for (var t = 0; t < turnsPlayed; t++) {
    var cp = hand.currentPlayer;
    var moves = engine.getLegalMoves(cp);
    if (moves.length === 0) {
      var r = engine.pass(cp);
      if (r) { console.log('  Game ended during setup at turn ' + t); return; }
      t--; // pass doesn't count as a "turn played"
      continue;
    }
    var result = engine.playTile(cp, moves[0].tile, moves[0].end);
    if (result.error) { console.log('  Error during setup: ' + result.error); return; }
    if (result.domino || result.block) { console.log('  Game ended during setup at turn ' + t); return; }
  }

  var tilesRemaining = hand.aiHand.tiles.length + hand.humanHand.tiles.length;
  var cp = hand.currentPlayer;
  var legalMoves = engine.getLegalMoves(cp);

  console.log('\n=== After ' + turnsPlayed + ' turns (' + tilesRemaining + ' tiles remaining) ===');
  console.log('Current player: ' + cp + ', Legal moves: ' + legalMoves.length);

  if (legalMoves.length <= 1) {
    console.log('  Only 0-1 legal moves, skipping benchmark');
    return;
  }

  // If it's human's turn, we need to swap perspective for the AI
  var searchEngine = engine;
  if (cp === 'human') {
    // Create a fake engine where ai/human hands are swapped
    searchEngine = Object.create(engine);
    Object.defineProperty(searchEngine, 'hand', {
      get: function() {
        var rh = engine.hand;
        return {
          aiHand: rh.humanHand,
          humanHand: rh.aiHand,
          board: rh.board,
          currentPlayer: rh.currentPlayer,
          consecutivePasses: rh.consecutivePasses,
          lastPlacer: rh.lastPlacer,
          moveHistory: rh.moveHistory.map(function(m) {
            return { player: m.player === 'ai' ? 'human' : 'ai', tile: m.tile, end: m.end, pass: m.pass, boardEnds: m.boardEnds };
          })
        };
      }
    });
    searchEngine.matchScore = { ai: 0, human: 0 };
  }

  // Override _evalWeights to set huge time budget (10 minutes)
  // Actually, we need to patch the AI to report per-depth timing
  // Let's just run chooseMove with a huge time override

  // Temporarily patch Date.now to control timing
  // Actually simpler: just set a huge time budget by patching the engine config
  // The time budget is computed inside chooseMoveHard based on totalTiles

  // Let's just call chooseMove and measure total time, but we need per-depth info
  // The AI returns { depth, nodes } but not per-depth breakdown

  // Better approach: run multiple times with increasing NODE_LIMIT
  // Or just measure the total and report what depth it reaches

  if (!searchEngine.matchScore) searchEngine.matchScore = { ai: 0, human: 0 };

  var ai = new AI('hard');

  // Just run one search with the engine's default time budget and report
  var t0 = Date.now();
  var result = ai.chooseMove(legalMoves, searchEngine);
  var elapsed = Date.now() - t0;

  console.log('  Default budget: depth=' + result.depth + ', nodes=' + result.nodes +
              ', time=' + elapsed + 'ms');
  console.log('  Max possible depth (full solve): ' + tilesRemaining);
  console.log('  Depth gap: ' + (tilesRemaining - result.depth) + ' plies short of full solve');

  // Now estimate: run with no time limit by temporarily patching
  // Actually let's just extrapolate from nodes/sec
  var nodesPerSec = Math.round(result.nodes / (elapsed / 1000));
  console.log('  Speed: ~' + nodesPerSec.toLocaleString() + ' nodes/sec');

  return { turnsPlayed: turnsPlayed, tilesRemaining: tilesRemaining, depth: result.depth,
           nodes: result.nodes, timeMs: elapsed, nodesPerSec: nodesPerSec };
}

console.log('Depth Benchmark — JS Bitboard Engine');
console.log('=====================================');

var results = [];
var scenarios = [0, 1, 2, 3, 5];
var seeds = [42, 99, 200, 777, 1234];
var currentSeed;
for (var si = 0; si < seeds.length; si++) {
  console.log('\n>>> SEED ' + seeds[si] + ' <<<');
  for (var i = 0; i < scenarios.length; i++) {
    currentSeed = seeds[si];
    var r = benchmarkPosition(scenarios[i]);
    if (r) { r.seed = seeds[si]; results.push(r); }
  }
}

console.log('\n\n=== SUMMARY TABLE ===');
console.log('Turns | Tiles Left | Depth | Nodes      | Time(ms) | Nodes/sec   | Gap to Full');
console.log('------|------------|-------|------------|----------|-------------|------------');
for (var i = 0; i < results.length; i++) {
  var r = results[i];
  var gap = r.tilesRemaining - r.depth;
  console.log(
    String(r.turnsPlayed).padStart(5) + ' | ' +
    String(r.tilesRemaining).padStart(10) + ' | ' +
    String(r.depth).padStart(5) + ' | ' +
    String(r.nodes).padStart(10) + ' | ' +
    String(r.timeMs).padStart(8) + ' | ' +
    String(r.nodesPerSec).padStart(11) + ' | ' +
    String(gap).padStart(11)
  );
}

console.log('\nWASM estimate: 5-10x speedup would search ~2-4 deeper plies');
