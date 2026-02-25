/// Move generation for domino bitboard engine.
/// Generates legal moves into per-ply move buffers.

use crate::lookup::{SUIT_MASK, NUM_TILES, popcount};

/// Maximum ply depth for move stacks.
pub const MAX_PLY: usize = 64;
pub const MOVE_BUF_SIZE: usize = MAX_PLY * NUM_TILES;

/// Per-ply move buffers (tile index, end, ordering score).
pub static mut MOVE_TILE_BUF: [i8; MOVE_BUF_SIZE] = [0; MOVE_BUF_SIZE];
pub static mut MOVE_END_BUF: [i8; MOVE_BUF_SIZE] = [0; MOVE_BUF_SIZE];
pub static mut MOVE_SCORE_BUF: [f64; MOVE_BUF_SIZE] = [0.0; MOVE_BUF_SIZE];

/// Generate all legal moves for `hand` given board ends `left`/`right` at `ply`.
/// Returns the number of moves generated. Moves stored at `ply * 28 .. ply * 28 + count`.
/// `left == 7` means the board is empty (any tile can be played).
#[inline]
pub fn generate_moves(hand: i32, left: i8, right: i8, ply: usize) -> usize {
    let base = ply * 28;
    let mut count = 0;

    unsafe {
        if left == 7 {
            // Empty board: any tile in hand is legal
            let mut h = hand;
            while h != 0 {
                let bit = h & h.wrapping_neg();
                let idx = bit.trailing_zeros() as usize;
                MOVE_TILE_BUF[base + count] = idx as i8;
                MOVE_END_BUF[base + count] = 0; // 0 = left end
                count += 1;
                h ^= bit;
            }
            return count;
        }

        let left_mask = SUIT_MASK[left as usize] & hand;
        let right_mask = SUIT_MASK[right as usize] & hand;

        // Left-end moves
        let mut m = left_mask;
        while m != 0 {
            let bit = m & m.wrapping_neg();
            let idx = bit.trailing_zeros() as usize;
            MOVE_TILE_BUF[base + count] = idx as i8;
            MOVE_END_BUF[base + count] = 0;
            count += 1;
            m ^= bit;
        }

        if left != right {
            // Right-end moves (all right-matching tiles)
            let mut m = right_mask;
            while m != 0 {
                let bit = m & m.wrapping_neg();
                let idx = bit.trailing_zeros() as usize;
                MOVE_TILE_BUF[base + count] = idx as i8;
                MOVE_END_BUF[base + count] = 1;
                count += 1;
                m ^= bit;
            }
        } else {
            // Same ends: only right-end tiles NOT already listed as left-end
            let mut m = right_mask & !left_mask;
            while m != 0 {
                let bit = m & m.wrapping_neg();
                let idx = bit.trailing_zeros() as usize;
                MOVE_TILE_BUF[base + count] = idx as i8;
                MOVE_END_BUF[base + count] = 1;
                count += 1;
                m ^= bit;
            }
        }
    }

    count
}

/// Count legal moves for `hand` given board ends (no buffer writes).
#[inline(always)]
pub fn count_moves_bb(hand: i32, left: i8, right: i8) -> i32 {
    if left == 7 {
        return popcount(hand);
    }
    let left_mask = SUIT_MASK[left as usize] & hand;
    let right_mask = SUIT_MASK[right as usize] & hand;
    if left == right {
        popcount(left_mask)
    } else {
        popcount(left_mask | right_mask)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_moves_empty_board() {
        // With 3 tiles in hand on empty board, should get 3 moves
        let hand = 0b111; // tiles 0, 1, 2
        let n = generate_moves(hand, 7, 7, 0);
        assert_eq!(n, 3);
    }

    #[test]
    fn test_generate_moves_matching() {
        // Tile 0 = (0,0), Tile 1 = (0,1), Tile 7 = (1,1)
        // Board left=0, right=1
        // Left matches: tiles with suit 0 = tiles 0,1,2,3,4,5,6
        // Right matches: tiles with suit 1 = tiles 1,7,8,9,10,11
        let hand = (1 << 0) | (1 << 1) | (1 << 7); // tiles 0, 1, 7
        let n = generate_moves(hand, 0, 1, 0);
        // Left=0: tiles 0, 1 match (both have suit 0)
        // Right=1: tiles 1, 7 match (both have suit 1)
        // Since left != right, no dedup needed
        // But tile 1 = (0,1) matches both ends, listed as left AND right
        assert!(n >= 3); // at least 3 unique (tile,end) combos
    }

    #[test]
    fn test_count_moves_empty_board() {
        let hand = 0b1111; // 4 tiles
        assert_eq!(count_moves_bb(hand, 7, 7), 4);
    }

    #[test]
    fn test_count_moves_same_ends() {
        // left == right == 0
        // Only tiles matching suit 0
        let hand = (1 << 0) | (1 << 7); // tile 0 = (0,0), tile 7 = (1,1)
        // tile 0 matches suit 0, tile 7 doesn't
        assert_eq!(count_moves_bb(hand, 0, 0), 1);
    }
}
