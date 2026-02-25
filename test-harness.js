// ============================================================
// test-harness.js — Self-play, Puppeteer scenario tests, and
//                   performance benchmarks for the Dominos AI
// ============================================================

(function () {
  'use strict';

  var D = window.Domino;
  var outputEl = null;

  function getOutput() {
    if (!outputEl) outputEl = document.getElementById('output');
    return outputEl;
  }

  function log(msg, cls) {
    var el = getOutput();
    if (cls) {
      el.innerHTML += '<span class="' + cls + '">' + escHtml(msg) + '</span>\n';
    } else {
      el.innerHTML += escHtml(msg) + '\n';
    }
    el.scrollTop = el.scrollHeight;
  }

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function clearOutput() {
    getOutput().innerHTML = '';
  }

  // --- Seeded PRNG: xorshift128 ---
  var s0, s1, s2, s3;

  function seedRng(seed) {
    s0 = seed | 0;
    s1 = (seed * 1103515245 + 12345) | 0;
    s2 = (seed * 214013 + 2531011) | 0;
    s3 = (seed * 48271) | 0;
    // Warm up
    for (var i = 0; i < 20; i++) xorshift128();
  }

  function xorshift128() {
    var t = s3;
    var s = s0;
    s3 = s2;
    s2 = s1;
    s1 = s;
    t ^= t << 11;
    t ^= t >>> 8;
    s0 = t ^ s ^ (s >>> 19);
    return (s0 >>> 0) / 4294967296;
  }

  // Deterministic shuffle using seeded PRNG
  function seededShuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(xorshift128() * (i + 1));
      var tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  // Deal a hand using seeded PRNG instead of Math.random
  function seededDeal(engine, leader) {
    engine.handNumber++;
    var allTiles = D.createTileSet();
    seededShuffle(allTiles);

    var humanHand = new D.Hand();
    var aiHand = new D.Hand();

    for (var i = 0; i < 14; i++) humanHand.add(allTiles[i]);
    for (var i = 14; i < 28; i++) aiHand.add(allTiles[i]);

    engine.hand = {
      humanHand: humanHand,
      aiHand: aiHand,
      board: new D.Board(),
      currentPlayer: leader,
      consecutivePasses: 0,
      lastPlacer: null,
      moveHistory: [],
      opponentPassedValues: { human: [], ai: [] }
    };
    return engine.hand;
  }

  // ============================================================
  // Self-Play: AI vs AI
  // ============================================================

  function selfPlay(numHands, seed) {
    seedRng(seed);

    var engine = new D.GameEngine();
    engine.newMatch('hard');
    var ai1 = new D.AIPlayer('hard'); // "human" player also using hard AI
    var ai2 = new D.AIPlayer('hard'); // AI player

    var stats = {
      ai1Wins: 0, ai2Wins: 0,
      dominos: 0, successfulBlocks: 0, failedBlocks: 0,
      totalMoves: 0, totalTime: 0,
      crashes: 0
    };

    var leader = 'human'; // ai1 acts as "human"

    for (var h = 0; h < numHands; h++) {
      seededDeal(engine, leader);

      var moveCount = 0;
      var maxMoves = 100; // safety limit

      try {
        while (moveCount < maxMoves) {
          var currentPlayer = engine.hand.currentPlayer;
          var legalMoves = engine.getLegalMoves(currentPlayer);

          if (legalMoves.length === 0) {
            var blockResult = engine.pass(currentPlayer);
            if (blockResult) {
              recordResult(stats, blockResult, h);
              leader = blockResult.winner;
              engine.previousHandWinner = blockResult.winner;
              break;
            }
            continue;
          }

          // Choose move using the appropriate AI instance
          var t0 = Date.now();
          var chosenAI = (currentPlayer === 'human') ? ai1 : ai2;
          var move = chosenAI.chooseMove(legalMoves, engine);
          stats.totalTime += Date.now() - t0;
          stats.totalMoves++;

          var result = engine.playTile(currentPlayer, move.tile, move.end);
          moveCount++;

          if (result.handEnd) {
            recordResult(stats, result.handEnd, h);
            leader = result.handEnd.winner;
            engine.previousHandWinner = result.handEnd.winner;
            break;
          }
        }

        if (moveCount >= maxMoves) {
          log('  Hand ' + (h + 1) + ': EXCEEDED move limit (possible infinite loop)', 'warn');
          stats.crashes++;
        }
      } catch (e) {
        log('  Hand ' + (h + 1) + ': CRASH — ' + e.message, 'fail');
        stats.crashes++;
        leader = 'human'; // reset
      }
    }

    return stats;
  }

  function recordResult(stats, result, handIdx) {
    if (result.type === 'domino') {
      stats.dominos++;
    } else if (result.type === 'successful_block') {
      stats.successfulBlocks++;
    } else if (result.type === 'failed_block') {
      stats.failedBlocks++;
    }

    if (result.winner === 'human') {
      stats.ai1Wins++;
    } else {
      stats.ai2Wins++;
    }
  }

  // ============================================================
  // Puppeteer Scenario Tests
  // ============================================================

  function runPuppeteerScenarios() {
    var passed = 0;
    var failed = 0;
    var scenarios = getPuppeteerScenarios();

    for (var i = 0; i < scenarios.length; i++) {
      var sc = scenarios[i];
      log('  Test ' + (i + 1) + ': ' + sc.name);

      var engine = new D.GameEngine();
      engine.newMatch('hard');
      engine.handNumber = 1;

      // Set up the hand state
      var humanHand = new D.Hand();
      var aiHand = new D.Hand();
      for (var j = 0; j < sc.humanTiles.length; j++) {
        humanHand.add(new D.Tile(sc.humanTiles[j][0], sc.humanTiles[j][1]));
      }
      for (var j = 0; j < sc.aiTiles.length; j++) {
        aiHand.add(new D.Tile(sc.aiTiles[j][0], sc.aiTiles[j][1]));
      }

      var board = new D.Board();
      // Place tiles to set up the board ends
      if (sc.boardTiles && sc.boardTiles.length > 0) {
        for (var j = 0; j < sc.boardTiles.length; j++) {
          var bt = sc.boardTiles[j];
          board.place(new D.Tile(bt[0], bt[1]), bt[2]);
        }
      }

      engine.hand = {
        humanHand: humanHand,
        aiHand: aiHand,
        board: board,
        currentPlayer: sc.currentPlayer || 'human',
        consecutivePasses: sc.consecutivePasses || 0,
        lastPlacer: sc.lastPlacer || null,
        moveHistory: sc.moveHistory || [],
        opponentPassedValues: { human: [], ai: [] }
      };

      // Resolve the block using the engine
      var result = engine.resolveBlock();

      if (result.winner === sc.expectedWinner &&
          result.aggressor === sc.expectedAggressor &&
          result.type === sc.expectedType) {
        log('    PASS: winner=' + result.winner + ', aggressor=' + result.aggressor +
            ', type=' + result.type + ', points=' + result.points, 'pass');
        passed++;
      } else {
        log('    FAIL: expected winner=' + sc.expectedWinner + ', aggressor=' + sc.expectedAggressor +
            ', type=' + sc.expectedType, 'fail');
        log('    GOT:  winner=' + result.winner + ', aggressor=' + result.aggressor +
            ', type=' + result.type + ', points=' + result.points, 'fail');
        failed++;
      }
    }

    return { passed: passed, failed: failed };
  }

  function getPuppeteerScenarios() {
    // Handcrafted scenarios where the Puppeteer Rule applies or doesn't

    return [
      {
        name: 'Direct block — AI is aggressor (last placer)',
        humanTiles: [[5, 6]],
        aiTiles: [[3, 4]],
        boardTiles: [[1, 2, 'left'], [2, 3, 'right']],
        // Board: 1—[1|2]—[2|3]—3, left=1, right=3
        // AI [3|4] can play right → left=1, right=4
        // Human [5|6] cannot play → both stuck
        lastPlacer: 'ai',
        moveHistory: [
          { player: 'human', tile: new D.Tile(1, 2), end: 'left', boardEnds: { left: 1, right: 2 } },
          { player: 'ai', tile: new D.Tile(2, 3), end: 'right', boardEnds: { left: 1, right: 3 } }
        ],
        expectedAggressor: 'ai',
        expectedWinner: 'ai', // AI pips: 7, Human pips: 11. 7 <= 11 → successful
        expectedType: 'successful_block'
      },
      {
        name: 'Direct block — Human is aggressor (last placer)',
        humanTiles: [[3, 4]],
        aiTiles: [[5, 6]],
        boardTiles: [[1, 2, 'left'], [2, 3, 'right']],
        // Board: left=1, right=3
        lastPlacer: 'human',
        moveHistory: [
          { player: 'ai', tile: new D.Tile(1, 2), end: 'left', boardEnds: { left: 1, right: 2 } },
          { player: 'human', tile: new D.Tile(2, 3), end: 'right', boardEnds: { left: 1, right: 3 } }
        ],
        expectedAggressor: 'human',
        expectedWinner: 'human', // Human pips: 7, AI pips: 11. 7 <= 11 → successful
        expectedType: 'successful_block'
      },
      {
        name: 'Failed block — aggressor has more pips',
        humanTiles: [[1, 1]],
        aiTiles: [[5, 6]],
        boardTiles: [[2, 3, 'left'], [3, 4, 'right']],
        // Board: left=2, right=4
        lastPlacer: 'ai',
        moveHistory: [
          { player: 'human', tile: new D.Tile(2, 3), end: 'left', boardEnds: { left: 2, right: 3 } },
          { player: 'ai', tile: new D.Tile(3, 4), end: 'right', boardEnds: { left: 2, right: 4 } }
        ],
        expectedAggressor: 'ai',
        expectedWinner: 'human', // AI pips: 11 > Human pips: 2 → failed
        expectedType: 'failed_block'
      },
      {
        name: 'Ghost 13 — [0|0] stuck + all 6 zero-suit tiles on board → 13 pips',
        humanTiles: [[0, 0]],
        aiTiles: [[1, 2]],
        boardTiles: [
          [0, 1, 'left'], [0, 2, 'left'], [1, 3, 'right'],
          [0, 3, 'right'], [0, 4, 'right'], [2, 5, 'left'],
          [0, 5, 'left'], [0, 6, 'left']
        ],
        // Board chain includes all 6 zero-suit tiles → Ghost 13 triggers
        // Final board: left=6, right=4. [0|0] can't play. AI [1|2] can't play.
        lastPlacer: 'ai',
        moveHistory: [
          { player: 'human', tile: new D.Tile(0, 5), end: 'left', boardEnds: { left: 0, right: 4 } },
          { player: 'ai', tile: new D.Tile(0, 6), end: 'left', boardEnds: { left: 6, right: 4 } }
        ],
        expectedAggressor: 'ai',
        expectedWinner: 'ai', // AI pips: 3, Human pips: 13 (ghost). 3 <= 13 → successful
        expectedType: 'successful_block'
      },
      {
        name: 'Ghost 13 — [0|0] stuck but NOT all zero-suit tiles on board → no ghost',
        humanTiles: [[0, 0]],
        aiTiles: [[1, 2]],
        boardTiles: [[3, 4, 'left'], [4, 5, 'right']],
        // Board: left=3, right=5. [0|0] can't play but zero-suit tiles NOT all on board
        // Ghost 13 does NOT trigger. Human pips: 0, AI pips: 3. AI is aggressor.
        // 3 > 0 → failed block, human wins
        lastPlacer: 'ai',
        moveHistory: [
          { player: 'human', tile: new D.Tile(3, 4), end: 'left', boardEnds: { left: 3, right: 4 } },
          { player: 'ai', tile: new D.Tile(4, 5), end: 'right', boardEnds: { left: 3, right: 5 } }
        ],
        expectedAggressor: 'ai',
        expectedWinner: 'human', // AI pips: 3 > Human pips: 0 (no ghost) → failed block
        expectedType: 'failed_block'
      }
    ];
  }

  // ============================================================
  // Performance Benchmark
  // ============================================================

  function perfBenchmark(numHands) {
    seedRng(12345);

    var engine = new D.GameEngine();
    engine.newMatch('hard');
    var hardAI = new D.AIPlayer('hard');

    var times = [];
    var leader = 'human';

    for (var h = 0; h < numHands; h++) {
      seededDeal(engine, leader);

      var moveCount = 0;
      var maxMoves = 100;

      try {
        while (moveCount < maxMoves) {
          var currentPlayer = engine.hand.currentPlayer;
          var legalMoves = engine.getLegalMoves(currentPlayer);

          if (legalMoves.length === 0) {
            var blockResult = engine.pass(currentPlayer);
            if (blockResult) {
              leader = blockResult.winner;
              engine.previousHandWinner = blockResult.winner;
              break;
            }
            continue;
          }

          var t0 = performance.now();
          var move = hardAI.chooseMove(legalMoves, engine);
          var elapsed = performance.now() - t0;
          times.push(elapsed);

          var result = engine.playTile(currentPlayer, move.tile, move.end);
          moveCount++;

          if (result.handEnd) {
            leader = result.handEnd.winner;
            engine.previousHandWinner = result.handEnd.winner;
            break;
          }
        }
      } catch (e) {
        log('  Benchmark hand ' + (h + 1) + ' crashed: ' + e.message, 'fail');
      }
    }

    return times;
  }

  // ============================================================
  // UI entry points (called from test.html buttons)
  // ============================================================

  window.runSelfPlay = function () {
    clearOutput();
    var numHands = parseInt(document.getElementById('num-hands').value) || 20;
    var seed = parseInt(document.getElementById('seed').value) || 42;

    log('=== Self-Play: ' + numHands + ' hands, seed=' + seed + ' ===', 'info');
    log('');

    var btn = document.getElementById('btn-selfplay');
    btn.disabled = true;

    // Run async to allow UI update
    setTimeout(function () {
      var stats = selfPlay(numHands, seed);

      log('');
      log('=== Results ===', 'info');
      log('  Player 1 (hard AI as human): ' + stats.ai1Wins + ' wins');
      log('  Player 2 (hard AI as ai):    ' + stats.ai2Wins + ' wins');
      log('  Dominos: ' + stats.dominos);
      log('  Successful blocks: ' + stats.successfulBlocks);
      log('  Failed blocks: ' + stats.failedBlocks);
      log('  Crashes: ' + stats.crashes, stats.crashes > 0 ? 'fail' : 'pass');
      log('  Total moves: ' + stats.totalMoves);
      log('  Total AI time: ' + stats.totalTime + 'ms');
      if (stats.totalMoves > 0) {
        log('  Avg time/move: ' + (stats.totalTime / stats.totalMoves).toFixed(1) + 'ms');
      }

      if (stats.crashes === 0) {
        log('', '');
        log('All hands completed without errors.', 'pass');
      }

      btn.disabled = false;
    }, 50);
  };

  window.runPuppeteerTests = function () {
    clearOutput();
    log('=== Puppeteer Scenario Tests ===', 'info');
    log('');

    var btn = document.getElementById('btn-puppeteer');
    btn.disabled = true;

    setTimeout(function () {
      var results = runPuppeteerScenarios();

      log('');
      log('=== Summary ===', 'info');
      log('  Passed: ' + results.passed, 'pass');
      if (results.failed > 0) {
        log('  Failed: ' + results.failed, 'fail');
      } else {
        log('  Failed: 0', 'pass');
      }

      btn.disabled = false;
    }, 50);
  };

  window.runPerfBenchmark = function () {
    clearOutput();
    var numHands = parseInt(document.getElementById('perf-hands').value) || 5;

    log('=== Performance Benchmark: ' + numHands + ' hands ===', 'info');
    log('');

    var btn = document.getElementById('btn-perf');
    btn.disabled = true;

    setTimeout(function () {
      var times = perfBenchmark(numHands);

      if (times.length === 0) {
        log('  No moves recorded.', 'warn');
        btn.disabled = false;
        return;
      }

      times.sort(function (a, b) { return a - b; });
      var total = 0;
      for (var i = 0; i < times.length; i++) total += times[i];
      var avg = total / times.length;
      var median = times[Math.floor(times.length / 2)];
      var p95 = times[Math.floor(times.length * 0.95)];
      var maxTime = times[times.length - 1];

      log('=== Results ===', 'info');
      log('  Total moves: ' + times.length);
      log('  Total time:  ' + total.toFixed(1) + 'ms');
      log('  Average:     ' + avg.toFixed(1) + 'ms');
      log('  Median:      ' + median.toFixed(1) + 'ms');
      log('  95th %ile:   ' + p95.toFixed(1) + 'ms', p95 > 500 ? 'warn' : 'pass');
      log('  Maximum:     ' + maxTime.toFixed(1) + 'ms', maxTime > 1000 ? 'warn' : 'pass');

      // Distribution
      var under50 = 0, under200 = 0, under500 = 0, over500 = 0;
      for (var i = 0; i < times.length; i++) {
        if (times[i] < 50) under50++;
        else if (times[i] < 200) under200++;
        else if (times[i] < 500) under500++;
        else over500++;
      }
      log('');
      log('  Distribution:');
      log('    < 50ms:   ' + under50 + ' (' + (under50 / times.length * 100).toFixed(0) + '%)');
      log('    50-200ms: ' + under200 + ' (' + (under200 / times.length * 100).toFixed(0) + '%)');
      log('    200-500ms: ' + under500 + ' (' + (under500 / times.length * 100).toFixed(0) + '%)');
      log('    > 500ms:  ' + over500 + ' (' + (over500 / times.length * 100).toFixed(0) + '%)',
          over500 > 0 ? 'warn' : 'pass');

      btn.disabled = false;
    }, 50);
  };

})();
