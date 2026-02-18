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
  var selectedTile = null;
  var selectedMoves = []; // legal moves for selected tile
  var difficulty = 'easy';
  var isProcessing = false;

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

    els.startOverlay = document.getElementById('start-overlay');
    els.leaderOverlay = document.getElementById('leader-overlay');
    els.resultOverlay = document.getElementById('result-overlay');
    els.resultTitle = document.getElementById('result-title');
    els.resultBody = document.getElementById('result-body');
    els.matchOverlay = document.getElementById('match-overlay');
    els.matchTitle = document.getElementById('match-title');
    els.matchBody = document.getElementById('match-body');

    setupEventListeners();
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

    // Next hand / play again
    document.getElementById('next-hand-btn').addEventListener('click', onNextHand);
    document.getElementById('play-again-btn').addEventListener('click', onPlayAgain);
  }

  // ---- Start Screen ----
  function onStartMatch() {
    engine = new D.GameEngine();
    engine.newMatch(difficulty);
    ai = new D.AIPlayer(difficulty);

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
    selectedTile = null;
    selectedMoves = [];
    isProcessing = false;

    updateScoreboard();
    renderAIHand();
    renderHumanHand();
    renderBoard();
    hideEndMarkers();

    if (leader === 'human') {
      startHumanTurn();
    } else {
      setStatus('AI is thinking...');
      disableHumanHand();
      setTimeout(function () { executeAITurn(); }, 700);
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
  }

  function onTileClicked(tile) {
    if (isProcessing) return;
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
    if (!selectedTile || isProcessing) return;

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
    setTimeout(function () { executeAITurn(); }, 700);
  }

  function onPassClicked() {
    if (isProcessing) return;
    isProcessing = true;
    els.passBtn.style.display = 'none';

    var blockResult = engine.pass('human');

    if (blockResult) {
      showHandResult(blockResult);
      return;
    }

    setStatus('AI is thinking...');
    disableHumanHand();
    setTimeout(function () { executeAITurn(); }, 700);
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

    var move = ai.chooseMove(legalMoves, engine);
    var result = engine.playTile('ai', move.tile, move.end);

    setStatus('AI plays ' + move.tile.toString() + '.');
    renderBoard();
    renderAIHand();
    renderHumanHand();
    updateScoreboard();

    if (result.handEnd) {
      setTimeout(function () { showHandResult(result.handEnd); }, 600);
      return;
    }

    setTimeout(function () {
      isProcessing = false;
      startHumanTurn();
    }, 600);
  }

  // ---- Hand/Match Result ----
  function showHandResult(result) {
    isProcessing = false;

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

  function createBoardTileElement(placement) {
    var tile = placement.tile;
    var isVertical = tile.isDouble();
    var el = document.createElement('div');
    el.className = 'tile tile--board tile--placed ' + (isVertical ? 'tile--vertical' : 'tile--horizontal');

    if (isVertical) {
      el.appendChild(createHalfElement(tile.high));
      el.appendChild(createHalfElement(tile.low));
    } else {
      // Determine orientation based on placement
      if (placement.end === 'left' || (!placement.end && placement === engine.hand.board.tiles[0])) {
        // Left side: the matching side faces right (inward)
        if (placement.flipped) {
          el.appendChild(createHalfElement(tile.high));
          el.appendChild(createHalfElement(tile.low));
        } else {
          el.appendChild(createHalfElement(tile.low));
          el.appendChild(createHalfElement(tile.high));
        }
      } else {
        // Right side: the matching side faces left (inward)
        if (placement.flipped) {
          el.appendChild(createHalfElement(tile.high));
          el.appendChild(createHalfElement(tile.low));
        } else {
          el.appendChild(createHalfElement(tile.low));
          el.appendChild(createHalfElement(tile.high));
        }
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

  function renderBoard() {
    els.board.innerHTML = '';
    var boardTiles = engine.hand.board.tiles;
    for (var i = 0; i < boardTiles.length; i++) {
      var tileEl = createBoardTileElement(boardTiles[i]);
      els.board.appendChild(tileEl);
    }

    // Auto-scroll to see new tiles
    if (boardTiles.length > 0) {
      els.boardArea.scrollLeft = (els.boardArea.scrollWidth - els.boardArea.clientWidth) / 2;
    }
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
    var count = engine.hand.aiHand.count();
    for (var i = 0; i < count; i++) {
      els.aiHand.appendChild(createBackTile());
    }
    els.aiTileCount.textContent = '(' + count + ')';
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
