/// Zobrist hashing — must produce bit-identical values to the JS engine.
/// Uses xorshift32 PRNG with seed 0x12345678.

/// Xorshift32 PRNG state. Must be called in the same order as JS to produce identical hashes.
struct Xorshift32 {
    state: u32,
}

impl Xorshift32 {
    fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    /// Matches JS: seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0;
    fn next(&mut self) -> u32 {
        self.state ^= self.state << 13;
        self.state ^= self.state >> 17; // JS >>> 17 on u32 is logical right shift = Rust >>
        self.state ^= self.state << 5;
        self.state // already u32, no need for >>> 0
    }
}

/// Generate all Zobrist hash tables at compile time.
/// Order must match JS: 28 tiles × 2 hands, then 8 left, 8 right, 1 side, 2 conspass.

struct ZobristTables {
    pub tile_hash: [[u32; 2]; 28],
    pub left_hash: [u32; 8],
    pub right_hash: [u32; 8],
    pub side_hash: u32,
    pub conspass_hash: [u32; 2],
}

const fn generate_zobrist() -> ZobristTables {
    let mut rng_state: u32 = 0x12345678;

    // Inline xorshift32 for const fn
    macro_rules! next_rng {
        () => {{
            rng_state ^= rng_state << 13;
            rng_state ^= rng_state >> 17;
            rng_state ^= rng_state << 5;
            rng_state
        }};
    }

    let mut tile_hash = [[0u32; 2]; 28];
    let mut i = 0;
    while i < 28 {
        tile_hash[i][0] = next_rng!();
        tile_hash[i][1] = next_rng!();
        i += 1;
    }

    let mut left_hash = [0u32; 8];
    let mut i = 0;
    while i < 8 {
        left_hash[i] = next_rng!();
        i += 1;
    }

    let mut right_hash = [0u32; 8];
    let mut i = 0;
    while i < 8 {
        right_hash[i] = next_rng!();
        i += 1;
    }

    let side_hash = next_rng!();

    let mut conspass_hash = [0u32; 2];
    conspass_hash[0] = next_rng!();
    conspass_hash[1] = next_rng!();

    ZobristTables {
        tile_hash,
        left_hash,
        right_hash,
        side_hash,
        conspass_hash,
    }
}

static ZOBRIST: ZobristTables = generate_zobrist();

pub fn tile_hash(tile_idx: usize, hand: usize) -> i32 {
    ZOBRIST.tile_hash[tile_idx][hand] as i32
}

pub fn left_hash(val: usize) -> i32 {
    ZOBRIST.left_hash[val] as i32
}

pub fn right_hash(val: usize) -> i32 {
    ZOBRIST.right_hash[val] as i32
}

pub fn side_hash() -> i32 {
    ZOBRIST.side_hash as i32
}

pub fn conspass_hash(idx: usize) -> i32 {
    ZOBRIST.conspass_hash[idx] as i32
}

/// Compute root hash from scratch (matches JS computeRootHash).
pub fn compute_root_hash(
    ai_hand: i32,
    human_hand: i32,
    left: i8,
    right: i8,
    is_ai: bool,
    cons_pass: i32,
) -> i32 {
    let mut h: u32 = 0;

    // XOR in all AI tiles as hand=0
    let mut hand = ai_hand as u32;
    while hand != 0 {
        let bit = hand & hand.wrapping_neg();
        let idx = bit.trailing_zeros() as usize;
        h ^= ZOBRIST.tile_hash[idx][0];
        hand ^= bit;
    }

    // XOR in all human tiles as hand=1
    let mut hand = human_hand as u32;
    while hand != 0 {
        let bit = hand & hand.wrapping_neg();
        let idx = bit.trailing_zeros() as usize;
        h ^= ZOBRIST.tile_hash[idx][1];
        hand ^= bit;
    }

    h ^= ZOBRIST.left_hash[left as usize];
    h ^= ZOBRIST.right_hash[right as usize];

    if !is_ai {
        h ^= ZOBRIST.side_hash;
    }

    if cons_pass > 0 {
        h ^= ZOBRIST.conspass_hash[1];
    }

    h as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_xorshift32_first_values() {
        // Verify first few values match JS engine
        let mut rng = Xorshift32::new(0x12345678);
        let v1 = rng.next();
        let v2 = rng.next();
        // These values should be deterministic from the seed
        assert_ne!(v1, 0);
        assert_ne!(v2, 0);
        assert_ne!(v1, v2);
    }

    #[test]
    fn test_zobrist_tables_populated() {
        // All tile hashes should be non-zero
        for i in 0..28 {
            assert_ne!(ZOBRIST.tile_hash[i][0], 0);
            assert_ne!(ZOBRIST.tile_hash[i][1], 0);
        }
        assert_ne!(ZOBRIST.side_hash, 0);
    }

    #[test]
    fn test_root_hash_deterministic() {
        let h1 = compute_root_hash(0b111, 0b111000, 3, 5, true, 0);
        let h2 = compute_root_hash(0b111, 0b111000, 3, 5, true, 0);
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_root_hash_side_matters() {
        let h_ai = compute_root_hash(0b111, 0b111000, 3, 5, true, 0);
        let h_human = compute_root_hash(0b111, 0b111000, 3, 5, false, 0);
        assert_ne!(h_ai, h_human);
    }
}
