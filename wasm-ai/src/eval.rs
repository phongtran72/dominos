/// Static evaluation function — 7-component heuristic with phase-dependent weights.
/// Matches the JS `evaluateBB()` function in ai-worker.js.

use crate::lookup::{
    TILE_PIPS, TILE_00_BIT, ZERO_SUIT_NO_00, SUIT_MASK, DOUBLE_MASK, popcount,
};
use crate::movegen::count_moves_bb;

// Base evaluation weights (matching JS W_* constants)
const W_PIP: f64 = 2.0;
const W_MOBILITY: f64 = 4.0;
const W_TILE: f64 = 5.0;
const W_SUIT: f64 = 3.0;
const W_LOCKIN: f64 = 8.0;
const W_LOCKIN_BOTH: f64 = 15.0;
const W_GHOST: f64 = 10.0;
const W_DOUBLE: f64 = 1.5;

/// Static evaluation of the current position.
/// Returns a score from AI's perspective (positive = good for AI).
///
/// # Arguments
/// * `ai_hand` — AI hand bitmask
/// * `human_hand` — Human hand bitmask
/// * `left` — Left board end (7 = empty)
/// * `right` — Right board end (7 = empty)
/// * `match_diff` — AI match score minus human match score
#[inline]
pub fn evaluate_bb(
    ai_hand: i32,
    human_hand: i32,
    left: i8,
    right: i8,
    match_diff: i32,
) -> f64 {
    let both_hands = ai_hand | human_hand;

    // 1. Pip advantage
    let ai_pips = total_pips_eval(ai_hand, both_hands);
    let human_pips = total_pips_eval(human_hand, both_hands);
    let pip_score = (human_pips - ai_pips) as f64 * W_PIP;

    // 2. Mobility
    let ai_mob = count_moves_bb(ai_hand, left, right);
    let human_mob = count_moves_bb(human_hand, left, right);
    let mob_score = (ai_mob - human_mob) as f64 * W_MOBILITY;

    // 3. Tile count
    let ai_count = popcount(ai_hand);
    let human_count = popcount(human_hand);
    let tile_score = (human_count - ai_count) as f64 * W_TILE;

    // 4. Suit control + lock-in detection
    let mut suit_score = 0.0;
    if left != 7 {
        if left == right {
            let ai_l = popcount(SUIT_MASK[left as usize] & ai_hand);
            let h_l = popcount(SUIT_MASK[left as usize] & human_hand);
            suit_score = (ai_l - h_l) as f64 * W_SUIT * 2.0;
            if h_l == 0 {
                suit_score += W_LOCKIN * 2.0 + W_LOCKIN_BOTH;
            }
        } else {
            let ai_l = popcount(SUIT_MASK[left as usize] & ai_hand);
            let ai_r = popcount(SUIT_MASK[right as usize] & ai_hand);
            let h_l = popcount(SUIT_MASK[left as usize] & human_hand);
            let h_r = popcount(SUIT_MASK[right as usize] & human_hand);
            suit_score = (ai_l + ai_r - h_l - h_r) as f64 * W_SUIT;
            if h_l == 0 {
                suit_score += W_LOCKIN;
            }
            if h_r == 0 {
                suit_score += W_LOCKIN;
            }
            if h_l == 0 && h_r == 0 {
                suit_score += W_LOCKIN_BOTH;
            }
        }
    }

    // 5. Ghost 13 bonus
    let mut ghost = 0.0;
    if (both_hands & ZERO_SUIT_NO_00) == 0 {
        if (human_hand & TILE_00_BIT) != 0 {
            ghost = W_GHOST;
        }
        if (ai_hand & TILE_00_BIT) != 0 {
            ghost -= W_GHOST;
        }
    }

    // 6. Double penalty/bonus
    let mut double_pen = 0.0;
    let mut ai_doubles = ai_hand & DOUBLE_MASK;
    while ai_doubles != 0 {
        let bit = ai_doubles & ai_doubles.wrapping_neg();
        let idx = bit.trailing_zeros() as usize;
        double_pen -= (TILE_PIPS[idx] as f64 + 2.0) * W_DOUBLE;
        ai_doubles ^= bit;
    }
    let mut human_doubles = human_hand & DOUBLE_MASK;
    while human_doubles != 0 {
        let bit = human_doubles & human_doubles.wrapping_neg();
        let idx = bit.trailing_zeros() as usize;
        double_pen += (TILE_PIPS[idx] as f64 + 2.0) * W_DOUBLE;
        human_doubles ^= bit;
    }

    // 7. Phase-dependent weight scaling
    let total_remaining = popcount(ai_hand) + popcount(human_hand);
    let (mut phase_pip, mut phase_mob, mut phase_suit, phase_dbl) =
        if total_remaining >= 20 {
            (0.7, 1.5, 1.3, 1.3) // Opening: mobility & suit control matter
        } else if total_remaining < 8 {
            (1.5, 0.6, 1.5, 1.0) // Endgame: pips & suit control matter
        } else {
            (1.0, 1.0, 1.0, 1.0) // Midgame: balanced
        };

    // 8. Match-score aware adjustment
    if match_diff >= 50 {
        // Leading: play defensively — prioritize pips, reduce suit risk
        phase_pip *= 1.4;
        phase_suit *= 0.6;
    } else if match_diff <= -50 {
        // Trailing: play aggressively — suit control & mobility
        phase_pip *= 0.7;
        phase_suit *= 1.5;
        phase_mob *= 1.3;
    }

    pip_score * phase_pip
        + mob_score * phase_mob
        + tile_score
        + suit_score * phase_suit
        + ghost
        + double_pen * phase_dbl
}

/// Quick pip counting for eval (same as scoring::total_pips_bb but inline here
/// to avoid circular dependency and keep the hot path tight).
#[inline(always)]
fn total_pips_eval(hand: i32, both_hands: i32) -> i32 {
    let ghost13 = (hand & TILE_00_BIT) != 0 && (both_hands & ZERO_SUIT_NO_00) == 0;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_eval_symmetric_start() {
        // Equal hands should give ~0 eval
        let hand_a = 0b0000000_0000000_0000011_1111111; // first 9 tiles
        let hand_b = 0b1111111_1111111_1111100_0000000; // remaining 19 tiles
        // Not truly symmetric, but check it returns a finite value
        let score = evaluate_bb(hand_a, hand_b, 7, 7, 0);
        assert!(score.is_finite());
    }

    #[test]
    fn test_eval_ai_advantage() {
        // AI has 1 tile, human has many — AI should be winning
        let ai = 1 << 0; // just (0,0)
        let human = (1 << 1) | (1 << 2) | (1 << 3) | (1 << 27); // 4 tiles
        let score = evaluate_bb(ai, human, 0, 0, 0);
        assert!(score > 0.0, "AI with fewer tiles should have positive eval");
    }

    #[test]
    fn test_eval_match_diff_effect() {
        let ai = 0b111;
        let human = 0b111000;
        let s_neutral = evaluate_bb(ai, human, 0, 1, 0);
        let s_leading = evaluate_bb(ai, human, 0, 1, 100);
        let s_trailing = evaluate_bb(ai, human, 0, 1, -100);
        // All should be finite and different
        assert!(s_neutral.is_finite());
        assert!(s_leading.is_finite());
        assert!(s_trailing.is_finite());
        // Leading and trailing should produce different evaluations
        assert_ne!(s_leading as i64, s_trailing as i64);
    }
}
