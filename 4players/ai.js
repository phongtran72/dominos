// ============================================================
// ai.js — ENHANCED AI for 4-Player Dominos
//
// Strategic advantages over human:
//   1. Perfect tile tracking (knows exactly which tiles are unseen)
//   2. Bayesian inference (deduces opponent hands from pass events)
//   3. Endpoint locking (forces opponents to pass on values they lack)
//   4. Monte Carlo 3-ply lookahead (samples hands, simulates 3 turns)
//   5. Pass event analysis (extracts max info from each pass)
//   6. Chain detection (plan consecutive plays, keep hand connected)
//   7. Endgame urgency (prioritize going out when hand is small)
//   8. Kingmaker awareness (block the leader who's about to domino)
//   S4. Block steering (steer toward/away from blocks based on pip advantage)
//
// Coordinated mode (teamMode) — 3 cooperation strategies:
//   C1. Non-aggression pact (don't penalize partner)
//   C2. Squeeze enemies (focus all locking on opponents)
//   C3. Sacrifice for partner (help partner domino)
//
// Teams: Human+AI3 vs AI1+AI2
// Easy: random legal move
// Hard: full strategic engine with all advantages
// ============================================================

(function (D) {
    'use strict';

    // ============================================================
    // TileTracker4P — tracks all 28 tiles and deduces opponent hands
    // ============================================================
    class TileTracker4P {
        constructor(myPlayerId) {
            this.myPlayerId = myPlayerId;
            this.allTileIds = [];
            for (var i = 0; i <= 6; i++) {
                for (var j = i; j <= 6; j++) {
                    this.allTileIds.push(i + '-' + j);
                }
            }
            this.reset();
        }

        reset() {
            // Location of each tile: 'ai', 'board', 'unseen'
            this.tileLocation = {};
            for (var i = 0; i < this.allTileIds.length; i++) {
                this.tileLocation[this.allTileIds[i]] = 'unseen';
            }

            // Per-opponent tracking of values they definitely lack
            this.lacksValues = { human: {}, ai1: {}, ai2: {}, ai3: {} };

            // Track opponent hand sizes: starts at 7, decreases on plays
            this.opponentHandSizes = { human: 7, ai1: 7, ai2: 7, ai3: 7 };
        }

        // Mark AI's own tiles at hand start
        setAIHand(aiTiles) {
            for (var i = 0; i < aiTiles.length; i++) {
                this.tileLocation[aiTiles[i].id] = 'ai';
            }
        }

        // Any player played a tile
        onTilePlayed(playerId, tileId) {
            this.tileLocation[tileId] = 'board';
            // Decrement hand size for opponents (not for self)
            if (playerId !== this.myPlayerId && this.opponentHandSizes[playerId] !== undefined) {
                this.opponentHandSizes[playerId]--;
            }
        }

        // Player passed — they lack both board end values
        onPlayerPassed(playerId, boardEnds) {
            if (!this.lacksValues[playerId]) return;
            if (boardEnds.left !== null) {
                this.lacksValues[playerId][boardEnds.left] = true;
            }
            if (boardEnds.right !== null) {
                this.lacksValues[playerId][boardEnds.right] = true;
            }
        }

        // Get all unseen tile IDs
        getUnseenTiles() {
            var unseen = [];
            for (var i = 0; i < this.allTileIds.length; i++) {
                if (this.tileLocation[this.allTileIds[i]] === 'unseen') {
                    unseen.push(this.allTileIds[i]);
                }
            }
            return unseen;
        }

        // Tiles that COULD be in a specific player's hand
        getPossibleTilesForPlayer(playerId) {
            var unseen = this.getUnseenTiles();
            var lacks = this.lacksValues[playerId] || {};
            var possible = [];
            for (var i = 0; i < unseen.length; i++) {
                var parts = unseen[i].split('-');
                var low = parseInt(parts[0]);
                var high = parseInt(parts[1]);
                // If player lacks value X, they have NO tile containing X
                if (lacks[low] || lacks[high]) continue;
                possible.push(unseen[i]);
            }
            return possible;
        }

        // Does a specific player lack a value?
        playerLacks(playerId, value) {
            return !!(this.lacksValues[playerId] && this.lacksValues[playerId][value]);
        }

        // Does ANY enemy lack this value?
        anyEnemyLacks(enemies, value) {
            for (var i = 0; i < enemies.length; i++) {
                if (this.lacksValues[enemies[i]] && this.lacksValues[enemies[i]][value]) {
                    return true;
                }
            }
            return false;
        }

        // Do ALL enemies lack this value?
        allEnemiesLack(enemies, value) {
            for (var i = 0; i < enemies.length; i++) {
                if (!this.lacksValues[enemies[i]] || !this.lacksValues[enemies[i]][value]) {
                    return false;
                }
            }
            return true;
        }

        // Does ANY opponent (non-self) lack this value?
        anyOpponentLacks(value) {
            var players = D.PLAYERS;
            for (var i = 0; i < players.length; i++) {
                if (players[i] === this.myPlayerId) continue;
                if (this.lacksValues[players[i]] && this.lacksValues[players[i]][value]) {
                    return true;
                }
            }
            return false;
        }

        // Do ALL opponents lack this value?
        allOpponentsLack(value) {
            var players = D.PLAYERS;
            for (var i = 0; i < players.length; i++) {
                if (players[i] === this.myPlayerId) continue;
                if (!this.lacksValues[players[i]] || !this.lacksValues[players[i]][value]) {
                    return false;
                }
            }
            return true;
        }

        // Total number of inferred lacks across all opponents
        getTotalLackedValueCount() {
            var count = 0;
            var players = D.PLAYERS;
            for (var i = 0; i < players.length; i++) {
                if (players[i] === this.myPlayerId) continue;
                count += Object.keys(this.lacksValues[players[i]] || {}).length;
            }
            return count;
        }
    }

    // ============================================================
    // AIPlayer — Enhanced with tracking, inference, lookahead
    // ============================================================
    class AIPlayer {
        constructor(difficulty, playerId, teamMode) {
            this.difficulty = difficulty || 'easy';
            this.playerId = playerId; // 'ai1', 'ai2', or 'ai3'
            this.teamMode = !!teamMode;

            // Set up team relationships
            var teamInfo = D.TEAMS[playerId];
            this.partner = teamInfo.partner;
            this.enemies = teamInfo.enemies;

            this.tracker = new TileTracker4P(playerId);
        }

        // Rebuild tracker from complete move history
        // Advantage #5: Pass event analysis — extracts max info from each pass
        updateTracker(engine) {
            var hand = engine.hand;
            this.tracker.reset();
            this.tracker.setAIHand(engine.getHand(this.playerId).tiles);

            var history = hand.moveHistory;
            var boardEndsAtMove = { left: null, right: null };

            for (var i = 0; i < history.length; i++) {
                var move = history[i];

                if (move.pass) {
                    // Advantage #5: pass means player lacked BOTH board end values
                    this.tracker.onPlayerPassed(move.player, move.boardEnds || boardEndsAtMove);
                    continue;
                }

                // Regular play
                this.tracker.onTilePlayed(move.player, move.tile.id);

                // Update board ends after placement
                if (move.boardEnds) {
                    boardEndsAtMove = move.boardEnds;
                }
            }

            // Supplement from engine's passedValues
            var opponents = D.getOtherPlayers(this.playerId);
            for (var oi = 0; oi < opponents.length; oi++) {
                var opp = opponents[oi];
                var pv = hand.passedValues[opp] || [];
                for (var vi = 0; vi < pv.length; vi++) {
                    this.tracker.lacksValues[opp][pv[vi]] = true;
                }
            }
        }

        chooseMove(legalMoves, engine) {
            if (!legalMoves || legalMoves.length === 0) return null;
            if (legalMoves.length === 1) {
                return { move: legalMoves[0], bestScore: 0, depth: 0, nodes: 1, analysis: [] };
            }

            if (this.difficulty === 'easy') {
                var idx = Math.floor(Math.random() * legalMoves.length);
                return { move: legalMoves[idx], bestScore: 0, depth: 0, nodes: 1, analysis: [] };
            }

            // --- Hard: Full strategic engine ---

            // Advantage #1: Perfect tile tracking — rebuild from history
            this.updateTracker(engine);

            var hand = engine.hand;
            var myHand = engine.getHand(this.playerId);
            var board = hand.board;
            var opponents = D.getOtherPlayers(this.playerId);

            // Score each move with enhanced heuristics
            var scored = [];
            for (var i = 0; i < legalMoves.length; i++) {
                var m = legalMoves[i];
                var score = this.scoreMove(m, myHand, board, hand, opponents);
                scored.push({ move: m, score: score });
            }

            // Advantage #4: Monte Carlo 3-ply lookahead — ALWAYS run
            scored = this.applyLookahead(scored, engine);

            // Sort by score descending
            scored.sort(function (a, b) { return b.score - a.score; });

            // Build analysis array
            var analysis = scored.map(function (s) {
                return {
                    tileId: s.move.tile.id,
                    tileLow: s.move.tile.low,
                    tileHigh: s.move.tile.high,
                    end: s.move.end,
                    score: Math.round(s.score * 10) / 10
                };
            });

            return {
                move: scored[0].move,
                bestScore: scored[0].score,
                depth: 3,
                nodes: legalMoves.length,
                analysis: analysis
            };
        }

        scoreMove(move, myHand, board, hand, opponents) {
            var tile = move.tile;
            var end = move.end;
            var score = 0;
            var tracker = this.tracker;

            // Determine targets based on mode
            var targets = this.teamMode ? this.enemies : opponents;

            // === 1. Play heavy tiles first (reduce pip risk) ===
            score += tile.pipCount() * 1;

            // === 2. Play doubles early ===
            if (tile.isDouble()) {
                score += 5;
            }

            // === 3. Basic: exploit targets' passed values ===
            var newEnd = this.getNewBoardEnd(tile, end, board);
            if (newEnd !== null) {
                for (var oi = 0; oi < targets.length; oi++) {
                    var pv = hand.passedValues[targets[oi]] || [];
                    for (var vi = 0; vi < pv.length; vi++) {
                        if (newEnd === pv[vi]) {
                            score += 15;
                            if (this.teamMode) score += 12;
                            break;
                        }
                    }
                }
            }

            // === Advantage #3: Endpoint locking with Bayesian tracking ===
            if (newEnd !== null) {
                if (this.teamMode) {
                    // Lock out enemies only
                    if (tracker.anyEnemyLacks(this.enemies, newEnd)) {
                        score += 25;
                        score += 10; // Squeeze bonus
                    }
                    if (tracker.allEnemiesLack(this.enemies, newEnd)) {
                        score += 35;
                    }
                    // Double lock: both ends locked for enemies
                    var otherEnd = this.getOtherBoardEnd(end, board, tile);
                    if (otherEnd !== null &&
                        tracker.anyEnemyLacks(this.enemies, newEnd) &&
                        tracker.anyEnemyLacks(this.enemies, otherEnd)) {
                        score += 20;
                        score += 8; // Double squeeze
                    }
                } else {
                    // +25 if ANY opponent lacks this value
                    if (tracker.anyOpponentLacks(newEnd)) {
                        score += 25;
                    }
                    // +35 if ALL opponents lack this value
                    if (tracker.allOpponentsLack(newEnd)) {
                        score += 35;
                    }
                    // Double lock: BOTH board ends locked for at least one opponent
                    var otherEnd = this.getOtherBoardEnd(end, board, tile);
                    if (otherEnd !== null &&
                        tracker.anyOpponentLacks(newEnd) &&
                        tracker.anyOpponentLacks(otherEnd)) {
                        score += 20;
                    }
                }
            }

            // === 4. Flexibility: remaining hand matches board ends ===
            var remainingTiles = [];
            for (var i = 0; i < myHand.tiles.length; i++) {
                if (myHand.tiles[i] !== tile) remainingTiles.push(myHand.tiles[i]);
            }

            if (newEnd !== null) {
                var otherEnd = this.getOtherBoardEnd(end, board, tile);
                var matchCount = 0;
                for (var i = 0; i < remainingTiles.length; i++) {
                    if (remainingTiles[i].matches(newEnd)) matchCount++;
                    if (otherEnd !== null && otherEnd !== newEnd && remainingTiles[i].matches(otherEnd)) matchCount++;
                }
                score += matchCount * 3;
            }

            // === 5. Board end diversity ===
            if (newEnd !== null) {
                var otherEnd = this.getOtherBoardEnd(end, board, tile);
                if (otherEnd !== null && newEnd !== otherEnd) {
                    score += 4;
                }
            }

            // === 6. Suit dominance ===
            var suitCount = 0;
            var playedValue = (end === 'left') ?
                (board.isEmpty() ? null : board.leftEnd) :
                (board.isEmpty() ? null : board.rightEnd);
            if (playedValue !== null) {
                for (var i = 0; i < remainingTiles.length; i++) {
                    if (remainingTiles[i].matches(playedValue)) suitCount++;
                }
            }
            score += suitCount * 1;

            // === Advantage #1+2: Board scarcity exploitation ===
            if (newEnd !== null) {
                var knownTilesWithValue = 0;
                for (var v = 0; v <= 6; v++) {
                    var id = Math.min(newEnd, v) + '-' + Math.max(newEnd, v);
                    if (tracker.tileLocation[id] === 'ai' || tracker.tileLocation[id] === 'board') {
                        knownTilesWithValue++;
                    }
                }
                score += knownTilesWithValue * 2;
            }

            // === Advantage #2: Penalize ends where targets likely have tiles ===
            if (newEnd !== null) {
                if (this.teamMode) {
                    // Only count tiles that could be enemies'
                    var enemyMatchCount = 0;
                    for (var ei = 0; ei < this.enemies.length; ei++) {
                        var enemyPossible = tracker.getPossibleTilesForPlayer(this.enemies[ei]);
                        for (var ti = 0; ti < enemyPossible.length; ti++) {
                            var parts = enemyPossible[ti].split('-');
                            var lo = parseInt(parts[0]);
                            var hi = parseInt(parts[1]);
                            if (lo === newEnd || hi === newEnd) enemyMatchCount++;
                        }
                    }
                    score -= enemyMatchCount * 1.0;
                } else {
                    var unseenTiles = tracker.getUnseenTiles();
                    var opponentMatchCount = 0;
                    for (var ti = 0; ti < unseenTiles.length; ti++) {
                        var parts = unseenTiles[ti].split('-');
                        var lo = parseInt(parts[0]);
                        var hi = parseInt(parts[1]);
                        if (lo === newEnd || hi === newEnd) opponentMatchCount++;
                    }
                    score -= opponentMatchCount * 1.5;
                }
            }

            // === Advantage #8: Kingmaker Awareness (Block the Leader) ===
            if (newEnd !== null) {
                var kingmakerPenalty = 0;
                var kingTargets = targets;
                for (var oi = 0; oi < kingTargets.length; oi++) {
                    var opp = kingTargets[oi];
                    var oppCount = tracker.opponentHandSizes[opp];
                    if (oppCount <= 2) {
                        var canPlayNew = !tracker.playerLacks(opp, newEnd);
                        var otherEnd = this.getOtherBoardEnd(end, board, tile);
                        var canPlayOther = (otherEnd !== null) ? !tracker.playerLacks(opp, otherEnd) : false;

                        var dangerMult = (oppCount === 1) ? 18 : 8;
                        if (canPlayNew) kingmakerPenalty += dangerMult;
                        if (canPlayOther) kingmakerPenalty += dangerMult;
                    }
                }
                score -= kingmakerPenalty;
            }

            // === Strategy S4: Block Steering ===
            if (newEnd !== null && board.tiles.length >= 6) {
                var myPips = 0;
                for (var i = 0; i < remainingTiles.length; i++) {
                    myPips += remainingTiles[i].pipCount();
                }

                var avgPipPerTile = 5.5;
                var iWinBlock;
                if (this.teamMode) {
                    var partnerPips = tracker.opponentHandSizes[this.partner] * avgPipPerTile;
                    var myTeamPips = myPips + partnerPips;
                    var enemyPips = 0;
                    for (var ei = 0; ei < this.enemies.length; ei++) {
                        enemyPips += tracker.opponentHandSizes[this.enemies[ei]] * avgPipPerTile;
                    }
                    iWinBlock = (myTeamPips < enemyPips);
                } else {
                    var allLess = true;
                    for (var oi = 0; oi < opponents.length; oi++) {
                        var oppPips = tracker.opponentHandSizes[opponents[oi]] * avgPipPerTile;
                        if (myPips >= oppPips) { allLess = false; break; }
                    }
                    iWinBlock = allLess;
                }

                var unseenMatchingNewEnd = 0;
                var unseenAll = tracker.getUnseenTiles();
                for (var ui = 0; ui < unseenAll.length; ui++) {
                    var parts = unseenAll[ui].split('-');
                    var lo = parseInt(parts[0]);
                    var hi = parseInt(parts[1]);
                    if (lo === newEnd || hi === newEnd) unseenMatchingNewEnd++;
                }

                var otherEnd = this.getOtherBoardEnd(end, board, tile);
                var unseenMatchingOtherEnd = 0;
                if (otherEnd !== null) {
                    for (var ui = 0; ui < unseenAll.length; ui++) {
                        var parts = unseenAll[ui].split('-');
                        var lo = parseInt(parts[0]);
                        var hi = parseInt(parts[1]);
                        if (lo === otherEnd || hi === otherEnd) unseenMatchingOtherEnd++;
                    }
                }

                var tightness = Math.max(0, 6 - (unseenMatchingNewEnd + unseenMatchingOtherEnd));

                if (iWinBlock) {
                    score += tightness * 3;
                    if (tile.isDouble()) {
                        score -= 6;
                    }
                } else {
                    score -= tightness * 2;
                }
            }

            // === C3: Sacrifice for Partner (help partner domino) ===
            if (this.teamMode && newEnd !== null) {
                var partnerCount = tracker.opponentHandSizes[this.partner];
                if (partnerCount <= 3) {
                    var urgency = (partnerCount === 1) ? 15 : (partnerCount === 2) ? 10 : 6;
                    var otherEnd = this.getOtherBoardEnd(end, board, tile);

                    if (!tracker.playerLacks(this.partner, newEnd)) {
                        score += urgency;
                    }
                    if (tracker.playerLacks(this.partner, newEnd)) {
                        score -= urgency;
                    }
                    if (otherEnd !== null) {
                        if (!tracker.playerLacks(this.partner, otherEnd)) {
                            score += Math.floor(urgency / 2);
                        }
                    }
                }
            }

            // === 9. Hand coverage diversity ===
            if (remainingTiles.length > 0) {
                var valueCoverage = {};
                for (var i = 0; i < remainingTiles.length; i++) {
                    valueCoverage[remainingTiles[i].low] = true;
                    valueCoverage[remainingTiles[i].high] = true;
                }
                score += Object.keys(valueCoverage).length * 1;
            }

            // === Advantage #6: Chain detection ===
            if (newEnd !== null && remainingTiles.length > 0) {
                var chainScore = 0;
                var otherEnd = this.getOtherBoardEnd(end, board, tile);

                // Level 1: tiles that can play on newEnd
                for (var i = 0; i < remainingTiles.length; i++) {
                    if (remainingTiles[i].matches(newEnd)) {
                        var afterEnd = remainingTiles[i].otherSide(newEnd);
                        chainScore += 3;

                        // Level 2: tiles that can play after level-1 tile
                        for (var j = 0; j < remainingTiles.length; j++) {
                            if (j === i) continue;
                            if (remainingTiles[j].matches(afterEnd)) {
                                chainScore += 2;
                            }
                            if (otherEnd !== null && remainingTiles[j].matches(otherEnd)) {
                                chainScore += 1;
                            }
                        }
                    }
                }
                score += chainScore;
            }

            // === Advantage #7: Endgame urgency ===
            if (remainingTiles.length <= 3 && newEnd !== null) {
                var otherEnd = this.getOtherBoardEnd(end, board, tile);

                if (remainingTiles.length === 1) {
                    var lastTile = remainingTiles[0];
                    if (lastTile.matches(newEnd) || (otherEnd !== null && lastTile.matches(otherEnd))) {
                        score += 50; // massive bonus: guaranteed domino next turn!
                    } else {
                        score -= 15; // bad: stuck with unplayable tile
                    }
                }
                else if (remainingTiles.length === 2) {
                    var canChainOut = false;
                    for (var i = 0; i < 2; i++) {
                        var first = remainingTiles[i];
                        var second = remainingTiles[1 - i];
                        if (first.matches(newEnd)) {
                            var nextEnd = first.otherSide(newEnd);
                            if (second.matches(nextEnd) || (otherEnd !== null && second.matches(otherEnd))) {
                                canChainOut = true;
                            }
                        }
                        if (otherEnd !== null && first.matches(otherEnd)) {
                            var nextOther = first.otherSide(otherEnd);
                            if (second.matches(newEnd) || second.matches(nextOther)) {
                                canChainOut = true;
                            }
                        }
                    }
                    if (canChainOut) {
                        score += 30;
                    }
                }
                else if (remainingTiles.length === 3) {
                    var playableCount = 0;
                    for (var i = 0; i < remainingTiles.length; i++) {
                        if (remainingTiles[i].matches(newEnd) ||
                            (otherEnd !== null && remainingTiles[i].matches(otherEnd))) {
                            playableCount++;
                        }
                    }
                    score += playableCount * 8;
                }
            }

            return score;
        }

        // ============================================================
        // Advantage #4: Monte Carlo 3-ply Lookahead
        // Samples random opponent hands from unseen tiles,
        // simulates AI→NextPlayer→AI turns.
        // ============================================================
        applyLookahead(scored, engine) {
            var tracker = this.tracker;
            var SAMPLES = 25;
            var opponents = D.getOtherPlayers(this.playerId);
            var myHand = engine.getHand(this.playerId);
            var board = engine.hand.board;

            // Get sizes for all 3 opponents
            var oppSizes = {};
            var totalExpected = 0;
            for (var oi = 0; oi < opponents.length; oi++) {
                var size = tracker.opponentHandSizes[opponents[oi]];
                oppSizes[opponents[oi]] = size;
                totalExpected += size;
            }

            var unseenTiles = tracker.getUnseenTiles();

            // Skip if we can't form valid samples
            if (unseenTiles.length < totalExpected || totalExpected <= 0) {
                return scored;
            }

            for (var mi = 0; mi < scored.length; mi++) {
                var totalOutcome = 0;
                var validSamples = 0;

                for (var s = 0; s < SAMPLES; s++) {
                    // Fisher-Yates shuffle of unseen tiles
                    var shuffled = unseenTiles.slice();
                    for (var k = shuffled.length - 1; k > 0; k--) {
                        var j = Math.floor(Math.random() * (k + 1));
                        var tmp = shuffled[k]; shuffled[k] = shuffled[j]; shuffled[j] = tmp;
                    }

                    // Assign tiles to each opponent respecting their known lacks
                    var sampledHands = {};
                    var remaining = shuffled.slice();

                    var allValid = true;
                    for (var oi = 0; oi < opponents.length; oi++) {
                        var opp = opponents[oi];
                        var size = oppSizes[opp];
                        var sampled = [];
                        var leftover = [];

                        for (var ti = 0; ti < remaining.length; ti++) {
                            var tileId = remaining[ti];
                            var parts = tileId.split('-');
                            var lo = parseInt(parts[0]);
                            var hi = parseInt(parts[1]);
                            if (sampled.length < size &&
                                !tracker.playerLacks(opp, lo) && !tracker.playerLacks(opp, hi)) {
                                sampled.push(tileId);
                            } else {
                                leftover.push(tileId);
                            }
                        }

                        if (sampled.length < Math.max(1, size - 2)) {
                            allValid = false;
                            break;
                        }

                        sampledHands[opp] = sampled;
                        remaining = leftover;
                    }

                    if (!allValid) continue;

                    // Find next player after this AI in turn order
                    var nextPlayer = D.getNextPlayer(this.playerId);

                    var outcome = this.simulate3Ply(
                        scored[mi].move, sampledHands, nextPlayer, myHand, board
                    );
                    totalOutcome += outcome;
                    validSamples++;
                }

                if (validSamples > 0) {
                    scored[mi].score += (totalOutcome / validSamples) * 5;
                }
            }

            return scored;
        }

        // ============================================================
        // 3-ply simulation: AI plays → Next player responds → AI responds
        // Returns a score for the resulting position.
        // ============================================================
        simulate3Ply(aiMove, sampledHands, nextPlayerId, myHand, board) {
            var tile = aiMove.tile;
            var end = aiMove.end;
            var tracker = this.tracker;

            // --- Ply 1: AI plays ---
            var newEnd = this.getNewBoardEnd(tile, end, board);
            var otherEnd = this.getOtherBoardEnd(end, board, tile);
            if (newEnd === null) return 0;

            // Board ends after AI plays
            var leftEnd1, rightEnd1;
            if (end === 'left') {
                leftEnd1 = newEnd;
                rightEnd1 = (board.isEmpty()) ? tile.high : board.rightEnd;
            } else {
                leftEnd1 = (board.isEmpty()) ? tile.low : board.leftEnd;
                rightEnd1 = newEnd;
            }

            // AI remaining tiles
            var aiRemaining = [];
            for (var i = 0; i < myHand.tiles.length; i++) {
                if (myHand.tiles[i] !== tile) aiRemaining.push(myHand.tiles[i]);
            }

            // Next opponent to model
            var nextOppHand = sampledHands[nextPlayerId] || [];
            var isEnemy = this.teamMode && this.enemies.indexOf(nextPlayerId) !== -1;

            // --- Ply 2: Next player responds ---
            var oppPlayable = [];
            for (var i = 0; i < nextOppHand.length; i++) {
                var parts = nextOppHand[i].split('-');
                var lo = parseInt(parts[0]);
                var hi = parseInt(parts[1]);
                var pips = lo + hi;
                if (lo === leftEnd1 || hi === leftEnd1) {
                    var oNewEnd = (hi === leftEnd1) ? lo : hi;
                    oppPlayable.push({ idx: i, lo: lo, hi: hi, pips: pips, end: 'left', newLeft: oNewEnd, newRight: rightEnd1 });
                }
                if (lo === rightEnd1 || hi === rightEnd1) {
                    var oNewEnd = (lo === rightEnd1) ? hi : lo;
                    oppPlayable.push({ idx: i, lo: lo, hi: hi, pips: pips, end: 'right', newLeft: leftEnd1, newRight: oNewEnd });
                }
            }

            // Opponent can't play — must pass
            if (oppPlayable.length === 0) {
                var aiOptions = 0;
                for (var i = 0; i < aiRemaining.length; i++) {
                    if (aiRemaining[i].matches(leftEnd1) || aiRemaining[i].matches(rightEnd1)) aiOptions++;
                }
                if (isEnemy) {
                    return 10 + aiOptions * 2; // Enemy stuck = very good
                }
                return 8 + aiOptions * 2;
            }

            // Opponent picks their best response:
            // If enemy: minimize AI's options (adversarial)
            // If partner: maximize AI's options (cooperative)
            var bestOppMove = null;
            var bestOppScore = isEnemy ? Infinity : -Infinity;

            for (var h = 0; h < oppPlayable.length; h++) {
                var op = oppPlayable[h];
                var aiOpts = 0;
                for (var i = 0; i < aiRemaining.length; i++) {
                    if (aiRemaining[i].matches(op.newLeft) || aiRemaining[i].matches(op.newRight)) aiOpts++;
                }

                if (isEnemy) {
                    // Adversarial: pick move that minimizes AI options
                    if (aiOpts < bestOppScore || (aiOpts === bestOppScore && (!bestOppMove || op.pips > bestOppMove.pips))) {
                        bestOppScore = aiOpts;
                        bestOppMove = op;
                    }
                } else {
                    // Cooperative (partner): pick move that maximizes AI options
                    if (aiOpts > bestOppScore || (aiOpts === bestOppScore && (!bestOppMove || op.pips > bestOppMove.pips))) {
                        bestOppScore = aiOpts;
                        bestOppMove = op;
                    }
                }
            }

            if (!bestOppMove) return 0;

            var leftEnd2 = bestOppMove.newLeft;
            var rightEnd2 = bestOppMove.newRight;

            // --- Ply 3: AI responds ---
            var aiPlayable = [];
            for (var i = 0; i < aiRemaining.length; i++) {
                if (aiRemaining[i].matches(leftEnd2)) {
                    var aNewEnd = aiRemaining[i].otherSide(leftEnd2);
                    aiPlayable.push({ tile: aiRemaining[i], end: 'left', newLeft: aNewEnd, newRight: rightEnd2 });
                }
                if (aiRemaining[i].matches(rightEnd2)) {
                    var aNewEnd = aiRemaining[i].otherSide(rightEnd2);
                    aiPlayable.push({ tile: aiRemaining[i], end: 'right', newLeft: leftEnd2, newRight: aNewEnd });
                }
            }

            // AI can't respond — bad
            if (aiPlayable.length === 0) {
                return -6;
            }

            // AI picks the move that maximizes future options
            var bestAIScore = -Infinity;
            for (var a = 0; a < aiPlayable.length; a++) {
                var ap = aiPlayable[a];
                var futureOpts = 0;
                var aiAfter = [];
                for (var i = 0; i < aiRemaining.length; i++) {
                    if (aiRemaining[i] !== ap.tile) {
                        aiAfter.push(aiRemaining[i]);
                        if (aiRemaining[i].matches(ap.newLeft) || aiRemaining[i].matches(ap.newRight)) {
                            futureOpts++;
                        }
                    }
                }

                // Count opponent threats
                var oppThreats = 0;
                for (var i = 0; i < nextOppHand.length; i++) {
                    if (i === bestOppMove.idx) continue;
                    var parts = nextOppHand[i].split('-');
                    var lo = parseInt(parts[0]);
                    var hi = parseInt(parts[1]);
                    if (lo === ap.newLeft || hi === ap.newLeft || lo === ap.newRight || hi === ap.newRight) {
                        oppThreats++;
                    }
                }

                var moveScore = futureOpts * 2 - oppThreats * 1 + ap.tile.pipCount() * 0.3;

                // Endgame: about to go out?
                if (aiAfter.length === 0) {
                    moveScore += 20; // domino!
                } else if (aiAfter.length === 1) {
                    if (aiAfter[0].matches(ap.newLeft) || aiAfter[0].matches(ap.newRight)) {
                        moveScore += 10;
                    }
                }

                if (moveScore > bestAIScore) bestAIScore = moveScore;
            }

            // Final position score
            var oppRemaining = nextOppHand.length - 1;
            var tileAdvantage = (oppRemaining - (aiRemaining.length - 1)) * 2;
            return bestAIScore + tileAdvantage;
        }

        getNewBoardEnd(tile, end, board) {
            if (board.isEmpty()) {
                return (end === 'left') ? tile.low : tile.high;
            }
            if (end === 'left') {
                var matchVal = board.leftEnd;
                if (tile.high === matchVal) return tile.low;
                if (tile.low === matchVal) return tile.high;
            } else {
                var matchVal = board.rightEnd;
                if (tile.low === matchVal) return tile.high;
                if (tile.high === matchVal) return tile.low;
            }
            return null;
        }

        getOtherBoardEnd(end, board, tile) {
            if (board.isEmpty()) {
                return (end === 'left') ? tile.high : tile.low;
            }
            if (end === 'left') {
                return board.rightEnd;
            } else {
                return board.leftEnd;
            }
        }
    }

    D.AIPlayer = AIPlayer;

})(window.Domino);
