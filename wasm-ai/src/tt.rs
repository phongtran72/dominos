/// Transposition table — 4M entries, struct-of-arrays layout.
/// Uses generation counter for aging (never needs clearing).

pub const TT_SIZE: usize = 1 << 22; // 4,194,304 entries
const TT_MASK: usize = TT_SIZE - 1;

pub const TT_EXACT: u8 = 1;
pub const TT_LOWER: u8 = 2;
pub const TT_UPPER: u8 = 3;

/// Struct-of-arrays TT storage. All arrays indexed by `(hash & TT_MASK)`.
static mut TT_HASH: [i32; TT_SIZE] = [0; TT_SIZE];
static mut TT_DEPTH: [i8; TT_SIZE] = [0; TT_SIZE];
static mut TT_FLAG: [u8; TT_SIZE] = [0; TT_SIZE];
static mut TT_VALUE: [i16; TT_SIZE] = [0; TT_SIZE];
static mut TT_BEST_IDX: [i8; TT_SIZE] = [0; TT_SIZE];
static mut TT_BEST_END: [i8; TT_SIZE] = [0; TT_SIZE];
static mut TT_GEN: [u8; TT_SIZE] = [0; TT_SIZE];

/// Current generation counter (incremented each root search).
static mut TT_GENERATION: u8 = 0;

/// Result of a TT probe.
pub struct TtHit {
    pub best_idx: i8,
    pub best_end: i8,
    pub score: Option<i32>,
}

/// Increment the TT generation (call at each new root search).
#[inline]
pub fn tt_new_generation() {
    unsafe {
        TT_GENERATION = TT_GENERATION.wrapping_add(1);
    }
}

/// Clear the TT completely (rarely needed with generation counter).
pub fn tt_clear() {
    unsafe {
        for i in 0..TT_SIZE {
            TT_FLAG[i] = 0;
        }
    }
}

/// Probe the TT. Returns `None` if no entry, otherwise returns move hint
/// and optionally a usable score.
#[inline]
pub fn tt_probe(hash: i32, depth: i32, alpha: i32, beta: i32) -> Option<TtHit> {
    unsafe {
        let idx = (hash as u32 as usize) & TT_MASK;

        if TT_FLAG[idx] == 0 {
            return None;
        }
        if TT_HASH[idx] != hash {
            return None;
        }

        let mut result = TtHit {
            best_idx: TT_BEST_IDX[idx],
            best_end: TT_BEST_END[idx],
            score: None,
        };

        if TT_DEPTH[idx] as i32 >= depth {
            let val = TT_VALUE[idx] as i32;
            let flag = TT_FLAG[idx];
            if flag == TT_EXACT {
                result.score = Some(val);
            } else if flag == TT_LOWER && val >= beta {
                result.score = Some(val);
            } else if flag == TT_UPPER && val <= alpha {
                result.score = Some(val);
            }
        }

        Some(result)
    }
}

/// Store an entry in the TT. Uses replacement policy:
/// - Always replace empty slots
/// - Always replace entries from older generations
/// - Replace same-generation entries only if new depth >= stored depth
#[inline]
pub fn tt_store(hash: i32, depth: i32, flag: u8, value: i32, best_idx: i8, best_end: i8) {
    unsafe {
        let idx = (hash as u32 as usize) & TT_MASK;

        if TT_FLAG[idx] == 0
            || TT_GEN[idx] != TT_GENERATION
            || depth >= TT_DEPTH[idx] as i32
        {
            TT_HASH[idx] = hash;
            TT_DEPTH[idx] = depth as i8;
            TT_FLAG[idx] = flag;
            TT_VALUE[idx] = value as i16;
            TT_BEST_IDX[idx] = best_idx;
            TT_BEST_END[idx] = best_end;
            TT_GEN[idx] = TT_GENERATION;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tt_store_and_probe() {
        tt_clear();
        tt_new_generation();

        let hash = 0x12345678_u32 as i32;
        tt_store(hash, 5, TT_EXACT, 42, 3, 1);

        let hit = tt_probe(hash, 5, -1000, 1000);
        assert!(hit.is_some());
        let h = hit.unwrap();
        assert_eq!(h.best_idx, 3);
        assert_eq!(h.best_end, 1);
        assert_eq!(h.score, Some(42));
    }

    #[test]
    fn test_tt_depth_insufficient() {
        tt_clear();
        tt_new_generation();

        let hash = 0xABCDEF01_u32 as i32;
        tt_store(hash, 3, TT_EXACT, 10, 2, 0);

        // Probe at depth 5 — depth insufficient, but move hint available
        let hit = tt_probe(hash, 5, -1000, 1000);
        assert!(hit.is_some());
        let h = hit.unwrap();
        assert_eq!(h.best_idx, 2);
        assert_eq!(h.score, None); // No usable score
    }

    #[test]
    fn test_tt_lower_bound() {
        tt_clear();
        tt_new_generation();

        let hash = 0x11111111;
        tt_store(hash, 4, TT_LOWER, 50, 1, 0);

        // Lower bound of 50, beta = 40 → 50 >= 40 → cutoff
        let hit = tt_probe(hash, 4, 30, 40);
        assert!(hit.is_some());
        assert_eq!(hit.unwrap().score, Some(50));

        // Lower bound of 50, beta = 60 → 50 < 60 → no cutoff
        let hit2 = tt_probe(hash, 4, 30, 60);
        assert!(hit2.is_some());
        assert_eq!(hit2.unwrap().score, None);
    }

    #[test]
    fn test_tt_generation_replacement() {
        tt_clear();
        tt_new_generation();

        let hash = 0x22222222;
        tt_store(hash, 10, TT_EXACT, 100, 5, 1);

        // New generation → should replace even though old depth was higher
        tt_new_generation();
        tt_store(hash, 2, TT_EXACT, 200, 6, 0);

        let hit = tt_probe(hash, 2, -1000, 1000);
        assert!(hit.is_some());
        let h = hit.unwrap();
        assert_eq!(h.best_idx, 6);
        assert_eq!(h.score, Some(200));
    }
}
