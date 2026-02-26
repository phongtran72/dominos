// ============================================================
// ui-board.js — 4-Player Snake Board UI
// Adapted from 3-player variant for 4 players.
// Players: human, ai1, ai3, ai2 (partners across: Human+AI3, AI1+AI2).
// No boneyard, no draw. 28 tiles, 7 each.
// ============================================================

(function (D) {
    'use strict';

    // Pip position patterns for 3x3 grid
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
    var DIR_DOWN = 1;
    var DIR_LEFT = 2;
    var DIR_UP = 3;

    // --- DOM References ---
    var els = {};
    var engine = null;
    var ai1 = null;
    var ai2 = null;
    var ai3 = null;
    var selectedTile = null;
    var selectedMoves = [];
    var difficulty = 'hard';
    var gameMode = 'quick';
    var aiMode = 'independent';
    var matchPoints = 100;
    var isProcessing = false;

    // --- History Navigation ---
    var initialHumanTiles = null;
    var initialAI1Tiles = null;
    var initialAI2Tiles = null;
    var initialAI3Tiles = null;
    var viewIndex = -1;
    var isReviewing = false;
    var handOver = false;
    var handResult = null;

    // --- Snake Layout State ---
    var currentLayout = [];
    var currentBounds = null;

    // ============================================================
    // Init
    // ============================================================
    function init() {
        els.humanScore = document.getElementById('human-score');
        els.ai1Score = document.getElementById('ai1-score');
        els.ai2Score = document.getElementById('ai2-score');
        els.ai3Score = document.getElementById('ai3-score');
        els.ai1Hand = document.getElementById('ai1-hand');
        els.ai1TileCount = document.getElementById('ai1-tile-count');
        els.ai2Hand = document.getElementById('ai2-hand');
        els.ai2TileCount = document.getElementById('ai2-tile-count');
        els.ai3Hand = document.getElementById('ai3-hand');
        els.ai3TileCount = document.getElementById('ai3-tile-count');
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

        els.turnIndicator = document.getElementById('turn-indicator');
        els.turnIndicatorText = document.getElementById('turn-indicator-text');

        els.undoBtn = document.getElementById('undo-btn');
        els.handNumber = document.getElementById('hand-number');

        els.startOverlay = document.getElementById('start-overlay');
        els.leaderOverlay = document.getElementById('leader-overlay');
        els.resultOverlay = document.getElementById('result-overlay');
        els.resultTitle = document.getElementById('result-title');
        els.resultBody = document.getElementById('result-body');
        els.matchOverlay = document.getElementById('match-overlay');
        els.matchTitle = document.getElementById('match-title');
        els.matchBody = document.getElementById('match-body');

        // Move end markers inside #board
        els.board.appendChild(els.boardLeftMarker);
        els.board.appendChild(els.boardRightMarker);

        setupEventListeners();

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

        // Game mode buttons
        var modeBtns = document.querySelectorAll('[data-gamemode]');
        var matchPointsGroup = document.getElementById('match-points-group');
        var startSubtitle = document.getElementById('start-subtitle');
        for (var i = 0; i < modeBtns.length; i++) {
            modeBtns[i].addEventListener('click', function () {
                for (var j = 0; j < modeBtns.length; j++) modeBtns[j].classList.remove('active');
                this.classList.add('active');
                gameMode = this.getAttribute('data-gamemode');
                if (matchPointsGroup) {
                    matchPointsGroup.style.display = (gameMode === 'match') ? '' : 'none';
                }
                if (startSubtitle) {
                    startSubtitle.textContent = gameMode === 'match'
                        ? '4 Players \u2022 First to ' + matchPoints
                        : '4 Players \u2022 Quick Game';
                }
            });
        }

        // Match points buttons
        var mpBtns = document.querySelectorAll('[data-matchpoints]');
        for (var i = 0; i < mpBtns.length; i++) {
            mpBtns[i].addEventListener('click', function () {
                for (var j = 0; j < mpBtns.length; j++) mpBtns[j].classList.remove('active');
                this.classList.add('active');
                matchPoints = parseInt(this.getAttribute('data-matchpoints'), 10);
                if (startSubtitle) {
                    startSubtitle.textContent = '4 Players \u2022 First to ' + matchPoints;
                }
            });
        }

        // AI mode buttons
        var aiModeBtns = document.querySelectorAll('[data-aimode]');
        var aiModeSubtitle = document.getElementById('ai-mode-subtitle');
        for (var i = 0; i < aiModeBtns.length; i++) {
            aiModeBtns[i].addEventListener('click', function () {
                for (var j = 0; j < aiModeBtns.length; j++) aiModeBtns[j].classList.remove('active');
                this.classList.add('active');
                aiMode = this.getAttribute('data-aimode');
                if (aiModeSubtitle) {
                    if (aiMode === '1v3') {
                        aiModeSubtitle.textContent = 'You vs AI-1 + AI-2 + AI-3 (1v3 teams)';
                    } else if (aiMode === '2v2') {
                        aiModeSubtitle.textContent = 'You + AI-3 vs AI-1 + AI-2 (2v2 teams)';
                    } else {
                        aiModeSubtitle.textContent = 'Each AI plays for itself';
                    }
                }
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

        // Undo button
        els.undoBtn.addEventListener('click', onUndo);

        // Review & Play Again
        document.getElementById('review-hand-btn').addEventListener('click', onReviewHand);
        document.getElementById('play-again-btn').addEventListener('click', onPlayAgain);

        // Match overlay buttons
        document.getElementById('review-match-btn').addEventListener('click', function () {
            els.matchOverlay.style.display = 'none';
            onReviewHand();
        });
        document.getElementById('match-play-again-btn').addEventListener('click', function () {
            els.matchOverlay.style.display = 'none';
            onStartMatch();
        });
        document.getElementById('new-game-btn').addEventListener('click', function () {
            els.matchOverlay.style.display = 'none';
            els.startOverlay.style.display = 'flex';
        });
    }

    // ---- Start Screen ----
    function onStartMatch() {
        engine = new D.GameEngine();
        var teamMode = (aiMode === '1v3' || aiMode === '2v2');
        var teamConfig = teamMode ? aiMode : null;
        engine.newMatch(difficulty, gameMode, teamMode, teamConfig);
        engine.targetScore = matchPoints;
        ai1 = new D.AIPlayer(difficulty, 'ai1', teamMode, teamConfig);
        ai2 = new D.AIPlayer(difficulty, 'ai2', teamMode, teamConfig);
        ai3 = new D.AIPlayer(difficulty, 'ai3', teamMode, teamConfig);

        els.startOverlay.style.display = 'none';
        showLeaderChoice();
    }

    function showLeaderChoice() {
        els.leaderOverlay.style.display = 'flex';
    }

    function onLeaderChosen(leader) {
        els.leaderOverlay.style.display = 'none';
        startHand(leader);
    }

    // ---- Hand Flow ----
    function startHand(leader) {
        engine.dealHand(leader);

        initialHumanTiles = engine.hand.humanHand.tiles.slice();
        initialAI1Tiles = engine.hand.ai1Hand.tiles.slice();
        initialAI2Tiles = engine.hand.ai2Hand.tiles.slice();
        initialAI3Tiles = engine.hand.ai3Hand.tiles.slice();
        viewIndex = -1;
        isReviewing = false;
        handOver = false;
        handResult = null;

        selectedTile = null;
        selectedMoves = [];
        isProcessing = false;

        updateScoreboard();
        renderAIHand('ai1');
        renderAIHand('ai2');
        renderAIHand('ai3');
        renderHumanHand();
        renderBoard();
        hideEndMarkers();
        updateNavButtons();
        updateUndoButton();

        // Update hand number
        if (els.handNumber) {
            els.handNumber.textContent = '#' + engine.handNumber;
        }

        beginTurn(leader);
    }

    function beginTurn(player) {
        updateTurnIndicator(player);

        if (player === 'human') {
            startHumanTurn();
        } else {
            var aiLabel = engine.getPlayerLabel(player);
            setStatus(aiLabel + ' is thinking...');
            disableHumanHand();
            setTimeout(function () { executeAITurn(player); }, 600);
        }
    }

    function updateTurnIndicator(player) {
        if (!els.turnIndicator) return;
        var label = engine.getPlayerLabel(player);
        var text = (player === 'human') ? 'Your turn' : label + "'s turn";
        els.turnIndicatorText.textContent = text;
        els.turnIndicator.style.display = 'block';
        els.turnIndicator.className = 'turn-indicator turn-' + player;
    }

    // ---- Human Turn ----
    function startHumanTurn() {
        selectedTile = null;
        selectedMoves = [];
        var legalMoves = engine.getLegalMoves('human');

        if (legalMoves.length === 0) {
            // No boneyard — must pass
            setStatus('No legal moves \u2014 you must pass.');
            els.passBtn.style.display = 'inline-block';
            disableHumanHand();
            hideEndMarkers();
            return;
        }

        els.passBtn.style.display = 'none';
        setStatus('Your turn \u2014 select a tile to play.');
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
            setStatus('Your turn \u2014 select a tile to play.');
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
        renderAIHand('ai1');
        renderAIHand('ai2');
        renderAIHand('ai3');
        updateScoreboard();

        if (result.handEnd) {
            showHandResult(result.handEnd);
            return;
        }

        var nextPlayer = engine.hand.currentPlayer;
        isProcessing = false;
        beginTurn(nextPlayer);
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

        isProcessing = false;
        var nextPlayer = engine.hand.currentPlayer;
        beginTurn(nextPlayer);
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

        renderBoard();
        renderHumanHand();
        renderAIHand('ai1');
        renderAIHand('ai2');
        renderAIHand('ai3');
        updateScoreboard();
        hideEndMarkers();

        if (engine.hand.currentPlayer === 'human') {
            startHumanTurn();
        } else {
            var label = engine.getPlayerLabel(engine.hand.currentPlayer);
            setStatus(label + ' is thinking...');
            disableHumanHand();
            updateNavButtons();
            updateUndoButton();
            setTimeout(function () { executeAITurn(engine.hand.currentPlayer); }, 500);
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
        handOver = false;
        els.statusMessage.classList.remove('reviewing');

        selectedTile = null;
        selectedMoves = [];

        renderBoard();
        renderHumanHand();
        renderAIHand('ai1');
        renderAIHand('ai2');
        renderAIHand('ai3');
        updateScoreboard();
        hideEndMarkers();

        if (engine.hand.currentPlayer === 'human') {
            startHumanTurn();
        } else {
            var label = engine.getPlayerLabel(engine.hand.currentPlayer);
            setStatus(label + ' is thinking...');
            disableHumanHand();
            updateNavButtons();
            updateUndoButton();
            setTimeout(function () { executeAITurn(engine.hand.currentPlayer); }, 500);
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

    // ---- AI Turn ----
    function executeAITurn(player) {
        var legalMoves = engine.getLegalMoves(player);
        var aiLabel = engine.getPlayerLabel(player);

        if (legalMoves.length === 0) {
            // Must pass
            setStatus(aiLabel + ' has no legal moves \u2014 ' + aiLabel + ' passes.');
            var blockResult = engine.pass(player);

            if (blockResult) {
                setTimeout(function () { showHandResult(blockResult); }, 800);
                return;
            }

            setTimeout(function () {
                var nextPlayer = engine.hand.currentPlayer;
                beginTurn(nextPlayer);
            }, 800);
            return;
        }

        // Choose move — route to correct AI instance
        var aiPlayer;
        if (player === 'ai1') aiPlayer = ai1;
        else if (player === 'ai2') aiPlayer = ai2;
        else aiPlayer = ai3;

        var aiResult = aiPlayer.chooseMove(legalMoves, engine);
        finishAIMove(player, aiResult.move);
    }

    function finishAIMove(player, move) {
        var result = engine.playTile(player, move.tile, move.end);
        var aiLabel = engine.getPlayerLabel(player);

        setStatus(aiLabel + ' plays ' + move.tile.toString() + '.');
        renderBoard();
        renderAIHand('ai1');
        renderAIHand('ai2');
        renderAIHand('ai3');
        renderHumanHand();
        updateScoreboard();

        if (result.handEnd) {
            setTimeout(function () { showHandResult(result.handEnd); }, 600);
            return;
        }

        setTimeout(function () {
            var nextPlayer = engine.hand.currentPlayer;
            beginTurn(nextPlayer);
        }, 600);
    }

    // ---- Hand Result ----
    function showHandResult(result) {
        isProcessing = false;
        isReviewing = false;
        viewIndex = -1;
        handOver = true;
        handResult = result;
        els.passBtn.style.display = 'none';
        if (els.turnIndicator) els.turnIndicator.style.display = 'none';

        // Reveal all AI hands
        renderAIHandRevealed('ai1');
        renderAIHandRevealed('ai2');
        renderAIHandRevealed('ai3');

        var title = '';
        var body = '';

        if (result.type === 'domino') {
            var winnerLabel = engine.getPlayerLabel(result.winner);
            if (result.teamWin) {
                var teamLabels = [];
                for (var k = 0; k < result.teamMembers.length; k++) {
                    teamLabels.push(engine.getPlayerLabel(result.teamMembers[k]));
                }
                title = winnerLabel + ' Domino! (Team)';
                body = '<div class="result-line">' + winnerLabel + ' played all tiles.</div>';
                body += '<div class="result-line">Team: ' + teamLabels.join(' + ') + '</div>';
                body += '<div class="result-line">Points awarded to team: <span class="result-highlight">+' + result.points + '</span></div>';
            } else {
                title = winnerLabel + ' Domino!';
                body = '<div class="result-line">' + winnerLabel + ' played all tiles.</div>';
                body += '<div class="result-line">Points awarded: <span class="result-highlight">+' + result.points + '</span></div>';
            }

            // Show pip details for all players
            for (var i = 0; i < D.PLAYERS.length; i++) {
                var p = D.PLAYERS[i];
                if (p === result.winner) continue;
                var label = engine.getPlayerLabel(p);
                var pips = result.pipDetails[p];
                if (pips !== undefined) {
                    body += '<div class="result-line result-detail">' + label + ': ' + pips + ' pips remaining</div>';
                }
            }
        } else if (result.type === 'block') {
            var winnerLabel = engine.getPlayerLabel(result.winner);
            if (result.teamWin) {
                var teamLabel = (result.teamMembers.indexOf('human') !== -1) ? 'Your Team' : 'AI Team';
                title = 'Blocked! ' + teamLabel + ' Wins';
                body = '<div class="result-line">Board is locked \u2014 lowest team pip count wins.</div>';
                // Dynamic team labels from teamPlayersMap
                var tpMap = result.teamPlayersMap;
                if (tpMap) {
                    var teamNames = Object.keys(tpMap);
                    for (var t = 0; t < teamNames.length; t++) {
                        var tn = teamNames[t];
                        var members = tpMap[tn];
                        var labels = [];
                        for (var m = 0; m < members.length; m++) {
                            labels.push(engine.getPlayerLabel(members[m]));
                        }
                        var teamPipValue = (tn === 'A') ? result.teamAPips : result.teamBPips;
                        body += '<div class="result-line result-detail">Team ' + tn +
                            ' (' + labels.join(' + ') + '): ' + teamPipValue + ' pips</div>';
                    }
                }
            } else {
                title = 'Blocked! ' + winnerLabel + ' Wins';
                body = '<div class="result-line">Board is locked \u2014 lowest pip count wins.</div>';
            }

            // Show all pip counts
            for (var i = 0; i < D.PLAYERS.length; i++) {
                var p = D.PLAYERS[i];
                var label = engine.getPlayerLabel(p);
                var pips = result.pipCounts[p];
                var isWinner = (p === result.winner);
                body += '<div class="result-line ' + (isWinner ? 'result-highlight-line' : 'result-detail') + '">' +
                    label + ': ' + pips + ' pips' + (isWinner ? ' \u2605' : '') + '</div>';
            }

            body += '<div class="result-line" style="margin-top:8px;">Points awarded: <span class="result-highlight">+' + result.points + '</span></div>';
        }

        // Show score summary
        body += '<div class="result-line result-score-line" style="margin-top:12px;opacity:0.8;">' +
            'Score \u2014 You: ' + engine.matchScore.human +
            ' | AI-1: ' + engine.matchScore.ai1 +
            ' | AI-3: ' + engine.matchScore.ai3 +
            ' | AI-2: ' + engine.matchScore.ai2 + '</div>';

        els.resultTitle.textContent = title;
        els.resultBody.innerHTML = body;

        updateUndoButton();

        // Handle match flow
        var nextHandBtn = document.getElementById('next-hand-btn');
        var playAgainBtn = document.getElementById('play-again-btn');
        var matchWinner = engine.checkMatchEnd();

        if (gameMode === 'match') {
            if (matchWinner) {
                nextHandBtn.textContent = 'See Results';
                nextHandBtn.onclick = function () {
                    els.resultOverlay.style.display = 'none';
                    showMatchResult(matchWinner);
                };
                nextHandBtn.style.display = '';
                playAgainBtn.style.display = 'none';
            } else {
                nextHandBtn.textContent = 'Next Hand';
                nextHandBtn.onclick = onNextHand;
                nextHandBtn.style.display = '';
                playAgainBtn.style.display = 'none';
            }
        } else {
            // Quick mode — no next hand, just play again
            nextHandBtn.style.display = 'none';
            playAgainBtn.style.display = '';
            playAgainBtn.textContent = 'Play Again';
        }

        els.resultOverlay.style.display = 'flex';
    }

    function onReviewHand() {
        els.resultOverlay.style.display = 'none';
        var historyLen = engine.hand.moveHistory.length;
        viewIndex = historyLen - 1;
        enterReviewMode();
    }

    function onNextHand() {
        els.resultOverlay.style.display = 'none';
        showLeaderChoice();
    }

    function showMatchResult(winner) {
        var winnerLabel = engine.getPlayerLabel(winner);
        if (engine.teamMode) {
            var teamMembers = D.getTeamMembers(winner);
            var teamLabels = [];
            for (var i = 0; i < teamMembers.length; i++) {
                teamLabels.push(engine.getPlayerLabel(teamMembers[i]));
            }
            els.matchTitle.textContent = teamLabels.join(' + ') + ' Win!';
        } else {
            els.matchTitle.textContent = winnerLabel + (winner === 'human' ? ' Win!' : ' Wins!');
        }
        els.matchBody.innerHTML =
            '<div style="font-size:1.1rem;text-align:center;margin-bottom:8px;">Final Score</div>' +
            '<div style="text-align:center;font-size:1.2rem;font-weight:700;color:#f0d060;">You: ' +
            engine.matchScore.human + ' &mdash; AI-1: ' + engine.matchScore.ai1 +
            ' &mdash; AI-2: ' + engine.matchScore.ai2 +
            ' &mdash; AI-3: ' + engine.matchScore.ai3 + '</div>' +
            '<div style="text-align:center;margin-top:8px;opacity:0.7;">Hands played: ' + engine.handNumber + '</div>';
        els.matchOverlay.style.display = 'flex';
    }

    function onPlayAgain() {
        els.resultOverlay.style.display = 'none';
        els.startOverlay.style.display = 'flex';
    }

    // ============================================================
    // Snake Layout Algorithm
    // ============================================================

    function getCellSize() {
        var cs = getComputedStyle(document.documentElement);
        var tileH = parseInt(cs.getPropertyValue('--tile-h'), 10) || 34;
        return tileH;
    }

    function getTileDims() {
        var cs = getComputedStyle(document.documentElement);
        var tw = parseInt(cs.getPropertyValue('--tile-w'), 10) || 64;
        var th = parseInt(cs.getPropertyValue('--tile-h'), 10) || 34;
        return { tw: tw, th: th };
    }

    function computeSnakeLayout(boardTiles, containerWidthPx) {
        var dims = getTileDims();
        var tw = dims.tw;
        var th = dims.th;
        var gap = 2;

        var layouts = [];
        if (boardTiles.length === 0) return layouts;

        var maxHorizPx = containerWidthPx - 20;
        var margin = tw + gap;

        var cx = 0;
        var cy = 0;
        var dir = DIR_RIGHT;

        for (var i = 0; i < boardTiles.length; i++) {
            var p = boardTiles[i];
            var isDouble = p.tile.isDouble();
            var layout = {
                placement: p,
                pixelX: 0, pixelY: 0,
                widthPx: 0, heightPx: 0,
                dir: dir, index: i
            };

            if (dir === DIR_RIGHT || dir === DIR_LEFT) {
                if (isDouble) {
                    layout.widthPx = th;
                    layout.heightPx = tw;
                    if (dir === DIR_RIGHT) {
                        layout.pixelX = cx;
                        layout.pixelY = cy - (tw - th) / 2;
                        cx += th + gap;
                    } else {
                        cx -= (th + gap);
                        layout.pixelX = cx;
                        layout.pixelY = cy - (tw - th) / 2;
                    }
                } else {
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
                if (isDouble) {
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

            if (i < boardTiles.length - 1) {
                if (dir === DIR_RIGHT && cx > maxHorizPx - margin) {
                    var dropAmount = tw + gap * 4;
                    cy += dropAmount;
                    dir = DIR_LEFT;
                } else if (dir === DIR_LEFT && cx < margin) {
                    var dropAmount = tw + gap * 4;
                    cy += dropAmount;
                    dir = DIR_RIGHT;
                }
            }
        }

        // Bounding box and centering
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

        var offsetX = Math.max(10, (containerWidthPx - chainWidth) / 2) - minX;
        var offsetY = 10 - minY;

        for (var i = 0; i < layouts.length; i++) {
            layouts[i].pixelX += offsetX;
            layouts[i].pixelY += offsetY;
        }

        currentBounds = { width: chainWidth + 20, height: chainHeight + 20 };
        return layouts;
    }

    // ============================================================
    // Rendering
    // ============================================================

    function createHalfElement(value) {
        var half = document.createElement('div');
        half.className = 'tile-half';
        half.setAttribute('data-value', value);
        var positions = PIP_PATTERNS[value] || [];

        for (var i = 0; i < 9; i++) {
            var pip = document.createElement('div');
            pip.className = positions.indexOf(i) !== -1 ? 'pip' : 'pip pip--hidden';
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

    function createSnakeBoardTileElement(layout) {
        var p = layout.placement;
        var tile = p.tile;
        var dir = layout.dir;
        var isDouble = tile.isDouble();
        var el = document.createElement('div');

        var isHorizTravel = (dir === DIR_RIGHT || dir === DIR_LEFT);
        var useVerticalClass;

        if (isDouble) {
            useVerticalClass = isHorizTravel;
        } else {
            useVerticalClass = !isHorizTravel;
        }

        var playerClass = p.player ? ' tile--by-' + p.player : '';
        el.className = 'tile tile--board tile--placed snake-tile ' +
            (useVerticalClass ? 'tile--vertical' : 'tile--horizontal') + playerClass;

        var firstVal, secondVal;

        if (isDouble) {
            firstVal = tile.high;
            secondVal = tile.low;
        } else {
            if (p.flipped) {
                firstVal = tile.high;
                secondVal = tile.low;
            } else {
                firstVal = tile.low;
                secondVal = tile.high;
            }

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

    function createBackTile(player) {
        var el = document.createElement('div');
        el.className = 'tile tile--back' + (player ? ' tile--back-' + player : '');
        return el;
    }

    function renderSnakeBoard(boardTiles) {
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

        if (currentBounds) {
            els.board.style.width = Math.max(containerWidth, currentBounds.width) + 'px';
            els.board.style.height = currentBounds.height + 'px';
        }

        for (var i = 0; i < layouts.length; i++) {
            var layout = layouts[i];
            var el = createSnakeBoardTileElement(layout);
            el.style.left = layout.pixelX + 'px';
            el.style.top = layout.pixelY + 'px';
            els.board.appendChild(el);
        }

        scrollToLatestTile(layouts);
    }

    function scrollToLatestTile(layouts) {
        if (layouts.length === 0) return;
        var latest = layouts[layouts.length - 1];
        var areaWidth = els.boardArea.clientWidth;
        var areaHeight = els.boardArea.clientHeight;

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

            if (isPlayable && !isProcessing && engine.hand.currentPlayer === 'human') {
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

    function getAIHandEl(player) {
        if (player === 'ai1') return els.ai1Hand;
        if (player === 'ai2') return els.ai2Hand;
        return els.ai3Hand;
    }

    function getAICountEl(player) {
        if (player === 'ai1') return els.ai1TileCount;
        if (player === 'ai2') return els.ai2TileCount;
        return els.ai3TileCount;
    }

    function renderAIHand(player) {
        var handEl = getAIHandEl(player);
        var countEl = getAICountEl(player);
        var hand = engine.getHand(player);

        handEl.innerHTML = '';
        var count = hand.count();
        for (var i = 0; i < count; i++) {
            handEl.appendChild(createBackTile(player));
        }
        countEl.textContent = '(' + count + ')';
    }

    function renderAIHandRevealed(player) {
        var handEl = getAIHandEl(player);
        var countEl = getAICountEl(player);
        var hand = engine.getHand(player);

        handEl.innerHTML = '';
        var tiles = hand.tiles;
        for (var i = 0; i < tiles.length; i++) {
            var el = createTileElement(tiles[i], false);
            el.classList.add('tile--board');
            handEl.appendChild(el);
        }
        countEl.textContent = '(' + tiles.length + ')';
    }

    // ============================================================
    // End Markers
    // ============================================================

    function showEndMarkers(moves) {
        var hasLeft = false, hasRight = false;
        for (var i = 0; i < moves.length; i++) {
            if (moves[i].end === 'left') hasLeft = true;
            if (moves[i].end === 'right') hasRight = true;
        }

        if (currentLayout.length === 0) {
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
            var mx, my;
            switch (first.dir) {
                case DIR_RIGHT: mx = first.pixelX - 44; my = first.pixelY + (first.heightPx - 40) / 2; break;
                case DIR_LEFT: mx = first.pixelX + first.widthPx + 4; my = first.pixelY + (first.heightPx - 40) / 2; break;
                case DIR_DOWN: mx = first.pixelX + (first.widthPx - 40) / 2; my = first.pixelY - 44; break;
                case DIR_UP: mx = first.pixelX + (first.widthPx - 40) / 2; my = first.pixelY + first.heightPx + 4; break;
                default: mx = first.pixelX - 44; my = first.pixelY;
            }
            els.boardLeftMarker.style.left = mx + 'px';
            els.boardLeftMarker.style.top = my + 'px';
            els.boardLeftMarker.style.display = 'flex';
            els.boardLeftMarker.classList.add('glow');
        }

        if (hasRight) {
            var mx, my;
            switch (last.dir) {
                case DIR_RIGHT: mx = last.pixelX + last.widthPx + 4; my = last.pixelY + (last.heightPx - 40) / 2; break;
                case DIR_LEFT: mx = last.pixelX - 44; my = last.pixelY + (last.heightPx - 40) / 2; break;
                case DIR_DOWN: mx = last.pixelX + (last.widthPx - 40) / 2; my = last.pixelY + last.heightPx + 4; break;
                case DIR_UP: mx = last.pixelX + (last.widthPx - 40) / 2; my = last.pixelY - 44; break;
                default: mx = last.pixelX + last.widthPx + 4; my = last.pixelY;
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
        var ai1Tiles = initialAI1Tiles.slice();
        var ai2Tiles = initialAI2Tiles.slice();
        var ai3Tiles = initialAI3Tiles.slice();

        var history = engine.hand.moveHistory;
        var end = Math.min(moveIndex, history.length - 1);

        for (var i = 0; i <= end; i++) {
            var move = history[i];
            if (move.pass) continue;

            board.place(move.tile, move.end, move.player);

            var tilesArr;
            if (move.player === 'human') tilesArr = humanTiles;
            else if (move.player === 'ai1') tilesArr = ai1Tiles;
            else if (move.player === 'ai2') tilesArr = ai2Tiles;
            else tilesArr = ai3Tiles;

            var idx = -1;
            for (var k = 0; k < tilesArr.length; k++) {
                if (tilesArr[k].id === move.tile.id) { idx = k; break; }
            }
            if (idx !== -1) tilesArr.splice(idx, 1);
        }

        return { board: board, humanTiles: humanTiles, ai1Tiles: ai1Tiles, ai2Tiles: ai2Tiles, ai3Tiles: ai3Tiles };
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
        renderAIHandFromState('ai1', state.ai1Tiles);
        renderAIHandFromState('ai2', state.ai2Tiles);
        renderAIHandFromState('ai3', state.ai3Tiles);

        var historyLen = engine.hand.moveHistory.length;
        var statusText = '';
        if (viewIndex === -1) {
            statusText = 'Reviewing: Initial deal';
        } else {
            var move = engine.hand.moveHistory[viewIndex];
            var who = engine.getPlayerLabel(move.player);
            if (move.pass) {
                statusText = 'Move ' + (viewIndex + 1) + '/' + historyLen + ': ' + who + ' passed';
            } else {
                statusText = 'Move ' + (viewIndex + 1) + '/' + historyLen + ': ' + who + ' played ' + move.tile.toString();
            }
        }

        els.statusMessage.innerHTML = statusText;
        els.statusMessage.classList.add('reviewing');
        els.passBtn.style.display = 'none';
        hideEndMarkers();
        updateNavButtons();
        updateUndoButton();
    }

    function exitReviewMode() {
        viewIndex = -1;
        isReviewing = false;
        els.statusMessage.classList.remove('reviewing');

        renderBoard();
        renderHumanHand();
        renderAIHand('ai1');
        renderAIHand('ai2');
        renderAIHand('ai3');
        updateNavButtons();

        if (engine.hand.currentPlayer === 'human') {
            startHumanTurn();
        } else {
            var label = engine.getPlayerLabel(engine.hand.currentPlayer);
            setStatus(label + ' is thinking...');
        }
    }

    function exitReviewToHandOver() {
        viewIndex = -1;
        isReviewing = false;
        els.statusMessage.classList.remove('reviewing');

        renderBoard();
        renderHumanHand();
        renderAIHandRevealed('ai1');
        renderAIHandRevealed('ai2');
        renderAIHandRevealed('ai3');

        els.navBackward.style.display = 'none';
        els.navForward.style.display = 'none';

        setStatus('Round over');
        els.resultOverlay.style.display = 'flex';
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

    // --- Review render helpers ---
    function renderHumanHandFromState(tiles) {
        els.humanHand.innerHTML = '';
        for (var i = 0; i < tiles.length; i++) {
            var el = createTileElement(tiles[i], false);
            el.classList.add('tile--disabled');
            els.humanHand.appendChild(el);
        }
        els.humanTileCount.textContent = '(' + tiles.length + ')';
    }

    function renderAIHandFromState(player, tiles) {
        var handEl = getAIHandEl(player);
        var countEl = getAICountEl(player);

        handEl.innerHTML = '';
        for (var i = 0; i < tiles.length; i++) {
            handEl.appendChild(createBackTile(player));
        }
        countEl.textContent = '(' + tiles.length + ')';
    }

    // ============================================================
    // Utils
    // ============================================================

    function updateScoreboard() {
        els.humanScore.textContent = engine.matchScore.human;
        els.ai1Score.textContent = engine.matchScore.ai1;
        els.ai2Score.textContent = engine.matchScore.ai2;
        els.ai3Score.textContent = engine.matchScore.ai3;
    }

    function setStatus(msg) {
        els.statusMessage.textContent = msg;
    }

    // ---- Init on DOM load ----
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})(window.Domino);
