// ============================================================
// ui.js — DOM Rendering, Event Handling, Game Controller
// ============================================================

(function (D) {
  'use strict';

  // Pip position patterns for 3x3 grid (indices 0-8)
  // 0=TL 1=TC 2=TR 3=ML 4=MC 5=MR 6=BL 7=BC 8=BR
  var PIP_PATTERNS = {
    0: [],
    1: [4],
    2: [2, 6],
    3: [2, 4, 6],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8]
  };

  // --- DOM References ---
  var els = {};
  var engine = null;
  var ai = null;
  var aiWorker = null;
  var selectedTile = null;
  var selectedMoves = []; // legal moves for selected tile
  var difficulty = 'easy';
  var selectedEngine = 'new'; // 'old' or 'new'
  var openTiles = true;       // show AI tiles face-up
  var isProcessing = false;

  // --- History Navigation State ---
  var initialHumanTiles = null;  // Tile[] saved at deal time
  var initialAITiles = null;
  var viewIndex = -1;            // -1 = live, 0..N = viewing move N
  var isReviewing = false;

  function init() {
    els.humanScore = document.getElementById('human-score');
    els.aiScore = document.getElementById('ai-score');
    els.handNumber = document.getElementById('hand-number');
    els.aiHand = document.getElementById('ai-hand');
    els.aiTileCount = document.getElementById('ai-tile-count');
    els.humanHand = document.getElementById('human-hand');
    els.humanTileCount = document.getElementById('human-tile-count');
    els.statusMessage = document.getElementById('status-message');
    els.passBtn = document.getElementById('pass-btn');
    els.board = document.getElementById('board');
    els.boardLeftMarker = document.getElementById('board-left-marker');
    els.boardRightMarker = document.getElementById('board-right-marker');
    els.boardArea = document.getElementById('board-area');

    els.navBackward = document.getElementById('nav-backward');
    els.navForward = document.getElementById('nav-forward');

    els.startOverlay = document.getElementById('start-overlay');
    els.leaderOverlay = document.getElementById('leader-overlay');
    els.resultOverlay = document.getElementById('result-overlay');
    els.resultTitle = document.getElementById('result-title');
    els.resultBody = document.getElementById('result-body');
    els.matchOverlay = document.getElementById('match-overlay');
    els.matchTitle = document.getElementById('match-title');
    els.matchBody = document.getElementById('match-body');

    setupEventListeners();
    initWorker();
  }

  function initWorker() {
    if (typeof Worker !== 'undefined') {
      try {
        aiWorker = new Worker('./ai-worker.js');
      } catch (e) {
        aiWorker = null;
      }
    }
  }

  function setupEventListeners() {
    // Difficulty buttons
    var diffBtns = document.querySelectorAll('[data-difficulty]');
    for (var i = 0; i < diffBtns.length; i++) {
      diffBtns[i].addEventListener('click', function () {
        for (var j = 0; j < diffBtns.length; j++) diffBtns[j].classList.remove('active');
        this.classList.add('active');
        difficulty = this.getAttribute('data-difficulty');
      });
    }

    // Engine buttons
    var engineBtns = document.querySelectorAll('[data-engine]');
    for (var i = 0; i < engineBtns.length; i++) {
      engineBtns[i].addEventListener('click', function () {
        for (var j = 0; j < engineBtns.length; j++) engineBtns[j].classList.remove('active');
        this.classList.add('active');
        selectedEngine = this.getAttribute('data-engine');
      });
    }

    // Open tiles buttons
    var tileBtns = document.querySelectorAll('[data-opentiles]');
    for (var i = 0; i < tileBtns.length; i++) {
      tileBtns[i].addEventListener('click', function () {
        for (var j = 0; j < tileBtns.length; j++) tileBtns[j].classList.remove('active');
        this.classList.add('active');
        openTiles = this.getAttribute('data-opentiles') === 'open';
      });
    }

    // Start button
    document.getElementById('start-btn').addEventListener('click', onStartMatch);

    // Leader choice buttons
    var leaderBtns = document.querySelectorAll('[data-leader]');
    for (var i = 0; i < leaderBtns.length; i++) {
      leaderBtns[i].addEventListener('click', function () {
        onLeaderChosen(this.getAttribute('data-leader'));
      });
    }

    // Pass button
    els.passBtn.addEventListener('click', onPassClicked);

    // Board end markers
    els.boardLeftMarker.addEventListener('click', function () { onEndClicked('left'); });
    els.boardRightMarker.addEventListener('click', function () { onEndClicked('right'); });

    // History navigation
    els.navBackward.addEventListener('click', goBackward);
    els.navForward.addEventListener('click', goForward);

    // Play again (next-hand-btn onclick is set dynamically in showHandResult)
    document.getElementById('play-again-btn').addEventListener('click', onPlayAgain);
  }

  // ---- Start Screen ----
  function onStartMatch() {
    engine = new D.GameEngine();
    engine.newMatch(difficulty);
    if (selectedEngine === 'old') {
      ai = new D.OldAIPlayer(difficulty);
    } else {
      ai = new D.AIPlayer(difficulty);
    }

    els.startOverlay.style.display = 'none';
    showLeaderChoice();
  }

  function showLeaderChoice() {
    if (engine.previousHandWinner) {
      // Subsequent hand — previous winner leads
      startHand(engine.previousHandWinner);
    } else {
      els.leaderOverlay.style.display = 'flex';
    }
  }

  function onLeaderChosen(leader) {
    els.leaderOverlay.style.display = 'none';
    startHand(leader);
  }

  // ---- Hand Flow ----
  function startHand(leader) {
    engine.dealHand(leader);

    // Save initial hand state for history navigation
    initialHumanTiles = engine.hand.humanHand.tiles.slice();
    initialAITiles = engine.hand.aiHand.tiles.slice();
    viewIndex = -1;
    isReviewing = false;

    selectedTile = null;
    selectedMoves = [];
    isProcessing = false;

    updateScoreboard();
    renderAIHand();
    renderHumanHand();
    renderBoard();
    hideEndMarkers();
    updateNavButtons();

    if (leader === 'human') {
      startHumanTurn();
    } else {
      setStatus('AI is thinking...');
      disableHumanHand();
      setTimeout(function () { executeAITurn(); }, 500);
    }
  }

  function startHumanTurn() {
    selectedTile = null;
    selectedMoves = [];
    var legalMoves = engine.getLegalMoves('human');

    if (legalMoves.length === 0) {
      // Must pass
      setStatus('No legal moves — you must pass.');
      els.passBtn.style.display = 'inline-block';
      disableHumanHand();
      hideEndMarkers();
      return;
    }

    els.passBtn.style.display = 'none';
    setStatus('Your turn — select a tile to play.');
    renderHumanHand();
    updateNavButtons();
  }

  function onTileClicked(tile) {
    if (isProcessing || isReviewing) return;
    var legalMoves = engine.getLegalMoves('human');

    // Find moves for this tile
    var tileMoves = legalMoves.filter(function (m) { return m.tile === tile; });

    if (tileMoves.length === 0) return;

    if (selectedTile === tile) {
      // Deselect
      selectedTile = null;
      selectedMoves = [];
      renderHumanHand();
      hideEndMarkers();
      setStatus('Your turn — select a tile to play.');
      return;
    }

    selectedTile = tile;
    selectedMoves = tileMoves;
    renderHumanHand();

    if (engine.hand.board.isEmpty()) {
      // First play — place directly
      onEndClicked('left');
      return;
    }

    if (tileMoves.length === 1) {
      // Only one end possible — auto-place
      onEndClicked(tileMoves[0].end);
    } else {
      // Show both end markers
      showEndMarkers(tileMoves);
      setStatus('Choose which end to play on.');
    }
  }

  function onEndClicked(end) {
    if (!selectedTile || isProcessing || isReviewing) return;

    // Validate the move
    var move = null;
    for (var i = 0; i < selectedMoves.length; i++) {
      if (selectedMoves[i].end === end) {
        move = selectedMoves[i];
        break;
      }
    }
    if (!move) return;

    isProcessing = true;
    hideEndMarkers();

    var result = engine.playTile('human', move.tile, move.end);
    selectedTile = null;
    selectedMoves = [];

    renderBoard();
    renderHumanHand();
    renderAIHand();
    updateScoreboard();

    if (result.handEnd) {
      showHandResult(result.handEnd);
      return;
    }

    // AI's turn
    setStatus('AI is thinking...');
    disableHumanHand();
    updateNavButtons();
    setTimeout(function () { executeAITurn(); }, 500);
  }

  function onPassClicked() {
    if (isProcessing || isReviewing) return;
    isProcessing = true;
    els.passBtn.style.display = 'none';

    var blockResult = engine.pass('human');

    if (blockResult) {
      showHandResult(blockResult);
      return;
    }

    setStatus('AI is thinking...');
    disableHumanHand();
    setTimeout(function () { executeAITurn(); }, 500);
  }

  function applyAIMove(move, elapsed) {
    if (openTiles) {
      // Animate the tile flying from AI hand to board
      animateAITile(move, function () {
        finishAIMove(move, elapsed);
      });
    } else {
      finishAIMove(move, elapsed);
    }
  }

  function finishAIMove(move, elapsed) {
    var result = engine.playTile('ai', move.tile, move.end);

    setStatus('AI plays ' + move.tile.toString() + '.');
    renderBoard();
    renderAIHand();
    renderHumanHand();
    updateScoreboard();

    // Adaptive post-play delay: if minimax took a while, reduce the
    // pause so total feel stays consistent (~600ms visible after play)
    var postDelay = Math.max(300, 600 - elapsed);

    if (result.handEnd) {
      setTimeout(function () { showHandResult(result.handEnd); }, postDelay);
      return;
    }

    setTimeout(function () {
      isProcessing = false;
      startHumanTurn();
    }, postDelay);
  }

  // Animate an AI tile flying from the AI hand area to the board
  function animateAITile(move, callback) {
    var tileId = move.tile.id;
    var sourceEl = els.aiHand.querySelector('[data-tile-id="' + tileId + '"]');

    if (!sourceEl) {
      // Fallback: no source element found (hidden mode), skip animation
      callback();
      return;
    }

    // Get source position
    var sourceRect = sourceEl.getBoundingClientRect();

    // Find target: the left or right end of the board
    var boardRect = els.boardArea.getBoundingClientRect();
    var targetRect;

    // Create flying clone
    var clone = sourceEl.cloneNode(true);
    clone.className = sourceEl.className;
    clone.classList.remove('tile--ai-open');
    clone.classList.add('tile--flying');
    clone.style.left = sourceRect.left + 'px';
    clone.style.top = sourceRect.top + 'px';
    clone.style.width = sourceRect.width + 'px';
    clone.style.height = sourceRect.height + 'px';
    document.body.appendChild(clone);

    // Ghost the original tile
    sourceEl.classList.add('tile--ghost');

    // Compute target: fly to the correct end of the board
    var boardTiles = els.board.children;
    if (boardTiles.length > 0 && move.end === 'left') {
      targetRect = boardTiles[0].getBoundingClientRect();
    } else if (boardTiles.length > 0 && move.end === 'right') {
      targetRect = boardTiles[boardTiles.length - 1].getBoundingClientRect();
    } else {
      targetRect = boardRect;
    }
    var targetX = targetRect.left + targetRect.width / 2 - sourceRect.width / 2;
    var targetY = targetRect.top + targetRect.height / 2 - sourceRect.height / 2;

    // Trigger animation in next frame
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        clone.style.left = targetX + 'px';
        clone.style.top = targetY + 'px';
        clone.style.transform = 'scale(1.1)';
      });
    });

    // Guard against double-fire (transitionend + safety timeout)
    var animDone = false;
    function onAnimComplete() {
      if (animDone) return;
      animDone = true;
      if (clone.parentNode) clone.parentNode.removeChild(clone);
      callback();
    }

    // Clean up after animation
    clone.addEventListener('transitionend', function onEnd(e) {
      if (e.target !== clone) return; // ignore child transitions
      clone.removeEventListener('transitionend', onEnd);
      onAnimComplete();
    });

    // Safety fallback in case transitionend doesn't fire
    setTimeout(onAnimComplete, 700);
  }

  function executeAITurn() {
    var legalMoves = engine.getLegalMoves('ai');

    if (legalMoves.length === 0) {
      // AI passes
      setStatus('AI has no legal moves — AI passes.');
      var blockResult = engine.pass('ai');

      if (blockResult) {
        setTimeout(function () { showHandResult(blockResult); }, 800);
        return;
      }

      setTimeout(function () {
        isProcessing = false;
        startHumanTurn();
      }, 800);
      return;
    }

    // Hard mode with Web Worker available → async off-main-thread (bitboard engine only)
    if (difficulty === 'hard' && aiWorker && selectedEngine === 'new') {
      var t0 = Date.now();

      // Serialize state for the worker
      var hand = engine.hand;
      var board = hand.board;
      var msg = {
        aiTiles: hand.aiHand.tiles.map(function (t) { return { low: t.low, high: t.high }; }),
        humanTiles: hand.humanHand.tiles.map(function (t) { return { low: t.low, high: t.high }; }),
        left: board.isEmpty() ? null : board.leftEnd,
        right: board.isEmpty() ? null : board.rightEnd,
        boardEmpty: board.isEmpty(),
        moveHistory: hand.moveHistory.map(function (m) {
          return {
            player: m.player,
            tileLow: m.tile ? m.tile.low : null,
            tileHigh: m.tile ? m.tile.high : null,
            end: m.end,
            pass: !!m.pass,
            boardLeft: m.boardEnds ? m.boardEnds.left : null,
            boardRight: m.boardEnds ? m.boardEnds.right : null
          };
        }),
        legalMoves: legalMoves.map(function (m) {
          return { tileLow: m.tile.low, tileHigh: m.tile.high, end: m.end };
        })
      };

      aiWorker.onmessage = function (e) {
        var elapsed = Date.now() - t0;
        var result = e.data;

        // Map result back to a legalMove
        var tileId = result.tileId;
        var end = result.end;
        var move = null;
        for (var i = 0; i < legalMoves.length; i++) {
          if (legalMoves[i].tile.id === tileId && legalMoves[i].end === end) {
            move = legalMoves[i];
            break;
          }
        }
        if (!move) {
          // Fallback: match by tile only
          for (var i = 0; i < legalMoves.length; i++) {
            if (legalMoves[i].tile.id === tileId) { move = legalMoves[i]; break; }
          }
        }
        if (!move) move = legalMoves[0];

        applyAIMove(move, elapsed);
      };

      aiWorker.onerror = function () {
        // Fallback to synchronous on worker error
        var move = ai.chooseMove(legalMoves, engine);
        var elapsed = Date.now() - t0;
        applyAIMove(move, elapsed);
      };

      aiWorker.postMessage(msg);
      return;
    }

    // Synchronous path: easy mode or no Worker support
    var t0 = Date.now();
    var move = ai.chooseMove(legalMoves, engine);
    var elapsed = Date.now() - t0;
    applyAIMove(move, elapsed);
  }

  // ---- Hand/Match Result ----
  function showHandResult(result) {
    isProcessing = false;
    isReviewing = false;
    viewIndex = -1;
    els.statusMessage.classList.remove('reviewing');
    els.navBackward.style.display = 'none';
    els.navForward.style.display = 'none';

    // Reveal AI's remaining tiles
    renderAIHandRevealed();

    var title = '';
    var body = '';

    if (result.type === 'domino') {
      var winnerLabel = result.winner === 'human' ? 'You' : 'AI';
      title = winnerLabel + ' Domino!';
      body = '<div class="result-line">' + winnerLabel + ' played all tiles.</div>';
      body += '<div class="result-line">Points awarded: <span class="result-highlight">+' + result.points + '</span></div>';
      if (result.ghost13 && result.ghost13.triggered) {
        var ghostHolder = result.ghost13.player === 'human' ? 'Your' : "AI's";
        body += '<div class="result-line result-ghost">Ghost 13: ' + ghostHolder + ' [0|0] counts as 13 pips!</div>';
      }
    } else if (result.type === 'successful_block') {
      var aggressorLabel = result.aggressor === 'human' ? 'You' : 'AI';
      var winnerLabel = result.winner === 'human' ? 'You' : 'AI';
      title = 'Successful Block!';
      body = '<div class="result-line">Board is locked. Aggressor: <span class="result-highlight">' + aggressorLabel + '</span></div>';
      body += '<div class="result-line">' + aggressorLabel + '\'s pips: ' + result.aggressorPips + ' | Opponent\'s pips: ' + result.opponentPips + '</div>';
      body += '<div class="result-line">' + winnerLabel + ' win' + (result.winner === 'human' ? '' : 's') + '! Points: <span class="result-highlight">+' + result.points + '</span> (opponent pips x2)</div>';
      body += addGhost13Lines(result);
    } else if (result.type === 'failed_block') {
      var aggressorLabel = result.aggressor === 'human' ? 'You' : 'AI';
      var winnerLabel = result.winner === 'human' ? 'You' : 'AI';
      title = 'Failed Block!';
      body = '<div class="result-line">Board is locked. Aggressor: <span class="result-highlight">' + aggressorLabel + '</span></div>';
      body += '<div class="result-line">' + aggressorLabel + '\'s pips: ' + result.aggressorPips + ' | Opponent\'s pips: ' + result.opponentPips + '</div>';
      body += '<div class="result-line">' + winnerLabel + ' win' + (result.winner === 'human' ? '' : 's') + '! Points: <span class="result-highlight">+' + result.points + '</span> (all remaining pips)</div>';
      body += addGhost13Lines(result);
    }

    // Show updated score
    body += '<div class="result-line" style="margin-top:12px;opacity:0.8;">Score — You: ' + engine.matchScore.human + ' | AI: ' + engine.matchScore.ai + '</div>';

    els.resultTitle.textContent = title;
    els.resultBody.innerHTML = body;

    // Check if match is over
    var matchWinner = engine.checkMatchEnd();
    if (matchWinner) {
      document.getElementById('next-hand-btn').textContent = 'See Results';
      document.getElementById('next-hand-btn').onclick = function () {
        els.resultOverlay.style.display = 'none';
        showMatchResult(matchWinner);
      };
    } else {
      document.getElementById('next-hand-btn').textContent = 'Next Hand';
      document.getElementById('next-hand-btn').onclick = onNextHand;
    }

    els.resultOverlay.style.display = 'flex';
  }

  function addGhost13Lines(result) {
    var body = '';
    if (result.ghost13Human && result.ghost13Human.triggered) {
      body += '<div class="result-line result-ghost">Ghost 13: Your [0|0] counts as 13 pips!</div>';
    }
    if (result.ghost13AI && result.ghost13AI.triggered) {
      body += '<div class="result-line result-ghost">Ghost 13: AI\'s [0|0] counts as 13 pips!</div>';
    }
    return body;
  }

  function showMatchResult(winner) {
    var winnerLabel = winner === 'human' ? 'You Win!' : 'AI Wins!';
    els.matchTitle.textContent = winnerLabel;
    els.matchBody.innerHTML =
      '<div style="font-size:1.1rem;text-align:center;margin-bottom:8px;">Final Score</div>' +
      '<div style="text-align:center;font-size:1.4rem;font-weight:700;color:#f0d060;">You: ' +
      engine.matchScore.human + ' &mdash; AI: ' + engine.matchScore.ai + '</div>' +
      '<div style="text-align:center;margin-top:8px;opacity:0.7;">Hands played: ' + engine.handNumber + '</div>';
    els.matchOverlay.style.display = 'flex';
  }

  function onNextHand() {
    els.resultOverlay.style.display = 'none';
    showLeaderChoice();
  }

  function onPlayAgain() {
    els.matchOverlay.style.display = 'none';
    els.startOverlay.style.display = 'flex';
  }

  // ---- Rendering ----

  function createTileElement(tile, isVertical) {
    var el = document.createElement('div');
    el.className = 'tile ' + (isVertical ? 'tile--vertical' : 'tile--horizontal');

    var leftVal = isVertical ? tile.high : tile.low;
    var rightVal = isVertical ? tile.low : tile.high;

    el.appendChild(createHalfElement(leftVal));
    el.appendChild(createHalfElement(rightVal));
    return el;
  }

  // ---- Board tile creation ----
  function createBoardTileElement(placement) {
    var tile = placement.tile;
    var isVertical = tile.isDouble();
    var el = document.createElement('div');
    el.className = 'tile tile--board tile--placed ' + (isVertical ? 'tile--vertical' : 'tile--horizontal');

    if (isVertical) {
      el.appendChild(createHalfElement(tile.high));
      el.appendChild(createHalfElement(tile.low));
    } else {
      if (placement.flipped) {
        el.appendChild(createHalfElement(tile.high));
        el.appendChild(createHalfElement(tile.low));
      } else {
        el.appendChild(createHalfElement(tile.low));
        el.appendChild(createHalfElement(tile.high));
      }
    }

    return el;
  }

  function createHalfElement(value) {
    var half = document.createElement('div');
    half.className = 'tile-half';
    var positions = PIP_PATTERNS[value] || [];

    for (var i = 0; i < 9; i++) {
      var pip = document.createElement('div');
      if (positions.indexOf(i) !== -1) {
        pip.className = 'pip';
      } else {
        pip.className = 'pip pip--hidden';
      }
      half.appendChild(pip);
    }
    return half;
  }

  function createBackTile() {
    var el = document.createElement('div');
    el.className = 'tile tile--back';
    return el;
  }

  // ============================================================
  // Render Board — simple horizontal row
  // ============================================================
  function renderBoard() {
    els.board.innerHTML = '';
    var boardTiles = engine.hand.board.tiles;
    if (boardTiles.length === 0) return;

    for (var i = 0; i < boardTiles.length; i++) {
      els.board.appendChild(createBoardTileElement(boardTiles[i]));
    }

    els.boardArea.scrollLeft = els.boardArea.scrollWidth;
  }

  function renderHumanHand() {
    els.humanHand.innerHTML = '';
    var tiles = engine.hand.humanHand.tiles;
    var legalMoves = engine.getLegalMoves('human');

    // Find which tiles have legal moves
    var playableTileIds = {};
    for (var i = 0; i < legalMoves.length; i++) {
      playableTileIds[legalMoves[i].tile.id] = true;
    }

    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      var el = createTileElement(tile, false);
      var isPlayable = !!playableTileIds[tile.id];

      if (isPlayable && !isProcessing) {
        el.classList.add('tile--playable');
      } else if (!isPlayable) {
        el.classList.add('tile--disabled');
      }

      if (selectedTile === tile) {
        el.classList.add('tile--selected');
      }

      (function (t) {
        el.addEventListener('click', function () { onTileClicked(t); });
      })(tile);

      els.humanHand.appendChild(el);
    }

    els.humanTileCount.textContent = '(' + tiles.length + ')';
  }

  function disableHumanHand() {
    var tileEls = els.humanHand.querySelectorAll('.tile');
    for (var i = 0; i < tileEls.length; i++) {
      tileEls[i].classList.remove('tile--playable');
      tileEls[i].classList.add('tile--disabled');
    }
  }

  function renderAIHand() {
    els.aiHand.innerHTML = '';
    if (openTiles) {
      // Show AI tiles face-up
      var tiles = engine.hand.aiHand.tiles;
      for (var i = 0; i < tiles.length; i++) {
        var el = createTileElement(tiles[i], false);
        el.classList.add('tile--board');
        el.classList.add('tile--ai-open');
        el.setAttribute('data-tile-id', tiles[i].id);
        els.aiHand.appendChild(el);
      }
      els.aiTileCount.textContent = '(' + tiles.length + ')';
    } else {
      // Face-down back tiles
      var count = engine.hand.aiHand.count();
      for (var i = 0; i < count; i++) {
        els.aiHand.appendChild(createBackTile());
      }
      els.aiTileCount.textContent = '(' + count + ')';
    }
  }

  function renderAIHandRevealed() {
    els.aiHand.innerHTML = '';
    var tiles = engine.hand.aiHand.tiles;
    for (var i = 0; i < tiles.length; i++) {
      var el = createTileElement(tiles[i], false);
      el.classList.add('tile--board');
      els.aiHand.appendChild(el);
    }
    els.aiTileCount.textContent = '(' + tiles.length + ')';
  }

  function showEndMarkers(moves) {
    var hasLeft = false, hasRight = false;
    for (var i = 0; i < moves.length; i++) {
      if (moves[i].end === 'left') hasLeft = true;
      if (moves[i].end === 'right') hasRight = true;
    }
    els.boardLeftMarker.style.display = hasLeft ? 'flex' : 'none';
    els.boardRightMarker.style.display = hasRight ? 'flex' : 'none';
    if (hasLeft) els.boardLeftMarker.classList.add('glow');
    if (hasRight) els.boardRightMarker.classList.add('glow');
  }

  function hideEndMarkers() {
    els.boardLeftMarker.style.display = 'none';
    els.boardRightMarker.style.display = 'none';
    els.boardLeftMarker.classList.remove('glow');
    els.boardRightMarker.classList.remove('glow');
  }

  // ============================================================
  // History Navigation — backward / forward through moves
  // ============================================================

  /**
   * Reconstruct game state at the given move index.
   * moveIndex = -1 → before any moves (initial deal, empty board)
   * moveIndex = 0 → after the first move
   * moveIndex = N → after move N (0-indexed into moveHistory)
   */
  function reconstructStateAt(moveIndex) {
    var board = new D.Board();
    var humanTiles = initialHumanTiles.slice();
    var aiTiles = initialAITiles.slice();

    var history = engine.hand.moveHistory;
    var end = Math.min(moveIndex, history.length - 1);

    for (var i = 0; i <= end; i++) {
      var move = history[i];
      if (move.pass) continue;

      board.place(move.tile, move.end);

      if (move.player === 'human') {
        var idx = humanTiles.indexOf(move.tile);
        if (idx !== -1) humanTiles.splice(idx, 1);
      } else {
        var idx = aiTiles.indexOf(move.tile);
        if (idx !== -1) aiTiles.splice(idx, 1);
      }
    }

    return { board: board, humanTiles: humanTiles, aiTiles: aiTiles };
  }

  function goBackward() {
    if (!engine || !engine.hand) return;
    if (isProcessing) return;

    var historyLen = engine.hand.moveHistory.length;
    if (historyLen === 0) return;

    if (viewIndex === -1) {
      // Currently live — go to one before the last move
      viewIndex = historyLen - 2;
    } else {
      viewIndex--;
    }

    if (viewIndex < -1) viewIndex = -1;

    enterReviewMode();
  }

  function goForward() {
    if (!engine || !engine.hand) return;

    var historyLen = engine.hand.moveHistory.length;

    if (viewIndex === -1 && !isReviewing) return;

    viewIndex++;

    if (viewIndex >= historyLen - 1) {
      exitReviewMode();
      return;
    }

    enterReviewMode();
  }

  function enterReviewMode() {
    isReviewing = true;

    var state = reconstructStateAt(viewIndex);

    renderBoardFromState(state.board);
    renderHumanHandFromState(state.humanTiles);
    renderAIHandFromState(state.aiTiles);

    var historyLen = engine.hand.moveHistory.length;
    if (viewIndex === -1) {
      setStatus('Reviewing: Initial deal');
    } else {
      var move = engine.hand.moveHistory[viewIndex];
      var who = move.player === 'human' ? 'You' : 'AI';
      if (move.pass) {
        setStatus('Move ' + (viewIndex + 1) + '/' + historyLen + ': ' + who + ' passed');
      } else {
        setStatus('Move ' + (viewIndex + 1) + '/' + historyLen + ': ' + who + ' played ' + move.tile.toString());
      }
    }

    els.statusMessage.classList.add('reviewing');
    els.passBtn.style.display = 'none';
    hideEndMarkers();
    updateNavButtons();
  }

  function exitReviewMode() {
    viewIndex = -1;
    isReviewing = false;
    els.statusMessage.classList.remove('reviewing');

    renderBoard();
    renderHumanHand();
    renderAIHand();
    updateNavButtons();

    if (engine.hand.currentPlayer === 'human') {
      startHumanTurn();
    } else {
      setStatus('AI is thinking...');
    }
  }

  function updateNavButtons() {
    if (!els.navBackward || !els.navForward) return;

    if (!engine || !engine.hand || engine.hand.moveHistory.length === 0) {
      els.navBackward.style.display = 'none';
      els.navForward.style.display = 'none';
      return;
    }

    els.navBackward.style.display = 'inline-block';
    els.navForward.style.display = 'inline-block';

    // Backward: disabled at initial deal while reviewing, or during AI thinking
    if ((isReviewing && viewIndex <= -1) || isProcessing) {
      els.navBackward.disabled = true;
    } else {
      els.navBackward.disabled = false;
    }

    // Forward: disabled if at live state (not reviewing)
    if (!isReviewing) {
      els.navForward.disabled = true;
    } else {
      els.navForward.disabled = false;
    }
  }

  // --- Read-only render functions for review mode ---

  function renderBoardFromState(board) {
    els.board.innerHTML = '';
    var boardTiles = board.tiles;
    if (boardTiles.length === 0) return;

    for (var i = 0; i < boardTiles.length; i++) {
      els.board.appendChild(createBoardTileElement(boardTiles[i]));
    }

    els.boardArea.scrollLeft = els.boardArea.scrollWidth;
  }

  function renderHumanHandFromState(tiles) {
    els.humanHand.innerHTML = '';

    for (var i = 0; i < tiles.length; i++) {
      var el = createTileElement(tiles[i], false);
      el.classList.add('tile--disabled');
      els.humanHand.appendChild(el);
    }

    els.humanTileCount.textContent = '(' + tiles.length + ')';
  }

  function renderAIHandFromState(tiles) {
    els.aiHand.innerHTML = '';

    if (openTiles) {
      for (var i = 0; i < tiles.length; i++) {
        var el = createTileElement(tiles[i], false);
        el.classList.add('tile--board');
        el.classList.add('tile--ai-open');
        els.aiHand.appendChild(el);
      }
    } else {
      for (var i = 0; i < tiles.length; i++) {
        els.aiHand.appendChild(createBackTile());
      }
    }

    els.aiTileCount.textContent = '(' + tiles.length + ')';
  }

  function updateScoreboard() {
    els.humanScore.textContent = engine.matchScore.human;
    els.aiScore.textContent = engine.matchScore.ai;
    els.handNumber.textContent = '#' + engine.handNumber;
  }

  function setStatus(msg) {
    els.statusMessage.textContent = msg;
  }

  // ---- Init on DOM load ----
  document.addEventListener('DOMContentLoaded', init);

})(window.Domino);
