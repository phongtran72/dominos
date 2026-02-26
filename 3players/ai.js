// ============================================================
// ai.js — ENHANCED AI for 3-Player Dominos
//
// 7 strategic advantages over human:
//   1. Perfect tile tracking (knows exactly which tiles are unseen)
//   2. Bayesian inference (deduces opponent hands from pass events)
//   3. Endpoint locking (forces opponents to pass on values they lack)
//   4. Determinization (Monte Carlo sampling of possible hands)
//   5. Pass event analysis (extracts max info from each pass)
//   8. Kingmaker awareness (block the leader who's about to domino)
//   S4. Block steering (steer toward/away from blocks based on pip advantage)
//
// Coordinated mode (teamMode) — 3 cooperation strategies:
//   C1. Non-aggression pact (don't penalize partner)
//   C2. Squeeze the human (focus all locking on human)
//   C3. Sacrifice for partner (help partner domino)
//
// Easy: random legal move
// Hard: full strategic engine with all advantages
// ============================================================

(function (D) {
    'use strict';

    // ============================================================
    // TileTracker3P — tracks all 27 tiles and deduces opponent hands
    // ============================================================
    class TileTracker3P {
        constructor(myPlayerId) {
            this.myPlayerId = myPlayerId;
            this.allTileIds = [];
            for (var i = 0; i <= 6; i++) {
                for (var j = i; j <= 6; j++) {
                    if (i === 0 && j === 0) continue; // no [0|0] in 3P
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
            this.lacksValues = { human: {}, ai1: {}, ai2: {} };

            // Track opponent hand sizes: starts at 9, decreases on plays
            this.opponentHandSizes = { human: 9, ai1: 9, ai2: 9 };
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

        // Does ANY opponent lack this value?
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
    // AIPlayer — Enhanced with tracking, inference, determinization
    // ============================================================
    class AIPlayer {
        constructor(difficulty, playerId, teamMode) {
            this.difficulty = difficulty || 'easy';
            this.playerId = playerId; // 'ai1' or 'ai2'
            this.teamMode = !!teamMode;
            this.partner = (playerId === 'ai1') ? 'ai2' : 'ai1';
            this.enemy = 'human';
            this.tracker = new TileTracker3P(playerId);
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
                    // Use move.boardEnds directly (recorded by game.js at pass time)
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

            // Advantage #4: Determinization — Monte Carlo sampling
            if (this.tracker.getTotalLackedValueCount() >= 1) {
                scored = this.applyDeterminization(scored, engine);
            }

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
                depth: 1,
                nodes: legalMoves.length,
                analysis: analysis
            };
        }

        scoreMove(move, myHand, board, hand, opponents) {
            var tile = move.tile;
            var end = move.end;
            var score = 0;
            var tracker = this.tracker;

            // === 1. Play heavy tiles first (reduce pip risk) ===
            score += tile.pipCount() * 2;

            // === 2. Play doubles early ===
            if (tile.isDouble()) {
                score += 8;
            }

            // === 3. Basic: exploit opponents' passed values ===
            // C1: In team mode, only exploit human's passed values
            var newEnd = this.getNewBoardEnd(tile, end, board);
            if (newEnd !== null) {
                var targets = this.teamMode ? [this.enemy] : opponents;
                for (var oi = 0; oi < targets.length; oi++) {
                    var pv = hand.passedValues[targets[oi]] || [];
                    for (var vi = 0; vi < pv.length; vi++) {
                        if (newEnd === pv[vi]) {
                            score += 15;
                            // C2: Extra squeeze bonus when targeting human
                            if (this.teamMode) score += 12;
                            break;
                        }
                    }
                }
            }

            // === Advantage #3: Endpoint locking with Bayesian tracking ===
            // C1: In team mode, only lock out human (not partner)
            if (newEnd !== null) {
                if (this.teamMode) {
                    // Only care about human lacking values
                    if (tracker.playerLacks(this.enemy, newEnd)) {
                        score += 25;
                        // C2: Extra squeeze — human is the sole target
                        score += 10;
                    }
                    // Double lock: both ends locked for human
                    var otherEnd = this.getOtherBoardEnd(end, board, tile);
                    if (otherEnd !== null &&
                        tracker.playerLacks(this.enemy, newEnd) &&
                        tracker.playerLacks(this.enemy, otherEnd)) {
                        score += 20;
                        // C2: Double squeeze bonus
                        score += 8;
                    }
                } else {
                    // +25 if ANY opponent lacks this value
                    if (tracker.anyOpponentLacks(newEnd)) {
                        score += 25;
                    }
                    // +35 if ALL opponents lack this value (devastating complete lock)
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
            // If many tiles of a suit are in AI hand or on board,
            // leaving that value on the board is hard for opponents
            if (newEnd !== null) {
                var knownTilesWithValue = 0;
                for (var v = 0; v <= 6; v++) {
                    var id = Math.min(newEnd, v) + '-' + Math.max(newEnd, v);
                    if (id === '0-0') continue; // doesn't exist in 3P
                    if (tracker.tileLocation[id] === 'ai' || tracker.tileLocation[id] === 'board') {
                        knownTilesWithValue++;
                    }
                }
                score += knownTilesWithValue * 2;
            }

            // === Advantage #2: Penalize ends where opponents likely have tiles ===
            // C1: In team mode, only count tiles that could be human's (not partner's)
            if (newEnd !== null) {
                if (this.teamMode) {
                    var humanPossible = tracker.getPossibleTilesForPlayer(this.enemy);
                    var humanMatchCount = 0;
                    for (var ti = 0; ti < humanPossible.length; ti++) {
                        var parts = humanPossible[ti].split('-');
                        var lo = parseInt(parts[0]);
                        var hi = parseInt(parts[1]);
                        if (lo === newEnd || hi === newEnd) humanMatchCount++;
                    }
                    score -= humanMatchCount * 1.5;
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
            // If an opponent has very few tiles left, strongly penalize leaving playable ends for them.
            // C1: In team mode, only penalize for HUMAN approaching domino (partner domino is a win).
            if (newEnd !== null) {
                var kingmakerPenalty = 0;
                var kingTargets = this.teamMode ? [this.enemy] : opponents;
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

            // === Strategy #4: Block Steering (per-AI individual) ===
            // If a block favors this AI (lowest pips), steer toward it.
            // If a block doesn't favor this AI, avoid it.
            // C1: In team mode, check if EITHER AI wins the block (team wins).
            if (newEnd !== null && board.tiles.length >= 6) {
                // Estimate pip counts
                var myPips = 0;
                for (var i = 0; i < remainingTiles.length; i++) {
                    myPips += remainingTiles[i].pipCount();
                }

                // Estimate opponents' pips from hand sizes and game average
                var avgPipPerTile = 5.5;
                var humanPips = tracker.opponentHandSizes[this.enemy] * avgPipPerTile;
                var partnerPips = tracker.opponentHandSizes[this.partner] * avgPipPerTile;
                var iWinBlock;
                if (this.teamMode) {
                    // Team wins if either AI has fewer pips than human
                    iWinBlock = (myPips < humanPips) || (partnerPips < humanPips);
                } else {
                    var opp1Pips = tracker.opponentHandSizes[opponents[0]] * avgPipPerTile;
                    var opp2Pips = tracker.opponentHandSizes[opponents[1]] * avgPipPerTile;
                    iWinBlock = (myPips < opp1Pips && myPips < opp2Pips);
                }

                // Count how many unseen tiles can match the new end value
                // Fewer matching unseen tiles = board end is harder to play on = closer to block
                var unseenMatchingNewEnd = 0;
                var unseenAll = tracker.getUnseenTiles();
                for (var ui = 0; ui < unseenAll.length; ui++) {
                    var parts = unseenAll[ui].split('-');
                    var lo = parseInt(parts[0]);
                    var hi = parseInt(parts[1]);
                    if (lo === newEnd || hi === newEnd) unseenMatchingNewEnd++;
                }

                // Also check the other end
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

                // "Board tightness" = how few unseen tiles match either end
                // Lower = tighter = closer to block
                var tightness = Math.max(0, 6 - (unseenMatchingNewEnd + unseenMatchingOtherEnd));

                if (iWinBlock) {
                    // Block favors us: bonus for tight board positions
                    score += tightness * 3;
                    // Penalize playing doubles (doubles open the board with matching values)
                    if (tile.isDouble()) {
                        score -= 6;
                    }
                } else {
                    // Block doesn't favor us: penalize tight positions, prefer open board
                    score -= tightness * 2;
                }
            }

            // === C3: Sacrifice for Partner (help partner domino) ===
            // When partner has few tiles, keep endpoints they can likely play on.
            if (this.teamMode && newEnd !== null) {
                var partnerCount = tracker.opponentHandSizes[this.partner];
                if (partnerCount <= 3) {
                    var urgency = (partnerCount === 1) ? 15 : (partnerCount === 2) ? 10 : 6;
                    var otherEnd = this.getOtherBoardEnd(end, board, tile);

                    // Bonus for endpoints partner can play on
                    if (!tracker.playerLacks(this.partner, newEnd)) {
                        score += urgency;
                    }
                    // Penalty for endpoints partner definitely can't play on
                    if (tracker.playerLacks(this.partner, newEnd)) {
                        score -= urgency;
                    }
                    // Also consider the other end for partner
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

            return score;
        }

        // ============================================================
        // Advantage #4: Determinization — Monte Carlo sampling
        // Sample N random consistent opponent hands, simulate each,
        // and adjust move scores based on average outcomes
        // ============================================================
        applyDeterminization(scored, engine) {
            var tracker = this.tracker;
            var SAMPLES = 25;
            var opponents = D.getOtherPlayers(this.playerId);
            var opp1 = opponents[0];
            var opp2 = opponents[1];

            var opp1Size = tracker.opponentHandSizes[opp1];
            var opp2Size = tracker.opponentHandSizes[opp2];
            var totalExpected = opp1Size + opp2Size;

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

                    // Assign to opp1 (respecting their known lacks)
                    var sampledOpp1 = [];
                    var remaining = [];
                    for (var ti = 0; ti < shuffled.length; ti++) {
                        var tileId = shuffled[ti];
                        var parts = tileId.split('-');
                        var lo = parseInt(parts[0]);
                        var hi = parseInt(parts[1]);
                        if (sampledOpp1.length < opp1Size &&
                            !tracker.playerLacks(opp1, lo) && !tracker.playerLacks(opp1, hi)) {
                            sampledOpp1.push(tileId);
                        } else {
                            remaining.push(tileId);
                        }
                    }

                    // Assign to opp2 from remaining (respecting their known lacks)
                    var sampledOpp2 = [];
                    for (var ti = 0; ti < remaining.length && sampledOpp2.length < opp2Size; ti++) {
                        var tileId = remaining[ti];
                        var parts = tileId.split('-');
                        var lo = parseInt(parts[0]);
                        var hi = parseInt(parts[1]);
                        if (!tracker.playerLacks(opp2, lo) && !tracker.playerLacks(opp2, hi)) {
                            sampledOpp2.push(tileId);
                        }
                    }

                    // Only count samples where we could fill both hands reasonably
                    if (sampledOpp1.length >= Math.max(1, opp1Size - 2) &&
                        sampledOpp2.length >= Math.max(1, opp2Size - 2)) {
                        var outcome = this.evaluateMoveInWorld(
                            scored[mi].move, sampledOpp1, sampledOpp2, engine.hand.board
                        );
                        totalOutcome += outcome;
                        validSamples++;
                    }
                }

                if (validSamples > 0) {
                    scored[mi].score += (totalOutcome / validSamples) * 3;
                }
            }

            return scored;
        }

        // Evaluate a move in a simulated world with two opponent hands
        // In determinization, opp1 = opponents[0], opp2 = opponents[1]
        // In team mode: opponents = [human, partner] (from getOtherPlayers)
        evaluateMoveInWorld(move, sampledOpp1Hand, sampledOpp2Hand, board) {
            var newEnd = this.getNewBoardEnd(move.tile, move.end, board);
            var otherEnd = this.getOtherBoardEnd(move.end, board, move.tile);

            if (newEnd === null) return 0;

            // Check if each opponent can respond to the new board state
            var opp1CanPlay = false;
            var opp2CanPlay = false;

            for (var i = 0; i < sampledOpp1Hand.length; i++) {
                var parts = sampledOpp1Hand[i].split('-');
                var lo = parseInt(parts[0]);
                var hi = parseInt(parts[1]);
                if (lo === newEnd || hi === newEnd || lo === otherEnd || hi === otherEnd) {
                    opp1CanPlay = true;
                    break;
                }
            }

            for (var i = 0; i < sampledOpp2Hand.length; i++) {
                var parts = sampledOpp2Hand[i].split('-');
                var lo = parseInt(parts[0]);
                var hi = parseInt(parts[1]);
                if (lo === newEnd || hi === newEnd || lo === otherEnd || hi === otherEnd) {
                    opp2CanPlay = true;
                    break;
                }
            }

            if (this.teamMode) {
                // In team mode, opponents[] order: first is human, second might be partner
                // (getOtherPlayers returns both non-self players)
                // We want: human blocked = great, partner blocked = bad
                var opponents = D.getOtherPlayers(this.playerId);
                var humanIdx = (opponents[0] === this.enemy) ? 0 : 1;
                var humanCanPlay = (humanIdx === 0) ? opp1CanPlay : opp2CanPlay;
                var partnerCanPlay = (humanIdx === 0) ? opp2CanPlay : opp1CanPlay;

                if (!humanCanPlay && partnerCanPlay) return 8;  // Ideal: human stuck, partner plays
                if (!humanCanPlay && !partnerCanPlay) return 3; // Both stuck: block, but not ideal
                if (humanCanPlay && partnerCanPlay) return 0;   // Normal play
                if (humanCanPlay && !partnerCanPlay) return -3;  // Bad: partner stuck, human plays
                return 0;
            }

            // Independent mode (original logic)
            // Neither can respond — near-block position, very strong
            if (!opp1CanPlay && !opp2CanPlay) return 8;

            // One can't respond — decent
            if (!opp1CanPlay || !opp2CanPlay) return 3;

            // Both can respond — evaluate minimum pip cost of their responses
            var minOppPips = Infinity;
            var combined = sampledOpp1Hand.concat(sampledOpp2Hand);
            for (var i = 0; i < combined.length; i++) {
                var parts = combined[i].split('-');
                var lo = parseInt(parts[0]);
                var hi = parseInt(parts[1]);
                if (lo === newEnd || hi === newEnd || lo === otherEnd || hi === otherEnd) {
                    var pips = lo + hi;
                    if (pips < minOppPips) minOppPips = pips;
                }
            }

            return (minOppPips - 5) * 0.3;
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
