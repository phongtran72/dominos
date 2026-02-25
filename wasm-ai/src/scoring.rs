/// Terminal scoring: pip counting, domino win, block scoring, puppeteer rule.

use crate::lookup::{
    TILE_PIPS, TILE_LOW, TILE_HIGH, TILE_00_BIT, ZERO_SUIT_NO_00,
    SUIT_MASK, NEW_END_LEFT, NEW_END_RIGHT, popcount,
};
use crate::movegen::count_moves_bb;

/// Total pip count for a hand bitmask. Applies Ghost 13 rule:
/// if hand holds [0-0] AND all other zero-suit tiles are gone from
/// both hands combined, [0-0] counts as 13 pips.
#[inline]
pub fn total_pips_bb(hand: i32, both_hands: i32) -> i32 {
    let ghost13 = (hand & TILE_00_BIT) != 0
        && (both_hands & ZERO_SUIT_NO_00) == 0;

    let mut sum = 0i32;
    let mut h = hand;
    while h != 0 {
        let bit = h & h.wrapping_neg();
        let idx = bit.trailing_zeros() as usize;
        if idx == 0 && ghost13 {
            sum += 13;
        } else {
            sum += TILE_PIPS[idx] as i32;
        }
        h ^= bit;
    }
    sum
}

/// Score when a player dominoes (empties their hand).
/// `winner_is_ai`: true if AI won, false if human won.
/// Returns positive if good for AI, negative if bad.
#[inline]
pub fn score_domino_bb(winner_is_ai: bool, loser_hand: i32) -> i32 {
    let pips = total_pips_bb(loser_hand, loser_hand);
    if winner_is_ai { pips } else { -pips }
}

/// Detect the aggressor for block scoring (puppeteer rule).
/// Returns 1 for AI, 0 for human.
///
/// The puppeteer rule: if the last placer (P1) forced the second-to-last
/// placer (P2) into their only legal move, AND that forced move led to
/// the block, then P2 is the real aggressor (the puppeteer).
pub fn detect_aggressor_bb(
    p1_who: i8, _p1_l: i8, _p1_r: i8, p1_tile: i8,
    p2_who: i8, p2_l: i8, p2_r: i8,
    last_placer_hand: i32, other_hand: i32,
) -> i8 {
    if p2_who == -1 || p1_tile == -1 {
        return p1_who;
    }

    // Reconstruct the hand P2 had BEFORE their forced move
    let forced_hand = last_placer_hand | (1 << p1_tile);

    // Count how many legal moves P2 had at that point
    let legal_mask = if p2_l == 7 {
        forced_hand
    } else if p2_l == p2_r {
        SUIT_MASK[p2_l as usize] & forced_hand
    } else {
        (SUIT_MASK[p2_l as usize] | SUIT_MASK[p2_r as usize]) & forced_hand
    };

    let legal_count = popcount(legal_mask);
    if legal_count != 1 {
        return p1_who;
    }

    // P2 had exactly one legal move — check if it led to a block
    let the_tile_idx = (legal_mask & legal_mask.wrapping_neg()).trailing_zeros() as usize;
    let lo = TILE_LOW[the_tile_idx];
    let hi = TILE_HIGH[the_tile_idx];

    let can_l = if p2_l == 7 {
        true
    } else {
        lo == p2_l || hi == p2_l
    };
    let can_r = if p2_l == 7 {
        false
    } else if p2_l == p2_r && can_l {
        false
    } else {
        lo == p2_r || hi == p2_r
    };

    let forced_hand_after = last_placer_hand; // P2's hand after playing that tile

    if can_l {
        let new_l = NEW_END_LEFT[the_tile_idx * 8 + if p2_l == 7 { 7 } else { p2_l as usize }];
        let new_r = if p2_l == 7 {
            NEW_END_RIGHT[the_tile_idx * 8 + 7]
        } else {
            p2_r
        };
        if count_moves_bb(other_hand, new_l, new_r) > 0
            || count_moves_bb(forced_hand_after, new_l, new_r) > 0
        {
            return p1_who;
        }
    }
    if can_r {
        let new_r2 = NEW_END_RIGHT[the_tile_idx * 8 + p2_r as usize];
        let new_l2 = p2_l;
        if count_moves_bb(other_hand, new_l2, new_r2) > 0
            || count_moves_bb(forced_hand_after, new_l2, new_r2) > 0
        {
            return p1_who;
        }
    }

    p2_who
}

/// Score a blocked game using aggressor detection + pip comparison.
/// Uses global state for hands and puppeteer history.
///
/// # Safety
/// Reads from global mutable state (gAiHand, gHumanHand, gP1*, gP2*).
pub unsafe fn score_block_bb(
    ai_hand: i32,
    human_hand: i32,
    p1_who: i8, p1_l: i8, p1_r: i8, p1_tile: i8,
    p2_who: i8, p2_l: i8, p2_r: i8,
) -> i32 {
    let (last_placer_hand, other_hand) = if p1_who == 1 {
        (ai_hand, human_hand)
    } else {
        (human_hand, ai_hand)
    };

    let aggressor = detect_aggressor_bb(
        p1_who, p1_l, p1_r, p1_tile,
        p2_who, p2_l, p2_r,
        last_placer_hand, other_hand,
    );

    let both_hands = ai_hand | human_hand;
    let ai_pips = total_pips_bb(ai_hand, both_hands);
    let human_pips = total_pips_bb(human_hand, both_hands);

    let aggr_pips = if aggressor == 1 { ai_pips } else { human_pips };
    let opp_pips = if aggressor == 1 { human_pips } else { ai_pips };

    if aggr_pips <= opp_pips {
        let pts = opp_pips * 2;
        if aggressor == 1 { pts } else { -pts }
    } else {
        let pts = ai_pips + human_pips;
        if aggressor == 1 { -pts } else { pts }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_total_pips_simple() {
        // Tile 0 = (0,0) = 0 pips, Tile 1 = (0,1) = 1 pip, Tile 2 = (0,2) = 2 pips
        let hand = (1 << 0) | (1 << 1) | (1 << 2);
        assert_eq!(total_pips_bb(hand, hand), 0 + 1 + 2);
    }

    #[test]
    fn test_total_pips_ghost13() {
        // [0-0] alone, all zero-suit tiles gone from both hands
        // ZERO_SUIT_NO_00 tiles are (0,1),(0,2),(0,3),(0,4),(0,5),(0,6) = indices 1-6
        // If both_hands has none of those, ghost 13 triggers
        let hand = 1 << 0; // just [0-0]
        let both = 1 << 0; // only [0-0] in either hand
        assert_eq!(total_pips_bb(hand, both), 13);
    }

    #[test]
    fn test_total_pips_no_ghost13() {
        // [0-0] + [0-1] — zero suit not exhausted
        let hand = (1 << 0) | (1 << 1);
        assert_eq!(total_pips_bb(hand, hand), 0 + 1); // normal pips
    }

    #[test]
    fn test_score_domino_ai_wins() {
        // AI wins, human has 10 pips
        let human_hand = 1 << 27; // tile 27 = (6,6) = 12 pips
        assert_eq!(score_domino_bb(true, human_hand), 12);
    }

    #[test]
    fn test_score_domino_human_wins() {
        let ai_hand = 1 << 27; // tile 27 = (6,6) = 12 pips
        assert_eq!(score_domino_bb(false, ai_hand), -12);
    }
}
