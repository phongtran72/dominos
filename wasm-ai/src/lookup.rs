/// Tile indexing and lookup tables for the double-six domino set (28 tiles).
/// Tile ordering: (0,0),(0,1),(0,2),...,(0,6),(1,1),(1,2),...,(6,6)

pub const NUM_TILES: usize = 28;

/// Low pip value for each tile index
pub static TILE_LOW: [i8; NUM_TILES] = {
    let mut t = [0i8; NUM_TILES];
    let mut idx = 0;
    let mut i = 0i8;
    while i <= 6 {
        let mut j = i;
        while j <= 6 {
            t[idx] = i;
            idx += 1;
            j += 1;
        }
        i += 1;
    }
    t
};

/// High pip value for each tile index
pub static TILE_HIGH: [i8; NUM_TILES] = {
    let mut t = [0i8; NUM_TILES];
    let mut idx = 0;
    let mut i = 0i8;
    while i <= 6 {
        let mut j = i;
        while j <= 6 {
            t[idx] = j;
            idx += 1;
            j += 1;
        }
        i += 1;
    }
    t
};

/// Total pips for each tile
pub static TILE_PIPS: [i8; NUM_TILES] = {
    let mut t = [0i8; NUM_TILES];
    let mut idx = 0;
    let mut i = 0i8;
    while i <= 6 {
        let mut j = i;
        while j <= 6 {
            t[idx] = i + j;
            idx += 1;
            j += 1;
        }
        i += 1;
    }
    t
};

/// Whether tile is a double
pub static TILE_IS_DOUBLE: [bool; NUM_TILES] = {
    let mut t = [false; NUM_TILES];
    let mut idx = 0;
    let mut i = 0i8;
    while i <= 6 {
        let mut j = i;
        while j <= 6 {
            t[idx] = i == j;
            idx += 1;
            j += 1;
        }
        i += 1;
    }
    t
};

/// Bitmask of tiles containing each suit value (0-6)
pub static SUIT_MASK: [i32; 7] = {
    let mut m = [0i32; 7];
    let mut idx = 0u32;
    let mut i = 0;
    while i <= 6 {
        let mut j = i;
        while j <= 6 {
            m[i as usize] |= 1 << idx;
            if i != j {
                m[j as usize] |= 1 << idx;
            }
            idx += 1;
            j += 1;
        }
        i += 1;
    }
    m
};

/// Bitmask of all double tiles
pub static DOUBLE_MASK: i32 = {
    let mut mask = 0i32;
    let mut idx = 0u32;
    let mut i = 0;
    while i <= 6 {
        let mut j = i;
        while j <= 6 {
            if i == j {
                mask |= 1 << idx;
            }
            idx += 1;
            j += 1;
        }
        i += 1;
    }
    mask
};

/// Bit for [0-0] tile
pub const TILE_00_BIT: i32 = 1; // index 0 = (0,0), bit = 1<<0

/// Bitmask of [0-1] through [0-6] (zero suit excluding [0-0])
pub static ZERO_SUIT_NO_00: i32 = {
    SUIT_MASK[0] & !TILE_00_BIT
};

/// New left end after placing tile t on board with left end v.
/// Index: t * 8 + v. v=7 means empty board. Returns -1 if illegal.
pub static NEW_END_LEFT: [i8; NUM_TILES * 8] = {
    let mut table = [-1i8; NUM_TILES * 8];
    let mut idx = 0;
    let mut i = 0i8;
    while i <= 6 {
        let mut j = i;
        while j <= 6 {
            // t = idx, lo = i, hi = j
            let mut v = 0;
            while v <= 6 {
                let off = idx * 8 + v;
                if j == v as i8 {
                    table[off] = i;
                } else if i == v as i8 {
                    table[off] = j;
                }
                // else stays -1
                v += 1;
            }
            // v=7: empty board
            table[idx * 8 + 7] = i;
            idx += 1;
            j += 1;
        }
        i += 1;
    }
    table
};

/// New right end after placing tile t on board with right end v.
pub static NEW_END_RIGHT: [i8; NUM_TILES * 8] = {
    let mut table = [-1i8; NUM_TILES * 8];
    let mut idx = 0;
    let mut i = 0i8;
    while i <= 6 {
        let mut j = i;
        while j <= 6 {
            let mut v = 0;
            while v <= 6 {
                let off = idx * 8 + v;
                if i == v as i8 {
                    table[off] = j;
                } else if j == v as i8 {
                    table[off] = i;
                }
                v += 1;
            }
            table[idx * 8 + 7] = j;
            idx += 1;
            j += 1;
        }
        i += 1;
    }
    table
};

/// Map (low, high) pip values to tile index. low <= high required.
pub static TILE_ID_MAP: [[i8; 7]; 7] = {
    let mut m = [[-1i8; 7]; 7];
    let mut idx = 0i8;
    let mut i = 0;
    while i <= 6 {
        let mut j = i;
        while j <= 6 {
            m[i][j] = idx;
            idx += 1;
            j += 1;
        }
        i += 1;
    }
    m
};

#[inline(always)]
pub fn tile_id_to_index(low: i8, high: i8) -> usize {
    let lo = low.min(high) as usize;
    let hi = low.max(high) as usize;
    TILE_ID_MAP[lo][hi] as usize
}

#[inline(always)]
pub fn popcount(x: i32) -> i32 {
    (x as u32).count_ones() as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tile_count() {
        // Should have exactly 28 tiles
        let mut count = 0;
        for i in 0..=6 {
            for j in i..=6 {
                let idx = TILE_ID_MAP[i][j];
                assert!(idx >= 0 && idx < 28, "Invalid index for ({},{}): {}", i, j, idx);
                count += 1;
            }
        }
        assert_eq!(count, 28);
    }

    #[test]
    fn test_tile_low_high() {
        assert_eq!(TILE_LOW[0], 0);
        assert_eq!(TILE_HIGH[0], 0);
        assert_eq!(TILE_LOW[27], 6);
        assert_eq!(TILE_HIGH[27], 6);
        // [0-6] should be index 6
        assert_eq!(TILE_LOW[6], 0);
        assert_eq!(TILE_HIGH[6], 6);
    }

    #[test]
    fn test_suit_mask() {
        // Suit 0 should have 7 tiles
        assert_eq!(popcount(SUIT_MASK[0]), 7);
        // Suit 6 should have 7 tiles
        assert_eq!(popcount(SUIT_MASK[6]), 7);
    }

    #[test]
    fn test_double_mask() {
        // 7 doubles: 0-0, 1-1, ..., 6-6
        assert_eq!(popcount(DOUBLE_MASK), 7);
    }

    #[test]
    fn test_zero_suit_no_00() {
        // Should have 6 bits (0-1 through 0-6)
        assert_eq!(popcount(ZERO_SUIT_NO_00), 6);
        assert_eq!(ZERO_SUIT_NO_00 & TILE_00_BIT, 0);
    }

    #[test]
    fn test_new_end_left() {
        // Tile [0-6] (idx 6) placed on left end 6 → new left = 0
        let idx = tile_id_to_index(0, 6);
        assert_eq!(NEW_END_LEFT[idx * 8 + 6], 0);
        // Tile [0-6] on left end 0 → new left = 6
        assert_eq!(NEW_END_LEFT[idx * 8 + 0], 6);
        // Tile [0-6] on left end 3 → illegal
        assert_eq!(NEW_END_LEFT[idx * 8 + 3], -1);
    }

    #[test]
    fn test_new_end_right() {
        // Tile [3-5] (idx = tile_id_to_index(3,5)) placed on right end 3 → new right = 5
        let idx = tile_id_to_index(3, 5);
        assert_eq!(NEW_END_RIGHT[idx * 8 + 3], 5);
        // On right end 5 → new right = 3
        assert_eq!(NEW_END_RIGHT[idx * 8 + 5], 3);
    }

    #[test]
    fn test_popcount() {
        assert_eq!(popcount(0), 0);
        assert_eq!(popcount(1), 1);
        assert_eq!(popcount(0b1111), 4);
        assert_eq!(popcount(0x0FFFFFFF), 28);
    }
}
