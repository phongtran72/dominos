// ============================================================
// ai.js — ENHANCED AI for Draw Variant (Imperfect Information)
//
// DROP-IN REPLACEMENT for 2players/ai.js
//
// Advantages over human:
//   1. Perfect tile tracking (knows exactly which tiles are unseen)
//   2. Bayesian inference (deduces opponent hand from draw/pass events)
//   3. Endpoint locking (forces opponent to draw on values they lack)
//   4. Determinization (Monte Carlo sampling of possible opponent hands)
//   5. Draw event analysis (extracts max info from each draw cycle)
//
// Easy: random legal move
// Hard: full strategic engine with all advantages
// ============================================================

(function (D) {
    'use strict';

    // ============================================================
    // TileTracker — tracks all 28 tiles and deduces opponent hand
    // ============================================================
    class TileTracker {
        constructor() {
            // Build the full tile set (28 tiles: [0|0] through [6|6])
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
            // 'unseen' = could be in human hand OR boneyard
            this.tileLocation = {};
            for (var i = 0; i < this.allTileIds.length; i++) {
                this.tileLocation[this.allTileIds[i]] = 'unseen';
            }

            // Values the human definitely CANNOT have (from passes before draws)
            this.humanLacksValues = {};  // { 3: true, 5: true } = human has no 3s or 5s

            // Count of tiles the human has drawn (to estimate hand size)
            this.humanDrawCount = 0;

            // Track human's initial hand size (9) + draws - plays
            this.humanHandSize = 9;

            // Board end values when human last passed/drew
            this.humanPassedOnEnds = []; // [[leftEnd, rightEnd], ...]
        }

        // Call at start of hand — mark AI's own tiles
        setAIHand(aiTiles) {
            for (var i = 0; i < aiTiles.length; i++) {
                this.tileLocation[aiTiles[i].id] = 'ai';
            }
        }

        // Call when any tile is played on the board
        onTilePlayed(tileId) {
            this.tileLocation[tileId] = 'board';
        }

        // Call when human plays a tile
        onHumanPlayed(tileId) {
            this.tileLocation[tileId] = 'board';
            this.humanHandSize--;
        }

        // Call when AI plays a tile
        onAIPlayed(tileId) {
            this.tileLocation[tileId] = 'board';
        }

        // Call when human draws from boneyard (AI doesn't know WHAT they drew)
        onHumanDrew() {
            this.humanDrawCount++;
            this.humanHandSize++;
        }

        // Call when human tried to play but couldn't (before drawing)
        // boardEnds = { left: X, right: Y }
        onHumanCouldntPlay(boardEnds) {
            // Human has NO tiles matching either board end
            if (boardEnds.left !== null) {
                this.humanLacksValues[boardEnds.left] = true;
            }
            if (boardEnds.right !== null) {
                this.humanLacksValues[boardEnds.right] = true;
            }
            this.humanPassedOnEnds.push([boardEnds.left, boardEnds.right]);
        }

        // Call when human passes (boneyard empty)
        onHumanPassed(boardEnds) {
            if (boardEnds.left !== null) {
                this.humanLacksValues[boardEnds.left] = true;
            }
            if (boardEnds.right !== null) {
                this.humanLacksValues[boardEnds.right] = true;
            }
        }

        // Get all tiles whose location is 'unseen'
        getUnseenTiles() {
            var unseen = [];
            for (var i = 0; i < this.allTileIds.length; i++) {
                if (this.tileLocation[this.allTileIds[i]] === 'unseen') {
                    unseen.push(this.allTileIds[i]);
                }
            }
            return unseen;
        }

        // Get tiles that COULD be in human's hand (unseen AND not eliminated)
        getPossibleHumanTiles() {
            var unseen = this.getUnseenTiles();
            var possible = [];
            var self = this;
            for (var i = 0; i < unseen.length; i++) {
                var parts = unseen[i].split('-');
                var low = parseInt(parts[0]);
                var high = parseInt(parts[1]);
                // A tile is impossible for human if BOTH its values are in humanLacksValues
                // Wait — a tile matches a value if EITHER side matches.
                // Human lacks value X means human has no tile where low==X or high==X
                // So if humanLacksValues[low] AND humanLacksValues[high], human can't have it
                // But if only one side is lacking, human COULD have the tile
                // Actually: humanLacksValues means human has NO tile matching that value.
                // So if humanLacksValues[low]=true, then human has NO tile with low or high == low.
                // This means any tile containing that value is impossible for human.
                var eliminated = false;
                if (self.humanLacksValues[low]) eliminated = true;
                if (self.humanLacksValues[high]) eliminated = true;
                if (!eliminated) {
                    possible.push(unseen[i]);
                }
            }
            return possible;
        }

        // Get tiles that are impossible for human (for boneyard deduction)
        getImpossibleForHuman() {
            var unseen = this.getUnseenTiles();
            var impossible = [];
            var self = this;
            for (var i = 0; i < unseen.length; i++) {
                var parts = unseen[i].split('-');
                var low = parseInt(parts[0]);
                var high = parseInt(parts[1]);
                if (self.humanLacksValues[low] || self.humanLacksValues[high]) {
                    impossible.push(unseen[i]);
                }
            }
            return impossible;
        }

        // Probability that a specific unseen tile is in human's hand
        getTileInHumanHandProbability(tileId) {
            if (this.tileLocation[tileId] !== 'unseen') return 0;

            var parts = tileId.split('-');
            var low = parseInt(parts[0]);
            var high = parseInt(parts[1]);

            // If human lacks either value, probability is 0
            if (this.humanLacksValues[low] || this.humanLacksValues[high]) {
                return 0;
            }

            // Among possible human tiles, probability based on hand size
            var possibleTiles = this.getPossibleHumanTiles();
            if (possibleTiles.length === 0) return 0;

            // Human has humanHandSize tiles, spread across possibleTiles.length candidates
            var prob = Math.min(1, this.humanHandSize / possibleTiles.length);
            return prob;
        }

        // How many values does the human definitely lack?
        getHumanLackedValueCount() {
            return Object.keys(this.humanLacksValues).length;
        }

        // Does human lack a specific value?
        humanLacks(value) {
            return !!this.humanLacksValues[value];
        }
    }

    // ============================================================
    // AIPlayer — Enhanced with tracking and inference
    // ============================================================
    class AIPlayer {
        constructor(difficulty) {
            this.difficulty = difficulty || 'easy';
            this.tracker = new TileTracker();
        }

        // Call this at the start of each hand to initialize tracking
        initHand(engine) {
            this.tracker.reset();
            this.tracker.setAIHand(engine.hand.aiHand.tiles);
        }

        // Update tracker from move history (call before each AI decision)
        updateTracker(engine) {
            var hand = engine.hand;
            this.tracker.reset();
            this.tracker.setAIHand(hand.aiHand.tiles);

            // Replay move history to build complete tracking state
            var history = hand.moveHistory;
            var boardEndsAtMove = { left: null, right: null };

            for (var i = 0; i < history.length; i++) {
                var move = history[i];

                if (move.draw) {
                    // Draw event
                    if (move.player === 'human') {
                        this.tracker.onHumanDrew();
                        // The tile drawn is now known (it's in moveHistory)
                        // But we mark it as played on board since it was drawn then possibly played
                    } else {
                        // AI drew — we know the tile (it's in our hand now or was played)
                        this.tracker.tileLocation[move.tile.id] = 'ai';
                    }
                    continue;
                }

                if (move.pass) {
                    if (move.player === 'human') {
                        this.tracker.onHumanPassed(boardEndsAtMove);
                    }
                    continue;
                }

                // Regular play
                if (move.player === 'human') {
                    // Check: was this tile just drawn? (previous move was a human draw)
                    var wasDraw = false;
                    if (i > 0 && history[i - 1].draw && history[i - 1].player === 'human') {
                        wasDraw = true;
                    }

                    // Before the human played, if they had to draw first, they lacked the
                    // board end values at that point
                    // (This is handled by draw events in the UI calling onHumanCouldntPlay)

                    this.tracker.onHumanPlayed(move.tile.id);
                } else {
                    this.tracker.onAIPlayed(move.tile.id);
                }

                // Update board ends after this move
                if (move.boardEnds) {
                    boardEndsAtMove = move.boardEnds;
                }
            }

            // Also track from opponentPassedValues (the engine tracks these)
            var humanPassedValues = hand.opponentPassedValues.human || [];
            for (var i = 0; i < humanPassedValues.length; i++) {
                this.tracker.humanLacksValues[humanPassedValues[i]] = true;
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

            // Step 1: Update tracker from game history
            this.updateTracker(engine);

            var hand = engine.hand;
            var aiHand = hand.aiHand;
            var board = hand.board;
            var boneyard = hand.boneyard || [];
            var opponentPassedValues = hand.opponentPassedValues.human || [];

            // Step 2: Score each move with enhanced heuristics
            var scored = [];
            for (var i = 0; i < legalMoves.length; i++) {
                var m = legalMoves[i];
                var score = this.scoreMove(m, aiHand, board, opponentPassedValues, boneyard);
                scored.push({ move: m, score: score });
            }

            // Step 3: Determinization boost (if enough info)
            if (this.tracker.getHumanLackedValueCount() >= 1) {
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

        scoreMove(move, aiHand, board, opponentPassedValues, boneyard) {
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

            // === 3. Exploit opponent's passed values (basic) ===
            var newEnd = this.getNewBoardEnd(tile, end, board);
            if (newEnd !== null) {
                for (var i = 0; i < opponentPassedValues.length; i++) {
                    if (newEnd === opponentPassedValues[i]) {
                        score += 15;
                    }
                }
            }

            // === 4. ENHANCED: Endpoint locking with Bayesian tracking ===
            // If tracker knows human lacks a value, MASSIVE bonus for leaving
            // that value as a board end — forces them to draw
            if (newEnd !== null && tracker.humanLacks(newEnd)) {
                score += 25; // very strong: force opponent to draw
            }

            // Double lock: if BOTH board ends would be values human lacks
            if (newEnd !== null) {
                var otherEnd = this.getOtherBoardEnd(end, board, tile);
                if (otherEnd !== null && tracker.humanLacks(newEnd) && tracker.humanLacks(otherEnd)) {
                    score += 20; // devastating: human MUST draw, guaranteed
                }
            }

            // === 5. Flexibility: keep board ends matching our remaining tiles ===
            var remainingTiles = [];
            for (var i = 0; i < aiHand.tiles.length; i++) {
                if (aiHand.tiles[i] !== tile) remainingTiles.push(aiHand.tiles[i]);
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

            // === 6. Board end diversity ===
            if (newEnd !== null) {
                var otherEnd = this.getOtherBoardEnd(end, board, tile);
                if (otherEnd !== null && newEnd !== otherEnd) {
                    score += 4;
                }
            }

            // === 7. Suit dominance ===
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

            // === 8. ENHANCED: Board scarcity exploitation ===
            // If many tiles of a suit value are already played/in AI hand,
            // leaving that value on the board makes it hard for human
            if (newEnd !== null) {
                var totalTilesWithValue = 0;
                var knownTilesWithValue = 0;
                // Count how many tiles contain this value (0-6 → 7 tiles each, except 0 has 7)
                for (var v = 0; v <= 6; v++) {
                    var id = Math.min(newEnd, v) + '-' + Math.max(newEnd, v);
                    totalTilesWithValue++;
                    if (tracker.tileLocation[id] === 'ai' || tracker.tileLocation[id] === 'board') {
                        knownTilesWithValue++;
                    }
                }
                // More tiles of this suit accounted for = fewer available to opponent
                score += knownTilesWithValue * 2;
            }

            // === 9. ENHANCED: Penalize leaving ends where human has known tiles ===
            // If we know (from probability) that human likely has tiles matching
            // the new board end, that's bad for us
            if (newEnd !== null) {
                var possibleHumanTiles = tracker.getPossibleHumanTiles();
                var humanMatchCount = 0;
                for (var i = 0; i < possibleHumanTiles.length; i++) {
                    var parts = possibleHumanTiles[i].split('-');
                    var lo = parseInt(parts[0]);
                    var hi = parseInt(parts[1]);
                    if (lo === newEnd || hi === newEnd) humanMatchCount++;
                }
                // Fewer possible human matches on this end = better for AI
                score -= humanMatchCount * 1.5;
            }

            // === 10. Hand coverage diversity ===
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
        // Determinization: Monte Carlo sampling of possible worlds
        // Sample N random consistent opponent hands, simulate each,
        // and adjust move scores based on average outcomes
        // ============================================================
        applyDeterminization(scored, engine) {
            var tracker = this.tracker;
            var SAMPLES = 30; // balance speed vs accuracy

            var possibleHumanTiles = tracker.getPossibleHumanTiles();
            var impossibleForHuman = tracker.getImpossibleForHuman();
            var humanHandSize = tracker.humanHandSize;

            // If we can't sample meaningfully, skip
            if (possibleHumanTiles.length < humanHandSize || humanHandSize <= 0) {
                return scored;
            }

            // For each move, run N simulations
            for (var mi = 0; mi < scored.length; mi++) {
                var move = scored[mi].move;
                var totalOutcome = 0;

                for (var s = 0; s < SAMPLES; s++) {
                    // Randomly assign possibleHumanTiles to human hand
                    var shuffled = possibleHumanTiles.slice();
                    for (var k = shuffled.length - 1; k > 0; k--) {
                        var j = Math.floor(Math.random() * (k + 1));
                        var tmp = shuffled[k]; shuffled[k] = shuffled[j]; shuffled[j] = tmp;
                    }
                    var sampledHumanHand = shuffled.slice(0, Math.min(humanHandSize, shuffled.length));

                    // Score this world: how good is our move if human has this hand?
                    var outcome = this.evaluateMoveInWorld(move, sampledHumanHand, engine);
                    totalOutcome += outcome;
                }

                // Add average determinization score as bonus
                scored[mi].score += (totalOutcome / SAMPLES) * 3;
            }

            return scored;
        }

        // Evaluate a move in a simulated world
        evaluateMoveInWorld(move, sampledHumanHand, engine) {
            var board = engine.hand.board;
            var newEnd = this.getNewBoardEnd(move.tile, move.end, board);
            var otherEnd = this.getOtherBoardEnd(move.end, board, move.tile);

            if (newEnd === null) return 0;

            // Check if human can respond to the new board state
            var humanCanPlay = false;
            for (var i = 0; i < sampledHumanHand.length; i++) {
                var parts = sampledHumanHand[i].split('-');
                var lo = parseInt(parts[0]);
                var hi = parseInt(parts[1]);
                if (lo === newEnd || hi === newEnd || lo === otherEnd || hi === otherEnd) {
                    humanCanPlay = true;
                    break;
                }
            }

            // If human can't play in this world, that's great for us
            if (!humanCanPlay) return 5;

            // If human can play, estimate pip advantage
            // Lower human pip tiles matching = less damage from their response
            var minHumanResponsePips = Infinity;
            for (var i = 0; i < sampledHumanHand.length; i++) {
                var parts = sampledHumanHand[i].split('-');
                var lo = parseInt(parts[0]);
                var hi = parseInt(parts[1]);
                if (lo === newEnd || hi === newEnd || lo === otherEnd || hi === otherEnd) {
                    var pips = lo + hi;
                    if (pips < minHumanResponsePips) minHumanResponsePips = pips;
                }
            }

            // High-pip response from human = slightly good for us (they lose heavy tile,
            // but also: they played, which is neutral). Low pip response = bad.
            return (minHumanResponsePips - 5) * 0.3;
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

        evaluatePosition(engine) {
            var hand = engine.hand;
            var aiPips = hand.aiHand.totalPips(hand.board);
            var humanTileCount = hand.humanHand.count();
            var aiTileCount = hand.aiHand.count();

            // Enhanced eval: factor in information advantage
            var infoBonus = this.tracker.getHumanLackedValueCount() * 3;

            var posEval = (humanTileCount - aiTileCount) * 5 - aiPips * 0.5 + infoBonus;
            return Math.max(-50, Math.min(50, posEval));
        }
    }

    D.AIPlayer = AIPlayer;

})(window.Domino);
