/// Move ordering: killer heuristic (2 slots per depth) + history heuristic.
/// Insertion sort by score — small move lists (max ~14 moves) make this optimal.

use crate::lookup::{
    TILE_PIPS, TILE_IS_DOUBLE, TILE_LOW, TILE_HIGH, TILE_00_BIT, ZERO_SUIT_NO_00,
    NEW_END_LEFT, NEW_END_RIGHT, popcount,
};
use crate::movegen::{count_moves_bb, MOVE_TILE_BUF, MOVE_END_BUF, MOVE_SCORE_BUF};

// Move ordering bonuses (matching JS MO_* constants)
const MO_DOMINO: f64 = 1000.0;
const MO_DOUBLE: f64 = 12.0;
const MO_PIP_MULT: f64 = 1.5;
const MO_FORCE_PASS: f64 = 25.0;
const MO_GHOST: f64 = 15.0;

/// Maximum depth for killer slot storage.
pub const MAX_DEPTH_SLOTS: usize = 64;

/// Killer move storage: 2 slots per depth (tile index + end).
pub static mut KILLER_TILE_ID: [i8; MAX_DEPTH_SLOTS * 2] = [-1; MAX_DEPTH_SLOTS * 2];
pub static mut KILLER_END: [i8; MAX_DEPTH_SLOTS * 2] = [-2; MAX_DEPTH_SLOTS * 2];

/// History heuristic: [tile_idx][end+1] (end: -1=pass(unused), 0=left, 1=right).
pub static mut HISTORY_SCORE: [[i32; 3]; 28] = [[0; 3]; 28];

/// Clear killer and history tables (call at start of each root search).
pub fn clear_move_ordering_data() {
    unsafe {
        for k in 0..MAX_DEPTH_SLOTS * 2 {
            KILLER_TILE_ID[k] = -1;
            KILLER_END[k] = -2;
        }
        for h in 0..28 {
            HISTORY_SCORE[h] = [0, 0, 0];
        }
    }
}

/// Record a killer move at `depth` (two-slot replacement).
#[inline]
pub fn record_killer(depth: i32, tile_idx: i8, end: i8) {
    unsafe {
        if depth >= 0 && (depth as usize) < MAX_DEPTH_SLOTS {
            let kd = (depth as usize) * 2;
            if KILLER_TILE_ID[kd] != tile_idx || KILLER_END[kd] != end {
                KILLER_TILE_ID[kd + 1] = KILLER_TILE_ID[kd];
                KILLER_END[kd + 1] = KILLER_END[kd];
                KILLER_TILE_ID[kd] = tile_idx;
                KILLER_END[kd] = end;
            }
        }
    }
}

/// Record a history bonus for a cutoff move.
#[inline]
pub fn record_history(tile_idx: i8, end: i8, depth: i32) {
    unsafe {
        let hv = HISTORY_SCORE[tile_idx as usize][(end + 1) as usize] + depth * depth;
        HISTORY_SCORE[tile_idx as usize][(end + 1) as usize] = if hv > 10000 { 10000 } else { hv };
    }
}

/// Score and sort moves at `ply` using killer + history + heuristic bonuses.
/// Performs insertion sort (optimal for small arrays, no allocation).
///
/// # Safety
/// Reads/writes global move buffers and ordering state.
pub unsafe fn order_moves_at_ply(
    ply: usize,
    num_moves: usize,
    is_ai: bool,
    depth: i32,
    ai_hand: i32,
    human_hand: i32,
    left: i8,
    right: i8,
) {
    if num_moves <= 1 {
        return;
    }

    let base = ply * 28;
    let my_hand = if is_ai { ai_hand } else { human_hand };
    let opp_hand = if is_ai { human_hand } else { ai_hand };

    // Score each move
    for i in 0..num_moves {
        let t_idx = MOVE_TILE_BUF[base + i] as usize;
        let end = MOVE_END_BUF[base + i];
        let mut s: f64 = 0.0;

        // Domino bonus (last tile)
        if popcount(my_hand) == 1 {
            s += MO_DOMINO;
        }

        // Killer bonus
        if depth >= 0 && (depth as usize) < MAX_DEPTH_SLOTS {
            let kd = (depth as usize) * 2;
            if KILLER_TILE_ID[kd] == t_idx as i8 && KILLER_END[kd] == end {
                s += 5000.0;
            } else if KILLER_TILE_ID[kd + 1] == t_idx as i8 && KILLER_END[kd + 1] == end {
                s += 4500.0;
            }
        }

        // History score
        s += HISTORY_SCORE[t_idx][(end + 1) as usize] as f64;

        // Double bonus
        if TILE_IS_DOUBLE[t_idx] {
            s += MO_DOUBLE;
        }

        // Pip multiplier (prefer playing high-pip tiles)
        s += TILE_PIPS[t_idx] as f64 * MO_PIP_MULT;

        // Force-pass bonus
        let (new_l, new_r) = if left == 7 {
            (TILE_LOW[t_idx], TILE_HIGH[t_idx])
        } else if end == 0 {
            (NEW_END_LEFT[t_idx * 8 + left as usize], right)
        } else {
            (left, NEW_END_RIGHT[t_idx * 8 + right as usize])
        };
        if count_moves_bb(opp_hand, new_l, new_r) == 0 {
            s += MO_FORCE_PASS;
        }

        // Ghost activation bonus
        if is_ai && (opp_hand & TILE_00_BIT) != 0 {
            let new_both = (my_hand ^ (1 << t_idx)) | opp_hand;
            if (new_both & ZERO_SUIT_NO_00) == 0 {
                s += MO_GHOST;
            }
        }

        MOVE_SCORE_BUF[base + i] = s;
    }

    // Insertion sort by score (descending)
    for i in 1..num_moves {
        let score_i = MOVE_SCORE_BUF[base + i];
        let tile_i = MOVE_TILE_BUF[base + i];
        let end_i = MOVE_END_BUF[base + i];
        let mut j = i;
        while j > 0 && MOVE_SCORE_BUF[base + j - 1] < score_i {
            MOVE_SCORE_BUF[base + j] = MOVE_SCORE_BUF[base + j - 1];
            MOVE_TILE_BUF[base + j] = MOVE_TILE_BUF[base + j - 1];
            MOVE_END_BUF[base + j] = MOVE_END_BUF[base + j - 1];
            j -= 1;
        }
        MOVE_SCORE_BUF[base + j] = score_i;
        MOVE_TILE_BUF[base + j] = tile_i;
        MOVE_END_BUF[base + j] = end_i;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clear_ordering() {
        clear_move_ordering_data();
        unsafe {
            for k in 0..MAX_DEPTH_SLOTS * 2 {
                assert_eq!(KILLER_TILE_ID[k], -1);
                assert_eq!(KILLER_END[k], -2);
            }
            for h in 0..28 {
                assert_eq!(HISTORY_SCORE[h], [0, 0, 0]);
            }
        }
    }

    #[test]
    fn test_record_killer_two_slots() {
        clear_move_ordering_data();
        record_killer(3, 5, 0);
        unsafe {
            assert_eq!(KILLER_TILE_ID[6], 5);
            assert_eq!(KILLER_END[6], 0);
        }
        // Second different killer at same depth pushes first to slot 2
        record_killer(3, 10, 1);
        unsafe {
            assert_eq!(KILLER_TILE_ID[6], 10);
            assert_eq!(KILLER_END[6], 1);
            assert_eq!(KILLER_TILE_ID[7], 5);
            assert_eq!(KILLER_END[7], 0);
        }
    }

    #[test]
    fn test_history_cap() {
        clear_move_ordering_data();
        // Record huge depth to check cap
        for _ in 0..200 {
            record_history(0, 0, 100);
        }
        unsafe {
            assert!(HISTORY_SCORE[0][1] <= 10000);
        }
    }
}
