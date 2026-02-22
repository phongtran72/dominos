// ============================================================
// ui-board.js — Snake/Chain Board UI (fork of ui.js)
// Renders domino tiles in a 2D serpentine chain layout
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

  // Direction constants
  var DIR_RIGHT = 0;
  var DIR_DOWN  = 1;
  var DIR_LEFT  = 2;
  var DIR_UP    = 3;

  // --- DOM References ---
  var els = {};
  var engine = null;
  var ai = null;
  var aiWorker = null;
  var selectedTile = null;
  var selectedMoves = []; // legal moves for selected tile
  var difficulty = 'hard';
  var selectedEngine = 'new'; // 'old' or 'new'
  var openTiles = true;       // show AI tiles face-up
  var isProcessing = false;

  // --- History Navigation State ---
  var initialHumanTiles = null;
  var initialAITiles = null;
  var viewIndex = -1;
  var isReviewing = false;
  var handOver = false;
  var handResult = null;
  var lastAIAnalysis = null;

  // --- Snake Layout State ---
  var currentLayout = [];     // cached layout for end marker positioning
  var currentBounds = null;   // bounding box of current layout

  // --- Deal Save/Replay System ---
  var SAVE_KEY = 'dominos-deals';
  var matchDeals = [];
  var replayDeals = null;
  var replayHandIndex = 0;

  function loadAllDeals() {
    try {
      var json = localStorage.getItem(SAVE_KEY);
      if (!json) return [null, null, null];
      var arr = JSON.parse(json);
      if (!Array.isArray(arr)) return [null, null, null];
      while (arr.length < 3) arr.push(null);
      return arr.slice(0, 3);
    } catch (e) {
      return [null, null, null];
    }
  }

  function saveAllDeals(slots) {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(slots));
    } catch (e) { }
  }

  function saveDealToSlot(index) {
    var slots = loadAllDeals();
    slots[index] = {
      version: 1,
      savedAt: Date.now(),
      difficulty: difficulty,
      selectedEngine: selectedEngine,
      openTiles: openTiles,
      hands: matchDeals.slice(),
      finalScore: { human: engine.matchScore.human, ai: engine.matchScore.ai },
      handCount: engine.handNumber
    };
    saveAllDeals(slots);
  }

  function deleteSlot(index) {
    var slots = loadAllDeals();
    slots[index] = null;
    saveAllDeals(slots);
  }

  function renderSavedDeals() {
    if (!els.savedDeals || !els.savedDealsList) return;
    var slots = loadAllDeals();
    var hasAny = false;
    els.savedDealsList.innerHTML = '';

    for (var i = 0; i < 3; i++) {
      if (!slots[i]) continue;
      hasAny = true;
      var s = slots[i];
      var date = new Date(s.savedAt);
      var dateStr = date.toLocaleDateString();

      var row = document.createElement('div');
      row.className = 'saved-deal';

      var info = document.createElement('div');
      info.className = 'saved-deal-info';
      info.innerHTML = '<div class="saved-deal-score">You ' + s.finalScore.human +
        ' — AI ' + s.finalScore.ai + '</div>' +
        '<div class="saved-deal-meta">' + s.handCount + ' hands · ' +
        s.difficulty + ' · ' + dateStr + '</div>';

      var actions = document.createElement('div');
      actions.className = 'saved-deal-actions';

      var replayBtn = document.createElement('button');
      replayBtn.className = 'btn btn-option';
      replayBtn.textContent = 'Replay';
      (function (idx) {
        replayBtn.addEventListener('click', function () { onReplayDeal(idx); });
      })(i);

      var delBtn = document.createElement('button');
      delBtn.className = 'btn btn-option btn-del';
      delBtn.textContent = 'X';
      (function (idx) {
        delBtn.addEventListener('click', function () { onDeleteDeal(idx); });
      })(i);

      actions.appendChild(replayBtn);
      actions.appendChild(delBtn);
      row.appendChild(info);
      row.appendChild(actions);
      els.savedDealsList.appendChild(row);
    }

    els.savedDeals.style.display = hasAny ? 'block' : 'none';
  }

  function renderSaveSlots() {
    if (!els.saveSlots) return;
    var slots = loadAllDeals();
    els.saveSlots.innerHTML = '';

    for (var i = 0; i < 3; i++) {
      var row = document.createElement('div');
      row.className = 'save-slot' + (slots[i] ? '' : ' save-slot--empty');

      var info = document.createElement('div');
      info.className = 'saved-deal-info';
      if (slots[i]) {
        var s = slots[i];
        var date = new Date(s.savedAt);
        info.innerHTML = '<div class="saved-deal-score">You ' + s.finalScore.human +
          ' — AI ' + s.finalScore.ai + '</div>' +
          '<div class="saved-deal-meta">' + s.handCount + ' hands · ' + date.toLocaleDateString() + '</div>';
      } else {
        info.innerHTML = '<div class="saved-deal-score">Empty Slot</div>';
      }

      var btn = document.createElement('button');
      btn.className = 'btn btn-option';
      btn.textContent = slots[i] ? 'Overwrite' : 'Save Here';
      (function (idx) {
        btn.addEventListener('click', function () { onSaveToSlot(idx); });
      })(i);

      row.appendChild(info);
      row.appendChild(btn);
      els.saveSlots.appendChild(row);
    }
  }

  function showSavePrompt() {
    renderSaveSlots();
    els.saveOverlay.style.display = 'flex';
  }

  function onSaveToSlot(index) {
    saveDealToSlot(index);
    els.saveOverlay.style.display = 'none';
    els.startOverlay.style.display = 'flex';
    renderSavedDeals();
  }

  function onSkipSave() {
    els.saveOverlay.style.display = 'none';
    els.startOverlay.style.display = 'flex';
    renderSavedDeals();
  }

  function onReplayDeal(index) {
    var slots = loadAllDeals();
    var deal = slots[index];
    if (!deal) return;

    difficulty = deal.difficulty;
    selectedEngine = deal.selectedEngine;
    openTiles = deal.openTiles;

    replayDeals = deal;
    replayHandIndex = 0;
    matchDeals = [];

    engine = new D.GameEngine();
    engine.newMatch(difficulty);
    if (selectedEngine === 'old') {
      ai = new D.OldAIPlayer(difficulty);
    } else {
      ai = new D.AIPlayer(difficulty);
    }

    els.startOverlay.style.display = 'none';

    if (replayDeals.hands.length > 0) {
      startHand(replayDeals.hands[0].leader);
    } else {
      showLeaderChoice();
    }
  }

  function onDeleteDeal(index) {
    deleteSlot(index);
    renderSavedDeals();
  }

  // ============================================================
  // Init
  // ============================================================
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

    els.evalFill = document.getElementById('eval-fill');
    els.evalLabel = document.getElementById('eval-label');
    els.analysisPanel = document.getElementById('analysis-panel');
    els.analysisList = document.getElementById('analysis-list');

    els.undoBtn = document.getElementById('undo-btn');

    els.startOverlay = document.getElementById('start-overlay');
    els.leaderOverlay = document.getElementById('leader-overlay');
    els.resultOverlay = document.getElementById('result-overlay');
    els.resultTitle = document.getElementById('result-title');
    els.resultBody = document.getElementById('result-body');
    els.matchOverlay = document.getElementById('match-overlay');
    els.matchTitle = document.getElementById('match-title');
    els.matchBody = document.getElementById('match-body');

    els.savedDeals = document.getElementById('saved-deals');
    els.savedDealsList = document.getElementById('saved-deals-list');
    els.saveOverlay = document.getElementById('save-overlay');
    els.saveSlots = document.getElementById('save-slots');
    els.saveSkipBtn = document.getElementById('save-skip-btn');

    // Move end markers inside #board for absolute positioning
    els.board.appendChild(els.boardLeftMarker);
    els.board.appendChild(els.boardRightMarker);

    setupEventListeners();
    initWorker();
    renderSavedDeals();

    // Recompute layout on resize
    if (typeof ResizeObserver !== 'undefined') {
      var ro = new ResizeObserver(function () {
        if (engine && engine.hand && !isReviewing) {
          renderBoard();
        }
      });
      ro.observe(els.boardArea);
    }
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

    // Board style toggle
    var styleBtns = document.querySelectorAll('[data-boardstyle]');
    for (var i = 0; i < styleBtns.length; i++) {
      styleBtns[i].addEventListener('click', function () {
        for (var j = 0; j < styleBtns.length; j++) styleBtns[j].classList.remove('active');
        this.classList.add('active');
        var newStyle = this.getAttribute('data-boardstyle');
        localStorage.setItem('dominos-boardstyle', newStyle);
        location.reload();
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

    // Undo button
    els.undoBtn.addEventListener('click', onUndo);

    // History navigation
    els.navBackward.addEventListener('click', goBackward);
    els.navForward.addEventListener('click', goForward);

    // Review buttons
    document.getElementById('review-hand-btn').addEventListener('click', onReviewHand);
    document.getElementById('review-match-btn').addEventListener('click', onReviewMatch);

    // Play again
    document.getElementById('play-again-btn').addEventListener('click', onPlayAgain);
    document.getElementById('new-game-btn').addEventListener('click', onNewGame);

    // Save prompt
    document.getElementById('save-skip-btn').addEventListener('click', onSkipSave);

    // Highlight active board style button
    var currentStyle = localStorage.getItem('dominos-boardstyle') || 'snake';
    for (var i = 0; i < styleBtns.length; i++) {
      if (styleBtns[i].getAttribute('data-boardstyle') === currentStyle) {
        styleBtns[i].classList.add('active');
      } else {
        styleBtns[i].classList.remove('active');
      }
    }
  }

  // ---- Start Screen ----
  function onStartMatch() {
    matchDeals = [];
    replayDeals = null;
    replayHandIndex = 0;
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
    if (replayDeals && replayHandIndex < replayDeals.hands.length) {
      startHand(replayDeals.hands[replayHandIndex].leader);
    } else if (engine.previousHandWinner) {
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
    if (replayDeals && replayHandIndex < replayDeals.hands.length) {
      var deal = replayDeals.hands[replayHandIndex];
      engine.dealHandFromTiles(deal.leader, deal.humanTiles, deal.aiTiles);
      leader = deal.leader;
      replayHandIndex++;
    } else {
      engine.dealHand(leader);
    }

    matchDeals.push({
      leader: leader,
      humanTiles: engine.hand.humanHand.tiles.map(function (t) { return { low: t.low, high: t.high }; }),
      aiTiles: engine.hand.aiHand.tiles.map(function (t) { return { low: t.low, high: t.high }; })
    });

    initialHumanTiles = engine.hand.humanHand.tiles.slice();
    initialAITiles = engine.hand.aiHand.tiles.slice();
    viewIndex = -1;
    isReviewing = false;
    handOver = false;
    handResult = null;
    lastAIAnalysis = null;

    selectedTile = null;
    selectedMoves = [];
    isProcessing = false;

    updateEvalBar(0);
    clearAnalysis();
    updateScoreboard();
    renderAIHand();
    renderHumanHand();
    renderBoard();
    hideEndMarkers();
    updateNavButtons();
    updateUndoButton();

    if (leader === 'human') {
      startHumanTurn();
    } else {
      setStatus('AI is thinking...');
      disableHumanHand();
      setTimeout(function () { executeAITurn(); }, 500);
    }
  }

  // ---- Undo ----
  function canUndo() {
    if (!engine || !engine.hand) return false;
    if (isProcessing) return false;
    if (handOver) return false;
    var history = engine.hand.moveHistory;
    for (var i = 0; i < history.length; i++) {
      if (history[i].player === 'human') return true;
    }
    return false;
  }

  function onUndo() {
    if (isProcessing) return;

    if (isReviewing) {
      undoFromReview();
      return;
    }

    if (!canUndo()) return;

    var history = engine.hand.moveHistory;
    var undoneHumanMove = false;
    while (history.length > 0 && !undoneHumanMove) {
      var lastMove = history[history.length - 1];
      if (lastMove.player === 'human') {
        engine.undoLastMove();
        undoneHumanMove = true;
      } else {
        engine.undoLastMove();
      }
    }

    if (!undoneHumanMove) return;

    selectedTile = null;
    selectedMoves = [];
    lastAIAnalysis = null;

    renderBoard();
    renderHumanHand();
    renderAIHand();
    updateScoreboard();
    hideEndMarkers();

    if (history.length > 0) {
      var lastEntry = history[history.length - 1];
      if (lastEntry.evalScore !== undefined) {
        updateEvalBar(lastEntry.evalScore);
      } else {
        updateEvalBar(0);
      }
      if (lastEntry.analysis && lastEntry.analysis.length > 0) {
        var cid = lastEntry.tile ? lastEntry.tile.id : null;
        renderAnalysis(lastEntry.analysis, cid, lastEntry.end);
      } else {
        clearAnalysis();
      }
    } else {
      updateEvalBar(0);
      clearAnalysis();
    }

    if (engine.hand.currentPlayer === 'ai') {
      setStatus('AI is thinking...');
      disableHumanHand();
      updateNavButtons();
      setTimeout(function () { executeAITurn(); }, 500);
    } else {
      startHumanTurn();
    }
  }

  function undoFromReview() {
    var history = engine.hand.moveHistory;
    var keepCount = viewIndex + 1;
    if (keepCount < 0) keepCount = 0;

    while (history.length > keepCount) {
      engine.undoLastMove();
    }

    viewIndex = -1;
    isReviewing = false;
    els.statusMessage.classList.remove('reviewing');

    selectedTile = null;
    selectedMoves = [];
    lastAIAnalysis = null;

    renderBoard();
    renderHumanHand();
    renderAIHand();
    updateScoreboard();
    hideEndMarkers();

    if (history.length > 0) {
      var lastEntry = history[history.length - 1];
      if (lastEntry.evalScore !== undefined) {
        updateEvalBar(lastEntry.evalScore);
      } else {
        updateEvalBar(0);
      }
      if (lastEntry.analysis && lastEntry.analysis.length > 0) {
        var cid = lastEntry.tile ? lastEntry.tile.id : null;
        renderAnalysis(lastEntry.analysis, cid, lastEntry.end);
      } else {
        clearAnalysis();
      }
    } else {
      updateEvalBar(0);
      clearAnalysis();
    }

    if (engine.hand.currentPlayer === 'ai') {
      setStatus('AI is thinking...');
      disableHumanHand();
      updateNavButtons();
      setTimeout(function () { executeAITurn(); }, 500);
    } else {
      startHumanTurn();
    }
  }

  function updateUndoButton() {
    if (!els.undoBtn) return;
    if (isReviewing) {
      els.undoBtn.style.display = (viewIndex >= 0) ? 'inline-block' : 'none';
    } else if (canUndo()) {
      els.undoBtn.style.display = 'inline-block';
    } else {
      els.undoBtn.style.display = 'none';
    }
  }

  function startHumanTurn() {
    selectedTile = null;
    selectedMoves = [];
    var legalMoves = engine.getLegalMoves('human');

    if (legalMoves.length === 0) {
      setStatus('No legal moves — you must pass.');
      els.passBtn.style.display = 'inline-block';
      disableHumanHand();
      hideEndMarkers();
      updateUndoButton();
      return;
    }

    els.passBtn.style.display = 'none';
    setStatus('Your turn — select a tile to play.');
    renderHumanHand();
    updateNavButtons();
    updateUndoButton();
  }

  function onTileClicked(tile) {
    if (isProcessing || isReviewing) return;
    var legalMoves = engine.getLegalMoves('human');
    var tileMoves = legalMoves.filter(function (m) { return m.tile === tile; });

    if (tileMoves.length === 0) return;

    if (selectedTile === tile) {
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
      onEndClicked('left');
      return;
    }

    if (tileMoves.length === 1) {
      onEndClicked(tileMoves[0].end);
    } else {
      showEndMarkers(tileMoves);
      setStatus('Choose which end to play on.');
    }
  }

  function onEndClicked(end) {
    if (!selectedTile || isProcessing || isReviewing) return;

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

    var humanEval = ai.evaluatePosition(engine);
    updateEvalBar(humanEval);
    clearAnalysis();

    var history = engine.hand.moveHistory;
    if (history.length > 0) {
      history[history.length - 1].evalScore = humanEval;
    }

    if (result.handEnd) {
      showHandResult(result.handEnd);
      return;
    }

    setStatus('AI is thinking...');
    disableHumanHand();
    updateNavButtons();
    els.undoBtn.style.display = 'none';
    setTimeout(function () { executeAITurn(); }, 500);
  }

  function onPassClicked() {
    if (isProcessing || isReviewing) return;
    isProcessing = true;
    els.passBtn.style.display = 'none';
    els.undoBtn.style.display = 'none';

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

    if (lastAIAnalysis) {
      updateEvalBar(lastAIAnalysis.bestScore);
      renderAnalysis(lastAIAnalysis.analysis, move.tile.id, move.end);

      var history = engine.hand.moveHistory;
      if (history.length > 0) {
        var lastEntry = history[history.length - 1];
        lastEntry.analysis = lastAIAnalysis.analysis;
        lastEntry.evalScore = lastAIAnalysis.bestScore;
      }
    }

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

  // ============================================================
  // AI Tile Animation — fly from AI hand to snake board position
  // ============================================================
  function animateAITile(move, callback) {
    var tileId = move.tile.id;
    var sourceEl = els.aiHand.querySelector('[data-tile-id="' + tileId + '"]');

    if (!sourceEl) {
      callback();
      return;
    }

    var sourceRect = sourceEl.getBoundingClientRect();

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

    sourceEl.classList.add('tile--ghost');

    // Target: endpoint of the snake chain
    var boardAreaRect = els.boardArea.getBoundingClientRect();
    var targetX, targetY;

    if (currentLayout.length > 0) {
      var targetLayout;
      if (move.end === 'left') {
        targetLayout = currentLayout[0];
      } else {
        targetLayout = currentLayout[currentLayout.length - 1];
      }
      // Convert from board-relative to viewport coords
      var boardElRect = els.board.getBoundingClientRect();
      targetX = boardElRect.left + targetLayout.pixelX + targetLayout.widthPx / 2 - sourceRect.width / 2;
      targetY = boardElRect.top + targetLayout.pixelY + targetLayout.heightPx / 2 - sourceRect.height / 2;
    } else {
      targetX = boardAreaRect.left + boardAreaRect.width / 2 - sourceRect.width / 2;
      targetY = boardAreaRect.top + boardAreaRect.height / 2 - sourceRect.height / 2;
    }

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        clone.style.left = targetX + 'px';
        clone.style.top = targetY + 'px';
        clone.style.transform = 'scale(1.1)';
      });
    });

    var animDone = false;
    function onAnimComplete() {
      if (animDone) return;
      animDone = true;
      if (clone.parentNode) clone.parentNode.removeChild(clone);
      callback();
    }

    clone.addEventListener('transitionend', function onEnd(e) {
      if (e.target !== clone) return;
      clone.removeEventListener('transitionend', onEnd);
      onAnimComplete();
    });

    setTimeout(onAnimComplete, 700);
  }

  function executeAITurn() {
    var legalMoves = engine.getLegalMoves('ai');

    if (legalMoves.length === 0) {
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

    if (difficulty === 'hard' && aiWorker && selectedEngine === 'new') {
      var t0 = Date.now();

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

        lastAIAnalysis = {
          bestScore: result.bestScore || 0,
          depth: result.depth || 0,
          nodes: result.nodes || 0,
          analysis: result.analysis || []
        };

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
          for (var i = 0; i < legalMoves.length; i++) {
            if (legalMoves[i].tile.id === tileId) { move = legalMoves[i]; break; }
          }
        }
        if (!move) move = legalMoves[0];

        applyAIMove(move, elapsed);
      };

      aiWorker.onerror = function () {
        var aiResult = ai.chooseMove(legalMoves, engine);
        lastAIAnalysis = { bestScore: aiResult.bestScore, depth: aiResult.depth, nodes: aiResult.nodes, analysis: aiResult.analysis };
        var elapsed = Date.now() - t0;
        applyAIMove(aiResult.move, elapsed);
      };

      aiWorker.postMessage(msg);
      return;
    }

    var t0 = Date.now();
    var aiResult = ai.chooseMove(legalMoves, engine);
    lastAIAnalysis = { bestScore: aiResult.bestScore, depth: aiResult.depth, nodes: aiResult.nodes, analysis: aiResult.analysis };
    var elapsed = Date.now() - t0;
    applyAIMove(aiResult.move, elapsed);
  }

  // ---- Hand/Match Result ----
  function showHandResult(result) {
    isProcessing = false;
    isReviewing = false;
    viewIndex = -1;
    handOver = true;
    handResult = result;
    els.statusMessage.classList.remove('reviewing');
    els.navBackward.style.display = 'none';
    els.navForward.style.display = 'none';
    els.undoBtn.style.display = 'none';
    clearAnalysis();

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

    body += '<div class="result-line" style="margin-top:12px;opacity:0.8;">Score — You: ' + engine.matchScore.human + ' | AI: ' + engine.matchScore.ai + '</div>';

    els.resultTitle.textContent = title;
    els.resultBody.innerHTML = body;

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
    showSavePrompt();
  }

  function onNewGame() {
    els.matchOverlay.style.display = 'none';
    els.startOverlay.style.display = 'flex';
    renderSavedDeals();
  }

  function onReviewHand() {
    els.resultOverlay.style.display = 'none';
    startHandReview();
  }

  function onReviewMatch() {
    els.matchOverlay.style.display = 'none';
    startHandReview();
  }

  function startHandReview() {
    var historyLen = engine.hand.moveHistory.length;
    viewIndex = historyLen - 1;
    enterReviewMode();
  }

  // ============================================================
  // Snake Layout Algorithm
  // ============================================================

  /**
   * Get the cell size based on current CSS tile variables.
   * Cell = half the long tile dimension (half-w in horizontal terms).
   */
  function getCellSize() {
    var cs = getComputedStyle(document.documentElement);
    var tileH = parseInt(cs.getPropertyValue('--tile-h'), 10) || 34;
    // Cell size = tile short dimension (height of horizontal tile)
    return tileH;
  }

  /**
   * Get tile dimensions from CSS variables
   */
  function getTileDims() {
    var cs = getComputedStyle(document.documentElement);
    var tw = parseInt(cs.getPropertyValue('--tile-w'), 10) || 64;
    var th = parseInt(cs.getPropertyValue('--tile-h'), 10) || 34;
    return { tw: tw, th: th };
  }

  /**
   * Compute the snake/chain layout for an array of board tile placements.
   * Returns array of layout objects with pixel positions and directions.
   */
  function computeSnakeLayout(boardTiles, containerWidthPx) {
    var dims = getTileDims();
    var tw = dims.tw;  // long dimension (e.g. 64)
    var th = dims.th;  // short dimension (e.g. 34)
    var gap = 2;       // gap between tiles in px

    var layouts = [];
    if (boardTiles.length === 0) return layouts;

    // Max tiles that fit horizontally
    var maxHorizPx = containerWidthPx - 20; // some margin
    var margin = tw + gap; // turn margin in pixels

    // Cursor state
    var cx = 0;      // current x position (pixels)
    var cy = 0;      // current y position (pixels)
    var dir = DIR_RIGHT;

    for (var i = 0; i < boardTiles.length; i++) {
      var p = boardTiles[i];
      var isDouble = p.tile.isDouble();
      var layout = {
        placement: p,
        pixelX: 0,
        pixelY: 0,
        widthPx: 0,
        heightPx: 0,
        dir: dir,
        index: i
      };

      if (dir === DIR_RIGHT || dir === DIR_LEFT) {
        // Horizontal travel
        if (isDouble) {
          // Double: perpendicular — vertical tile (th wide, tw tall)
          layout.widthPx = th;
          layout.heightPx = tw;
          if (dir === DIR_RIGHT) {
            layout.pixelX = cx;
            layout.pixelY = cy - (tw - th) / 2; // center vertically
            cx += th + gap;
          } else {
            cx -= (th + gap);
            layout.pixelX = cx;
            layout.pixelY = cy - (tw - th) / 2;
          }
        } else {
          // Non-double: horizontal tile (tw wide, th tall)
          layout.widthPx = tw;
          layout.heightPx = th;
          if (dir === DIR_RIGHT) {
            layout.pixelX = cx;
            layout.pixelY = cy;
            cx += tw + gap;
          } else {
            cx -= (tw + gap);
            layout.pixelX = cx;
            layout.pixelY = cy;
          }
        }
      } else {
        // Vertical travel (DIR_DOWN or DIR_UP)
        if (isDouble) {
          // Double: perpendicular — horizontal tile (tw wide, th tall)
          layout.widthPx = tw;
          layout.heightPx = th;
          if (dir === DIR_DOWN) {
            layout.pixelX = cx - (tw - th) / 2;
            layout.pixelY = cy;
            cy += th + gap;
          } else {
            cy -= (th + gap);
            layout.pixelX = cx - (tw - th) / 2;
            layout.pixelY = cy;
          }
        } else {
          // Non-double: vertical tile (th wide, tw tall)
          layout.widthPx = th;
          layout.heightPx = tw;
          if (dir === DIR_DOWN) {
            layout.pixelX = cx;
            layout.pixelY = cy;
            cy += tw + gap;
          } else {
            cy -= (tw + gap);
            layout.pixelX = cx;
            layout.pixelY = cy;
          }
        }
      }

      layouts.push(layout);

      // Check if we need to turn (only check after placing, before next tile)
      if (i < boardTiles.length - 1) {
        if (dir === DIR_RIGHT && cx > maxHorizPx - margin) {
          // Turn: go down then left
          // Drop down by a tile-width + some spacing
          var dropAmount = tw + gap * 4;
          cy += dropAmount;
          // cx stays at current position — next tile starts here going left
          dir = DIR_LEFT;
        } else if (dir === DIR_LEFT && cx < margin) {
          // Turn: go down then right
          var dropAmount = tw + gap * 4;
          cy += dropAmount;
          dir = DIR_RIGHT;
        }
      }
    }

    // Pass 2: compute bounding box and center-offset
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < layouts.length; i++) {
      var l = layouts[i];
      minX = Math.min(minX, l.pixelX);
      minY = Math.min(minY, l.pixelY);
      maxX = Math.max(maxX, l.pixelX + l.widthPx);
      maxY = Math.max(maxY, l.pixelY + l.heightPx);
    }

    var chainWidth = maxX - minX;
    var chainHeight = maxY - minY;

    // Center horizontally, add some top padding
    var offsetX = Math.max(10, (containerWidthPx - chainWidth) / 2) - minX;
    var offsetY = 10 - minY;

    for (var i = 0; i < layouts.length; i++) {
      layouts[i].pixelX += offsetX;
      layouts[i].pixelY += offsetY;
    }

    // Store bounds
    currentBounds = {
      width: chainWidth + 20,
      height: chainHeight + 20
    };

    return layouts;
  }

  // ============================================================
  // Rendering — Snake Board
  // ============================================================

  function createHalfElement(value) {
    var half = document.createElement('div');
    half.className = 'tile-half';
    half.setAttribute('data-value', value);
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

  function createTileElement(tile, isVertical) {
    var el = document.createElement('div');
    el.className = 'tile ' + (isVertical ? 'tile--vertical' : 'tile--horizontal');

    var leftVal = isVertical ? tile.high : tile.low;
    var rightVal = isVertical ? tile.low : tile.high;

    el.appendChild(createHalfElement(leftVal));
    el.appendChild(createHalfElement(rightVal));
    return el;
  }

  /**
   * Create a board tile element oriented for the snake layout.
   * The key insight: board.tiles array is ordered LEFT-to-RIGHT.
   * - For RIGHT travel: normal pip order (same as flat board)
   * - For LEFT travel: reverse pip halves so connecting face meets neighbor
   * - For DOWN travel: render as vertical tile, same order
   * - For UP travel: render as vertical tile, reversed order
   */
  function createSnakeBoardTileElement(layout) {
    var p = layout.placement;
    var tile = p.tile;
    var dir = layout.dir;
    var isDouble = tile.isDouble();
    var el = document.createElement('div');

    // Determine render orientation
    var isHorizTravel = (dir === DIR_RIGHT || dir === DIR_LEFT);
    var useVerticalClass;
    if (isDouble) {
      useVerticalClass = isHorizTravel; // perpendicular to horizontal travel
    } else {
      useVerticalClass = !isHorizTravel; // non-doubles go vertical during vert travel
    }

    el.className = 'tile tile--board tile--placed snake-tile ' +
      (useVerticalClass ? 'tile--vertical' : 'tile--horizontal');

    // Determine pip values for first-child and second-child
    var firstVal, secondVal;

    if (isDouble) {
      // Doubles: both halves same value
      firstVal = tile.high;
      secondVal = tile.low;
    } else {
      // The board.tiles array has correct L-to-R ordering.
      // placement.flipped tells us how the tile connects:
      // For flat horizontal L-to-R display:
      //   flipped=false → low on left, high on right
      //   flipped=true  → high on left, low on right
      if (p.flipped) {
        firstVal = tile.high;
        secondVal = tile.low;
      } else {
        firstVal = tile.low;
        secondVal = tile.high;
      }

      // For LEFT or UP travel, the array's L-to-R is physically reversed,
      // so we need to flip the half order.
      if (dir === DIR_LEFT || dir === DIR_UP) {
        var tmp = firstVal;
        firstVal = secondVal;
        secondVal = tmp;
      }
    }

    el.appendChild(createHalfElement(firstVal));
    el.appendChild(createHalfElement(secondVal));

    return el;
  }

  function createBackTile() {
    var el = document.createElement('div');
    el.className = 'tile tile--back';
    return el;
  }

  /**
   * Render the board as a snake/chain layout
   */
  function renderSnakeBoard(boardTiles) {
    // Remove all children except markers (which we re-append)
    els.board.innerHTML = '';
    els.board.appendChild(els.boardLeftMarker);
    els.board.appendChild(els.boardRightMarker);

    if (boardTiles.length === 0) {
      els.board.style.width = '100%';
      els.board.style.height = '100%';
      currentLayout = [];
      currentBounds = null;
      return;
    }

    var containerWidth = els.boardArea.clientWidth;
    var layouts = computeSnakeLayout(boardTiles, containerWidth);
    currentLayout = layouts;

    // Size the board div to fit all tiles
    if (currentBounds) {
      els.board.style.width = Math.max(containerWidth, currentBounds.width) + 'px';
      els.board.style.height = currentBounds.height + 'px';
    }

    // Create and position each tile
    for (var i = 0; i < layouts.length; i++) {
      var layout = layouts[i];
      var el = createSnakeBoardTileElement(layout);
      el.style.left = layout.pixelX + 'px';
      el.style.top = layout.pixelY + 'px';
      els.board.appendChild(el);
    }

    // Auto-scroll to show the latest tile
    scrollToLatestTile(layouts);
  }

  function scrollToLatestTile(layouts) {
    if (layouts.length === 0) return;

    var latest = layouts[layouts.length - 1];
    var areaWidth = els.boardArea.clientWidth;
    var areaHeight = els.boardArea.clientHeight;

    // Scroll to center on the latest tile
    var scrollLeft = latest.pixelX - areaWidth / 2 + latest.widthPx / 2;
    var scrollTop = latest.pixelY - areaHeight / 2 + latest.heightPx / 2;

    els.boardArea.scrollTo({
      left: Math.max(0, scrollLeft),
      top: Math.max(0, scrollTop),
      behavior: 'smooth'
    });
  }

  function renderBoard() {
    var boardTiles = engine.hand.board.tiles;
    renderSnakeBoard(boardTiles);
  }

  function renderBoardFromState(board) {
    renderSnakeBoard(board.tiles);
  }

  function renderHumanHand() {
    els.humanHand.innerHTML = '';
    var tiles = engine.hand.humanHand.tiles;
    var legalMoves = engine.getLegalMoves('human');

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

  // ============================================================
  // End Markers — positioned at snake chain endpoints
  // ============================================================

  function showEndMarkers(moves) {
    var hasLeft = false, hasRight = false;
    for (var i = 0; i < moves.length; i++) {
      if (moves[i].end === 'left') hasLeft = true;
      if (moves[i].end === 'right') hasRight = true;
    }

    if (currentLayout.length === 0) {
      // Empty board — show markers at center of board area
      var cx = els.boardArea.clientWidth / 2 - 20;
      var cy = els.boardArea.clientHeight / 2 - 20;
      if (hasLeft) {
        els.boardLeftMarker.style.left = (cx - 50) + 'px';
        els.boardLeftMarker.style.top = cy + 'px';
        els.boardLeftMarker.style.display = 'flex';
        els.boardLeftMarker.classList.add('glow');
      }
      if (hasRight) {
        els.boardRightMarker.style.left = (cx + 50) + 'px';
        els.boardRightMarker.style.top = cy + 'px';
        els.boardRightMarker.style.display = 'flex';
        els.boardRightMarker.classList.add('glow');
      }
      return;
    }

    var first = currentLayout[0];
    var last = currentLayout[currentLayout.length - 1];

    if (hasLeft) {
      // Position marker at the open end of the first tile
      var mx, my;
      switch (first.dir) {
        case DIR_RIGHT:
          mx = first.pixelX - 44;
          my = first.pixelY + (first.heightPx - 40) / 2;
          break;
        case DIR_LEFT:
          mx = first.pixelX + first.widthPx + 4;
          my = first.pixelY + (first.heightPx - 40) / 2;
          break;
        case DIR_DOWN:
          mx = first.pixelX + (first.widthPx - 40) / 2;
          my = first.pixelY - 44;
          break;
        case DIR_UP:
          mx = first.pixelX + (first.widthPx - 40) / 2;
          my = first.pixelY + first.heightPx + 4;
          break;
        default:
          mx = first.pixelX - 44;
          my = first.pixelY;
      }
      els.boardLeftMarker.style.left = mx + 'px';
      els.boardLeftMarker.style.top = my + 'px';
      els.boardLeftMarker.style.display = 'flex';
      els.boardLeftMarker.classList.add('glow');
    }

    if (hasRight) {
      var mx, my;
      switch (last.dir) {
        case DIR_RIGHT:
          mx = last.pixelX + last.widthPx + 4;
          my = last.pixelY + (last.heightPx - 40) / 2;
          break;
        case DIR_LEFT:
          mx = last.pixelX - 44;
          my = last.pixelY + (last.heightPx - 40) / 2;
          break;
        case DIR_DOWN:
          mx = last.pixelX + (last.widthPx - 40) / 2;
          my = last.pixelY + last.heightPx + 4;
          break;
        case DIR_UP:
          mx = last.pixelX + (last.widthPx - 40) / 2;
          my = last.pixelY - 44;
          break;
        default:
          mx = last.pixelX + last.widthPx + 4;
          my = last.pixelY;
      }
      els.boardRightMarker.style.left = mx + 'px';
      els.boardRightMarker.style.top = my + 'px';
      els.boardRightMarker.style.display = 'flex';
      els.boardRightMarker.classList.add('glow');
    }
  }

  function hideEndMarkers() {
    els.boardLeftMarker.style.display = 'none';
    els.boardRightMarker.style.display = 'none';
    els.boardLeftMarker.classList.remove('glow');
    els.boardRightMarker.classList.remove('glow');
  }

  // ============================================================
  // History Navigation
  // ============================================================

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
        var idx = -1;
        for (var k = 0; k < humanTiles.length; k++) {
          if (humanTiles[k].id === move.tile.id) { idx = k; break; }
        }
        if (idx !== -1) humanTiles.splice(idx, 1);
      } else {
        var idx = -1;
        for (var k = 0; k < aiTiles.length; k++) {
          if (aiTiles[k].id === move.tile.id) { idx = k; break; }
        }
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
      if (handOver) {
        exitReviewToHandOver();
      } else {
        exitReviewMode();
      }
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
    updateUndoButton();

    if (viewIndex >= 0) {
      var entry = engine.hand.moveHistory[viewIndex];
      if (entry.evalScore !== undefined) {
        updateEvalBar(entry.evalScore);
      }
      if (entry.analysis && entry.analysis.length > 0) {
        var chosenId = entry.tile ? entry.tile.id : null;
        var chosenEnd = entry.end || null;
        renderAnalysis(entry.analysis, chosenId, chosenEnd);
      } else {
        clearAnalysis();
      }
    } else {
      updateEvalBar(0);
      clearAnalysis();
    }
  }

  function exitReviewMode() {
    viewIndex = -1;
    isReviewing = false;
    els.statusMessage.classList.remove('reviewing');

    renderBoard();
    renderHumanHand();
    renderAIHand();
    updateNavButtons();

    var history = engine.hand.moveHistory;
    if (history.length > 0) {
      var lastEntry = history[history.length - 1];
      if (lastEntry.evalScore !== undefined) updateEvalBar(lastEntry.evalScore);
      if (lastEntry.analysis && lastEntry.analysis.length > 0) {
        var cid = lastEntry.tile ? lastEntry.tile.id : null;
        renderAnalysis(lastEntry.analysis, cid, lastEntry.end);
      } else {
        clearAnalysis();
      }
    }

    if (engine.hand.currentPlayer === 'human') {
      startHumanTurn();
    } else {
      setStatus('AI is thinking...');
    }
  }

  function exitReviewToHandOver() {
    viewIndex = -1;
    isReviewing = false;
    els.statusMessage.classList.remove('reviewing');

    renderBoard();
    renderHumanHand();
    renderAIHandRevealed();

    els.navBackward.style.display = 'none';
    els.navForward.style.display = 'none';
    els.undoBtn.style.display = 'none';
    clearAnalysis();

    setStatus('Hand over');

    var matchWinner = engine.checkMatchEnd();
    if (matchWinner) {
      els.matchOverlay.style.display = 'flex';
    } else {
      els.resultOverlay.style.display = 'flex';
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

    if ((isReviewing && viewIndex <= -1) || isProcessing) {
      els.navBackward.disabled = true;
    } else {
      els.navBackward.disabled = false;
    }

    if (!isReviewing) {
      els.navForward.disabled = true;
    } else {
      els.navForward.disabled = false;
    }
  }

  // --- Read-only render functions for review mode ---

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

  // ============================================================
  // Eval Bar + Analysis Panel
  // ============================================================

  function scoreToPercent(score) {
    var k = 0.03;
    var t = Math.tanh(score * k);
    return 50 + t * 50;
  }

  function updateEvalBar(score) {
    if (!els.evalFill || !els.evalLabel) return;

    var aiPercent = scoreToPercent(score);
    els.evalFill.style.width = aiPercent + '%';

    if (Math.abs(score) < 3) {
      els.evalLabel.textContent = 'Even';
    } else if (score > 0) {
      els.evalLabel.textContent = 'AI +' + Math.round(score);
    } else {
      els.evalLabel.textContent = 'You +' + Math.round(-score);
    }
  }

  function renderAnalysis(analysis, chosenTileId, chosenEnd) {
    if (!els.analysisList || !els.analysisPanel) return;
    if (!analysis || analysis.length === 0) {
      els.analysisPanel.style.display = 'none';
      return;
    }

    els.analysisList.innerHTML = '';

    for (var i = 0; i < analysis.length; i++) {
      var entry = analysis[i];
      var pill = document.createElement('span');
      var isBest = (entry.tileId === chosenTileId && entry.end === chosenEnd);
      pill.className = 'analysis-pill' + (isBest ? ' analysis-pill--best' : '');

      var endLabel = entry.end === 'left' ? 'L' : 'R';
      var scoreSign = entry.score >= 0 ? '+' : '';
      var scoreClass = entry.score > 0 ? 'pill-score--pos' : (entry.score < 0 ? 'pill-score--neg' : '');

      pill.innerHTML = '[' + entry.tileId.replace('-', '|') + ']' + endLabel +
        ' <span class="pill-score ' + scoreClass + '">' + scoreSign + Math.round(entry.score) + '</span>';

      els.analysisList.appendChild(pill);
    }

    els.analysisPanel.style.display = 'block';
  }

  function clearAnalysis() {
    if (!els.analysisPanel) return;
    els.analysisPanel.style.display = 'none';
    if (els.analysisList) els.analysisList.innerHTML = '';
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
  // When loaded dynamically, DOMContentLoaded may have already fired
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(window.Domino);
