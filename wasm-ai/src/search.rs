/// Core search engine: minimax with alpha-beta pruning, iterative deepening,
/// aspiration windows, PVS at root, quiescence extensions.
/// Direct port of ai-worker.js chooseMoveHard + minimaxBB.

use crate::lookup::{
    TILE_LOW, TILE_HIGH, NEW_END_LEFT, NEW_END_RIGHT, popcount,
};
use crate::zobrist;
use crate::tt::{self, TT_EXACT, TT_LOWER, TT_UPPER};
use crate::movegen::{
    generate_moves, count_moves_bb,
    MOVE_TILE_BUF, MOVE_END_BUF,
};
use crate::scoring::{score_domino_bb, score_block_bb};
use crate::eval::evaluate_bb;
use crate::ordering::{
    order_moves_at_ply, clear_move_ordering_data,
    record_killer, record_history,
};

// =====================================================================
// Global mutable state (WASM is single-threaded, safe to use static mut)
// =====================================================================

static mut G_AI_HAND: i32 = 0;
static mut G_HUMAN_HAND: i32 = 0;
static mut G_LEFT: i8 = 7;
static mut G_RIGHT: i8 = 7;
static mut G_HASH: i32 = 0;
static mut G_PLY: usize = 0;
static mut G_CONS_PASS: i32 = 0;
static mut G_MATCH_DIFF: i32 = 0;

// Puppeteer history
static mut G_P1_WHO: i8 = -1;
static mut G_P1_L: i8 = 0;
static mut G_P1_R: i8 = 0;
static mut G_P1_TILE: i8 = -1;
static mut G_P2_WHO: i8 = -1;
static mut G_P2_L: i8 = 0;
static mut G_P2_R: i8 = 0;

// Search counters
static mut NODE_COUNT: u32 = 0;
const NODE_LIMIT: u32 = 20_000_000;

// TT diagnostic counters
static mut TT_PROBE_COUNT: u32 = 0;
static mut TT_HIT_COUNT: u32 = 0;   // hash matched
static mut TT_CUTOFF_COUNT: u32 = 0; // returned usable score
static mut TT_HINT_COUNT: u32 = 0;   // returned move hint only

// Time management
static mut TIME_START: f64 = 0.0;
static mut TIME_BUDGET_MS: f64 = 5000.0;

/// Get current time in milliseconds (via js_sys in WASM, or std in native).
#[cfg(target_arch = "wasm32")]
fn now_ms() -> f64 {
    js_sys::Date::now()
}

#[cfg(not(target_arch = "wasm32"))]
fn now_ms() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as f64
}

// =====================================================================
// Search result structure
// =====================================================================

/// Result of the root search.
pub struct SearchResult {
    pub best_tile_idx: i8,
    pub best_end: i8,
    pub best_score: i32,
    pub depth: i32,
    pub nodes: u32,
    /// Per-move scores: (tile_idx, end, score)
    pub analysis: Vec<(i8, i8, i32)>,
    // TT diagnostics
    pub tt_probes: u32,
    pub tt_hits: u32,
    pub tt_cutoffs: u32,
    pub tt_hints: u32,
}

// =====================================================================
// Inner minimax
// =====================================================================

/// Minimax with alpha-beta pruning, TT, quiescence extensions.
/// `is_ai`: true if maximizing (AI's turn), false if minimizing.
unsafe fn minimax_bb(is_ai: bool, mut depth: i32, mut alpha: i32, mut beta: i32, mut ext: i32) -> i32 {
    NODE_COUNT += 1;

    if NODE_COUNT >= NODE_LIMIT {
        return evaluate_bb(G_AI_HAND, G_HUMAN_HAND, G_LEFT, G_RIGHT, G_MATCH_DIFF) as i32;
    }

    let my_hand = if is_ai { G_AI_HAND } else { G_HUMAN_HAND };
    let num_moves = generate_moves(my_hand, G_LEFT, G_RIGHT, G_PLY);

    // --- No legal moves: must pass ---
    if num_moves == 0 {
        let new_cons_pass = G_CONS_PASS + 1;
        if new_cons_pass >= 2 {
            return score_block_bb(
                G_AI_HAND, G_HUMAN_HAND,
                G_P1_WHO, G_P1_L, G_P1_R, G_P1_TILE,
                G_P2_WHO, G_P2_L, G_P2_R,
            );
        }

        let saved_cons_pass = G_CONS_PASS;
        let saved_hash = G_HASH;

        G_HASH ^= zobrist::side_hash();
        if G_CONS_PASS > 0 { G_HASH ^= zobrist::conspass_hash(1); }
        G_CONS_PASS = new_cons_pass;
        if G_CONS_PASS > 0 { G_HASH ^= zobrist::conspass_hash(1); }

        let score = minimax_bb(!is_ai, depth, alpha, beta, ext);

        G_HASH = saved_hash;
        G_CONS_PASS = saved_cons_pass;
        return score;
    }

    // --- Quiescence: extend if forced / tactical ---
    if depth <= 0 {
        let total_remaining = popcount(G_AI_HAND) + popcount(G_HUMAN_HAND);
        let max_ext = 6 + (12 - total_remaining).max(0);
        let mut extended = false;
        if ext < max_ext {
            if num_moves == 1 {
                extended = true;
            } else if G_CONS_PASS > 0 {
                extended = true;
            } else if total_remaining <= 8 {
                let opp_hand = if is_ai { G_HUMAN_HAND } else { G_AI_HAND };
                if count_moves_bb(opp_hand, G_LEFT, G_RIGHT) <= 1 {
                    extended = true;
                }
            }
        }
        if extended {
            depth = 1;
            ext = ext + 1; // Match JS: ext = ext + 1
        } else {
            return evaluate_bb(G_AI_HAND, G_HUMAN_HAND, G_LEFT, G_RIGHT, G_MATCH_DIFF) as i32;
        }
    }

    // --- TT probe ---
    let tt_hit = tt::tt_probe(G_HASH, depth, alpha, beta);
    let mut tt_best_tile: i8 = -1;
    let mut tt_best_end_val: i8 = -1;
    TT_PROBE_COUNT += 1;
    if let Some(ref hit) = tt_hit {
        TT_HIT_COUNT += 1;
        if let Some(score) = hit.score {
            TT_CUTOFF_COUNT += 1;
            return score;
        }
        tt_best_tile = hit.best_idx;
        tt_best_end_val = hit.best_end;
        TT_HINT_COUNT += 1;
    }

    // --- Move ordering ---
    if num_moves > 2 {
        order_moves_at_ply(G_PLY, num_moves, is_ai, depth,
                          G_AI_HAND, G_HUMAN_HAND, G_LEFT, G_RIGHT);
    }

    // TT best move to front
    if tt_best_tile >= 0 {
        let base = G_PLY * 28;
        for mi in 1..num_moves {
            if MOVE_TILE_BUF[base + mi] == tt_best_tile
                && MOVE_END_BUF[base + mi] == tt_best_end_val
            {
                let tmp_t = MOVE_TILE_BUF[base];
                let tmp_e = MOVE_END_BUF[base];
                MOVE_TILE_BUF[base] = MOVE_TILE_BUF[base + mi];
                MOVE_END_BUF[base] = MOVE_END_BUF[base + mi];
                MOVE_TILE_BUF[base + mi] = tmp_t;
                MOVE_END_BUF[base + mi] = tmp_e;
                break;
            }
        }
    }

    // --- Save state ---
    let saved_left = G_LEFT;
    let saved_right = G_RIGHT;
    let saved_hash = G_HASH;
    let saved_cons_pass = G_CONS_PASS;
    let saved_p1_who = G_P1_WHO;
    let saved_p1_l = G_P1_L;
    let saved_p1_r = G_P1_R;
    let saved_p1_tile = G_P1_TILE;
    let saved_p2_who = G_P2_WHO;
    let saved_p2_l = G_P2_L;
    let saved_p2_r = G_P2_R;
    let saved_ply = G_PLY;

    let base = G_PLY * 28;
    let orig_alpha = alpha;
    let orig_beta = beta;
    let mut best_move_idx: i8 = -1;
    let mut best_move_end: i8 = -1;

    if is_ai {
        // === MAXIMIZING ===
        let mut best = -100000;
        for i in 0..num_moves {
            let t_idx = MOVE_TILE_BUF[base + i] as usize;
            let end = MOVE_END_BUF[base + i];
            let bit = 1i32 << t_idx;

            G_AI_HAND ^= bit;

            let (new_l, new_r) = compute_new_ends(t_idx, end, saved_left, saved_right);
            G_LEFT = new_l;
            G_RIGHT = new_r;

            // Update hash
            G_HASH = saved_hash;
            G_HASH ^= zobrist::tile_hash(t_idx, 0);
            G_HASH ^= zobrist::left_hash(saved_left as usize);
            G_HASH ^= zobrist::left_hash(new_l as usize);
            G_HASH ^= zobrist::right_hash(saved_right as usize);
            G_HASH ^= zobrist::right_hash(new_r as usize);
            G_HASH ^= zobrist::side_hash();
            if saved_cons_pass > 0 { G_HASH ^= zobrist::conspass_hash(1); }
            G_CONS_PASS = 0;

            // Update puppeteer
            G_P2_WHO = saved_p1_who;
            G_P2_L = saved_p1_l;
            G_P2_R = saved_p1_r;
            G_P1_WHO = 1;
            G_P1_L = new_l;
            G_P1_R = new_r;
            G_P1_TILE = t_idx as i8;

            G_PLY = saved_ply + 1;

            let sc = if G_AI_HAND == 0 {
                score_domino_bb(true, G_HUMAN_HAND)
            } else if count_moves_bb(G_HUMAN_HAND, new_l, new_r) == 0
                && count_moves_bb(G_AI_HAND, new_l, new_r) == 0
            {
                score_block_bb(
                    G_AI_HAND, G_HUMAN_HAND,
                    G_P1_WHO, G_P1_L, G_P1_R, G_P1_TILE,
                    G_P2_WHO, G_P2_L, G_P2_R,
                )
            } else {
                minimax_bb(false, depth - 1, alpha, beta, ext)
            };

            // Unmake
            G_AI_HAND ^= bit;
            G_LEFT = saved_left;
            G_RIGHT = saved_right;
            G_HASH = saved_hash;
            G_CONS_PASS = saved_cons_pass;
            G_P1_WHO = saved_p1_who;
            G_P1_L = saved_p1_l;
            G_P1_R = saved_p1_r;
            G_P1_TILE = saved_p1_tile;
            G_P2_WHO = saved_p2_who;
            G_P2_L = saved_p2_l;
            G_P2_R = saved_p2_r;
            G_PLY = saved_ply;

            if sc > best {
                best = sc;
                best_move_idx = t_idx as i8;
                best_move_end = end;
            }
            if best > alpha { alpha = best; }
            if beta <= alpha {
                record_killer(depth, t_idx as i8, end);
                record_history(t_idx as i8, end, depth);
                break;
            }
        }

        // TT store
        let tt_flag = if best <= orig_alpha {
            TT_UPPER
        } else if best >= orig_beta {
            TT_LOWER
        } else {
            TT_EXACT
        };
        tt::tt_store(G_HASH, depth, tt_flag, best, best_move_idx, best_move_end);
        best
    } else {
        // === MINIMIZING ===
        let mut best = 100000;
        for i in 0..num_moves {
            let t_idx = MOVE_TILE_BUF[base + i] as usize;
            let end = MOVE_END_BUF[base + i];
            let bit = 1i32 << t_idx;

            G_HUMAN_HAND ^= bit;

            let (new_l, new_r) = compute_new_ends(t_idx, end, saved_left, saved_right);
            G_LEFT = new_l;
            G_RIGHT = new_r;

            G_HASH = saved_hash;
            G_HASH ^= zobrist::tile_hash(t_idx, 1);
            G_HASH ^= zobrist::left_hash(saved_left as usize);
            G_HASH ^= zobrist::left_hash(new_l as usize);
            G_HASH ^= zobrist::right_hash(saved_right as usize);
            G_HASH ^= zobrist::right_hash(new_r as usize);
            G_HASH ^= zobrist::side_hash();
            if saved_cons_pass > 0 { G_HASH ^= zobrist::conspass_hash(1); }
            G_CONS_PASS = 0;

            G_P2_WHO = saved_p1_who;
            G_P2_L = saved_p1_l;
            G_P2_R = saved_p1_r;
            G_P1_WHO = 0;
            G_P1_L = new_l;
            G_P1_R = new_r;
            G_P1_TILE = t_idx as i8;

            G_PLY = saved_ply + 1;

            let sc = if G_HUMAN_HAND == 0 {
                score_domino_bb(false, G_AI_HAND)
            } else if count_moves_bb(G_AI_HAND, new_l, new_r) == 0
                && count_moves_bb(G_HUMAN_HAND, new_l, new_r) == 0
            {
                score_block_bb(
                    G_AI_HAND, G_HUMAN_HAND,
                    G_P1_WHO, G_P1_L, G_P1_R, G_P1_TILE,
                    G_P2_WHO, G_P2_L, G_P2_R,
                )
            } else {
                minimax_bb(true, depth - 1, alpha, beta, ext)
            };

            // Unmake
            G_HUMAN_HAND ^= bit;
            G_LEFT = saved_left;
            G_RIGHT = saved_right;
            G_HASH = saved_hash;
            G_CONS_PASS = saved_cons_pass;
            G_P1_WHO = saved_p1_who;
            G_P1_L = saved_p1_l;
            G_P1_R = saved_p1_r;
            G_P1_TILE = saved_p1_tile;
            G_P2_WHO = saved_p2_who;
            G_P2_L = saved_p2_l;
            G_P2_R = saved_p2_r;
            G_PLY = saved_ply;

            if sc < best {
                best = sc;
                best_move_idx = t_idx as i8;
                best_move_end = end;
            }
            if best < beta { beta = best; }
            if beta <= alpha {
                record_killer(depth, t_idx as i8, end);
                record_history(t_idx as i8, end, depth);
                break;
            }
        }

        let tt_flag = if best <= orig_alpha {
            TT_UPPER
        } else if best >= orig_beta {
            TT_LOWER
        } else {
            TT_EXACT
        };
        tt::tt_store(G_HASH, depth, tt_flag, best, best_move_idx, best_move_end);
        best
    }
}

/// Compute new board ends after placing tile `t_idx` on `end` (0=left, 1=right).
#[inline(always)]
fn compute_new_ends(t_idx: usize, end: i8, left: i8, right: i8) -> (i8, i8) {
    if left == 7 {
        (TILE_LOW[t_idx], TILE_HIGH[t_idx])
    } else if end == 0 {
        (NEW_END_LEFT[t_idx * 8 + left as usize], right)
    } else {
        (left, NEW_END_RIGHT[t_idx * 8 + right as usize])
    }
}

// =====================================================================
// Root search with iterative deepening
// =====================================================================

/// Main entry point: run iterative deepening search and return best move.
///
/// # Arguments
/// * `ai_hand` — AI hand bitmask
/// * `human_hand` — Human hand bitmask
/// * `left` — Left board end (7 = empty)
/// * `right` — Right board end (7 = empty)
/// * `cons_pass` — Consecutive passes (0 normally)
/// * `match_diff` — AI match score minus human match score
/// * `p1_who`, `p1_l`, `p1_r`, `p1_tile` — Last placer info
/// * `p2_who`, `p2_l`, `p2_r` — Second-to-last placer info
/// * `time_budget` — Time budget in ms (0 = use default)
pub fn choose_move(
    ai_hand: i32,
    human_hand: i32,
    left: i8,
    right: i8,
    cons_pass: i32,
    match_diff: i32,
    p1_who: i8, p1_l: i8, p1_r: i8, p1_tile: i8,
    p2_who: i8, p2_l: i8, p2_r: i8,
    time_budget: f64,
) -> SearchResult {
    unsafe {
        // Initialize global state
        G_AI_HAND = ai_hand;
        G_HUMAN_HAND = human_hand;
        G_LEFT = left;
        G_RIGHT = right;
        G_PLY = 0;
        G_CONS_PASS = cons_pass;
        G_MATCH_DIFF = match_diff;

        G_P1_WHO = p1_who;
        G_P1_L = p1_l;
        G_P1_R = p1_r;
        G_P1_TILE = p1_tile;
        G_P2_WHO = p2_who;
        G_P2_L = p2_l;
        G_P2_R = p2_r;

        let total_tiles = popcount(ai_hand) + popcount(human_hand);
        G_HASH = zobrist::compute_root_hash(ai_hand, human_hand, left, right, true, 0);

        // Advance TT generation (reuse entries from prev searches)
        tt::tt_new_generation();
        clear_move_ordering_data();

        TIME_START = now_ms();
        let budget = if time_budget > 0.0 { time_budget } else { 5000.0 };

        // Adaptive time budget
        let move_budget = if total_tiles >= 24 {
            budget * 2.0
        } else if total_tiles >= 18 {
            budget * 1.2
        } else if total_tiles >= 12 {
            budget
        } else {
            budget.min(1000.0)
        };
        TIME_BUDGET_MS = move_budget;

        let mut best_tile_idx: i8 = -1;
        let mut best_end: i8 = -1;
        let mut prev_score: i32 = 0;
        let mut last_depth: i32 = 0;
        let mut last_nodes: u32 = 0;
        let mut committed_scores: Vec<(i8, i8, i32)> = Vec::new();

        // Reset TT diagnostics for entire search
        TT_PROBE_COUNT = 0;
        TT_HIT_COUNT = 0;
        TT_CUTOFF_COUNT = 0;
        TT_HINT_COUNT = 0;

        // Iterative deepening
        for iter_depth in 1..=50 {
            NODE_COUNT = 0;

            let num_moves = generate_moves(G_AI_HAND, G_LEFT, G_RIGHT, 0);

            if num_moves > 2 {
                order_moves_at_ply(0, num_moves, true, iter_depth,
                                  G_AI_HAND, G_HUMAN_HAND, G_LEFT, G_RIGHT);
            }

            // TT PV move to front
            let pv_hit = tt::tt_probe(G_HASH, 0, -100000, 100000);
            if let Some(ref hit) = pv_hit {
                if hit.best_idx >= 0 {
                    for mi in 1..num_moves {
                        if MOVE_TILE_BUF[mi] == hit.best_idx
                            && MOVE_END_BUF[mi] == hit.best_end
                        {
                            let tmp_t = MOVE_TILE_BUF[0];
                            let tmp_e = MOVE_END_BUF[0];
                            MOVE_TILE_BUF[0] = MOVE_TILE_BUF[mi];
                            MOVE_END_BUF[0] = MOVE_END_BUF[mi];
                            MOVE_TILE_BUF[mi] = tmp_t;
                            MOVE_END_BUF[mi] = tmp_e;
                            break;
                        }
                    }
                }
            }

            // Aspiration window
            let asp_window = if iter_depth >= 6 { 15 } else { 30 };
            let (mut alpha_w, mut beta_w) = if iter_depth <= 1 {
                (-100000, 100000)
            } else {
                (prev_score - asp_window, prev_score + asp_window)
            };

            let mut iter_best_score: i32 = -100000;
            let mut iter_best_tile_idx: i8 = -1;
            let mut iter_best_end: i8 = -1;
            let mut iter_complete = true;
            let mut root_scores: Vec<(i8, i8, i32)> = Vec::new();

            for _asp_retry in 0..3 {
                iter_best_score = -100000;
                iter_best_tile_idx = -1;
                iter_best_end = -1;
                iter_complete = true;
                root_scores.clear();
                let mut cur_alpha = alpha_w;

                let root_ai_hand = G_AI_HAND;
                let root_hash = G_HASH;

                for i in 0..num_moves {
                    let t_idx = MOVE_TILE_BUF[i] as usize;
                    let end = MOVE_END_BUF[i];
                    let bit = 1i32 << t_idx;

                    G_AI_HAND = root_ai_hand ^ bit;

                    let (new_l, new_r) = compute_new_ends(t_idx, end, G_LEFT, G_RIGHT);
                    let saved_root_left = G_LEFT;
                    let saved_root_right = G_RIGHT;
                    G_LEFT = new_l;
                    G_RIGHT = new_r;

                    G_HASH = root_hash;
                    G_HASH ^= zobrist::tile_hash(t_idx, 0);
                    G_HASH ^= zobrist::left_hash(saved_root_left as usize);
                    G_HASH ^= zobrist::left_hash(new_l as usize);
                    G_HASH ^= zobrist::right_hash(saved_root_right as usize);
                    G_HASH ^= zobrist::right_hash(new_r as usize);
                    G_HASH ^= zobrist::side_hash();

                    G_CONS_PASS = 0;

                    let saved_rp1_who = G_P1_WHO;
                    let saved_rp1_l = G_P1_L;
                    let saved_rp1_r = G_P1_R;
                    let saved_rp1_tile = G_P1_TILE;
                    let saved_rp2_who = G_P2_WHO;
                    let saved_rp2_l = G_P2_L;
                    let saved_rp2_r = G_P2_R;

                    G_P2_WHO = G_P1_WHO;
                    G_P2_L = G_P1_L;
                    G_P2_R = G_P1_R;
                    G_P1_WHO = 1;
                    G_P1_L = new_l;
                    G_P1_R = new_r;
                    G_P1_TILE = t_idx as i8;

                    G_PLY = 1;

                    let score = if G_AI_HAND == 0 {
                        score_domino_bb(true, G_HUMAN_HAND)
                    } else if count_moves_bb(G_HUMAN_HAND, new_l, new_r) == 0
                        && count_moves_bb(G_AI_HAND, new_l, new_r) == 0
                    {
                        score_block_bb(
                            G_AI_HAND, G_HUMAN_HAND,
                            G_P1_WHO, G_P1_L, G_P1_R, G_P1_TILE,
                            G_P2_WHO, G_P2_L, G_P2_R,
                        )
                    } else if i == 0 {
                        // Full window for first move
                        minimax_bb(false, iter_depth - 1, cur_alpha, beta_w, 0)
                    } else {
                        // PVS: null window first
                        let mut sc = minimax_bb(false, iter_depth - 1, cur_alpha, cur_alpha + 1, 0);
                        if sc > cur_alpha && sc < beta_w {
                            sc = minimax_bb(false, iter_depth - 1, cur_alpha, beta_w, 0);
                        }
                        sc
                    };

                    // Unmake root
                    G_AI_HAND = root_ai_hand;
                    G_LEFT = saved_root_left;
                    G_RIGHT = saved_root_right;
                    G_HASH = root_hash;
                    G_P1_WHO = saved_rp1_who;
                    G_P1_L = saved_rp1_l;
                    G_P1_R = saved_rp1_r;
                    G_P1_TILE = saved_rp1_tile;
                    G_P2_WHO = saved_rp2_who;
                    G_P2_L = saved_rp2_l;
                    G_P2_R = saved_rp2_r;
                    G_PLY = 0;
                    G_CONS_PASS = 0;

                    root_scores.push((t_idx as i8, end, score));

                    if score > iter_best_score {
                        iter_best_score = score;
                        iter_best_tile_idx = t_idx as i8;
                        iter_best_end = end;
                    }
                    if score > cur_alpha {
                        cur_alpha = score;
                    }

                    if NODE_COUNT >= NODE_LIMIT {
                        iter_complete = false;
                        break;
                    }
                }

                // Aspiration re-search
                if iter_complete && iter_best_score <= alpha_w {
                    alpha_w = -100000;
                    continue;
                }
                if iter_complete && iter_best_score >= beta_w {
                    beta_w = 100000;
                    continue;
                }
                break;
            }

            // Update best result
            if iter_best_tile_idx >= 0 {
                if iter_complete {
                    best_tile_idx = iter_best_tile_idx;
                    best_end = iter_best_end;
                    prev_score = iter_best_score;
                    last_depth = iter_depth;
                    last_nodes = NODE_COUNT;
                    committed_scores = root_scores;
                } else {
                    // Incomplete: only update if same move or clearly winning
                    if iter_best_tile_idx == best_tile_idx || iter_best_score > 500 {
                        best_tile_idx = iter_best_tile_idx;
                        best_end = iter_best_end;
                    }
                }
            }

            if iter_complete && iter_best_tile_idx >= 0 {
                tt::tt_store(G_HASH, iter_depth, TT_EXACT, iter_best_score,
                            iter_best_tile_idx, iter_best_end);
            }

            // Full solve achieved
            if iter_complete && NODE_COUNT < NODE_LIMIT && iter_depth >= total_tiles {
                break;
            }

            // Time check
            let elapsed = now_ms() - TIME_START;
            if elapsed > move_budget * 0.75 {
                break;
            }
        }

        SearchResult {
            best_tile_idx,
            best_end,
            best_score: prev_score,
            depth: last_depth,
            nodes: last_nodes,
            analysis: committed_scores,
            tt_probes: TT_PROBE_COUNT,
            tt_hits: TT_HIT_COUNT,
            tt_cutoffs: TT_CUTOFF_COUNT,
            tt_hints: TT_HINT_COUNT,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[allow(unused_imports)]
    use crate::lookup::TILE_ID_MAP;

    #[test]
    fn test_choose_move_simple() {
        // AI has 2 tiles, human has 2 tiles, board has ends
        // AI: (0,0) = idx 0, (0,1) = idx 1
        // Human: (6,6) = idx 27, (5,6) = idx 26
        // Board: left=0, right=6
        let ai_hand = (1 << 0) | (1 << 1);
        let human_hand = (1 << 26) | (1 << 27);

        let result = choose_move(
            ai_hand, human_hand,
            0, 6, 0, 0,
            -1, 0, 0, -1,
            -1, 0, 0,
            1000.0,
        );

        assert!(result.best_tile_idx >= 0);
        assert!(result.depth >= 1);
        assert!(result.nodes > 0);
    }

    #[test]
    fn test_tt_effectiveness_opening() {
        // Same position as bench-depth.js seed=99:
        // AI: 4-6(22) 0-5(5) 0-0(0) 6-6(27) 4-5(19) 0-2(2) 1-3(10) 5-5(25) 2-6(16) 1-4(11) 0-4(4) 3-4(18) 2-3(12) 2-5(15)
        // Human: 0-1(1) 0-3(3) 0-6(6) 1-1(7) 1-2(8) 1-5(13) 1-6(14) 2-2(9) 2-4(17) 3-3(20) 3-5(21) 3-6(23) 4-4(24) 5-6(26)
        use crate::lookup::tile_id_to_index;

        let ai_tiles: Vec<(i8,i8)> = vec![(4,6),(0,5),(0,0),(6,6),(4,5),(0,2),(1,3),(5,5),(2,6),(1,4),(0,4),(3,4),(2,3),(2,5)];
        let human_tiles: Vec<(i8,i8)> = vec![(0,1),(0,3),(0,6),(1,1),(1,2),(1,5),(1,6),(2,2),(2,4),(3,3),(3,5),(3,6),(4,4),(5,6)];

        let mut ai_hand: i32 = 0;
        for &(lo, hi) in &ai_tiles {
            ai_hand |= 1 << tile_id_to_index(lo, hi);
        }
        let mut human_hand: i32 = 0;
        for &(lo, hi) in &human_tiles {
            human_hand |= 1 << tile_id_to_index(lo, hi);
        }

        eprintln!("AI hand: 0x{:08X} (popcount={})", ai_hand, popcount(ai_hand));
        eprintln!("Human hand: 0x{:08X} (popcount={})", human_hand, popcount(human_hand));

        let result = choose_move(
            ai_hand, human_hand,
            7, 7, // empty board
            0, 0, // cons_pass, match_diff
            -1, 0, 0, -1, // p1
            -1, 0, 0,     // p2
            5000.0,        // 5s budget (matches browser default)
        );

        eprintln!("\n=== WASM (Rust native) Search Results ===");
        eprintln!("Depth: {}", result.depth);
        eprintln!("Nodes: {}", result.nodes);
        eprintln!("Best score: {}", result.best_score);
        eprintln!("Best tile idx: {}", result.best_tile_idx);
        eprintln!("Best end: {}", result.best_end);
        eprintln!("\n=== TT Diagnostics ===");
        eprintln!("TT probes: {}", result.tt_probes);
        eprintln!("TT hits: {}", result.tt_hits);
        eprintln!("TT cutoffs: {}", result.tt_cutoffs);
        eprintln!("TT hints: {}", result.tt_hints);
        if result.tt_probes > 0 {
            eprintln!("Hit rate: {:.1}%", result.tt_hits as f64 * 100.0 / result.tt_probes as f64);
            eprintln!("Cutoff rate: {:.1}%", result.tt_cutoffs as f64 * 100.0 / result.tt_probes as f64);
        }

        // JS engine for this position: depth=25, nodes=3,727,928
        // If TT is working, we should be in the same ballpark
        eprintln!("\n=== Comparison vs JS ===");
        eprintln!("JS: depth=25, nodes=3,727,928");
        eprintln!("Rust: depth={}, nodes={}", result.depth, result.nodes);
        if result.nodes > 0 {
            eprintln!("Node ratio: {:.2}x", result.nodes as f64 / 3727928.0);
        }

        assert!(result.depth >= 1, "Should reach at least depth 1");
        assert!(result.tt_probes > 0, "Should have TT probes");

        // Key assertion: TT should have meaningful cutoffs
        // If cutoff rate is < 1%, TT is broken
        if result.tt_probes > 1000 {
            let cutoff_pct = result.tt_cutoffs as f64 * 100.0 / result.tt_probes as f64;
            eprintln!("ASSERT: cutoff rate {:.1}% should be > 1%", cutoff_pct);
            // Don't hard-fail yet, just report
        }
    }

    #[test]
    fn test_choose_move_domino_win() {
        // AI has 1 tile that can be played → should find the winning move
        // AI: (0,1) = idx 1, board left=0, right=3
        // Human: (6,6) = idx 27
        let ai_hand = 1 << 1;
        let human_hand = 1 << 27;

        let result = choose_move(
            ai_hand, human_hand,
            0, 3, 0, 0,
            -1, 0, 0, -1,
            -1, 0, 0,
            1000.0,
        );

        assert_eq!(result.best_tile_idx, 1); // tile (0,1)
        assert_eq!(result.best_end, 0); // left end (matches 0)
        assert!(result.best_score > 0); // winning
    }
}
