/// WASM entry point — single exported function that accepts JSON, runs search, returns JSON.
/// Called from ai-worker.js via wasm_bindgen.

mod lookup;
mod zobrist;
mod tt;
mod movegen;
mod scoring;
mod eval;
mod ordering;
mod search;

use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};

// =====================================================================
// Serde types matching the JS worker message format
// =====================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TileDesc {
    low: i8,
    high: i8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveHistoryEntry {
    player: String,
    #[serde(default)]
    pass: bool,
    #[serde(default)]
    tile_low: i8,
    #[serde(default)]
    tile_high: i8,
    #[serde(default)]
    board_left: i8,
    #[serde(default)]
    board_right: i8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MatchScore {
    ai: i32,
    human: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchInput {
    ai_tiles: Vec<TileDesc>,
    human_tiles: Vec<TileDesc>,
    #[serde(default)]
    board_empty: bool,
    #[serde(default)]
    left: Option<i8>,
    #[serde(default)]
    right: Option<i8>,
    #[serde(default)]
    move_history: Vec<MoveHistoryEntry>,
    #[serde(default)]
    legal_moves: Vec<LegalMoveDesc>,
    #[serde(default)]
    match_score: Option<MatchScore>,
    #[serde(default)]
    time_budget: Option<f64>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LegalMoveDesc {
    tile_low: i8,
    tile_high: i8,
    end: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisEntry {
    tile_id: String,
    end: String,
    score: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchOutput {
    tile_id: String,
    end: String,
    best_score: i32,
    depth: i32,
    nodes: u32,
    analysis: Vec<AnalysisEntry>,
    // TT diagnostics (included in JSON for debugging; ignored by UI)
    #[serde(skip_serializing_if = "Option::is_none")]
    tt_probes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tt_hits: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tt_cutoffs: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tt_hints: Option<u32>,
}

// =====================================================================
// WASM exported function
// =====================================================================

#[wasm_bindgen]
pub fn wasm_choose_move(input_json: &str) -> String {
    let input: SearchInput = match serde_json::from_str(input_json) {
        Ok(v) => v,
        Err(_e) => {
            return serde_json::to_string(&SearchOutput {
                tile_id: String::new(),
                end: String::new(),
                best_score: 0,
                depth: 0,
                nodes: 0,
                analysis: vec![],
                tt_probes: None,
                tt_hits: None,
                tt_cutoffs: None,
                tt_hints: None,
            }).unwrap_or_else(|_| "{}".to_string());
        }
    };

    // Convert tile descriptors to bitmasks
    let mut ai_hand: i32 = 0;
    for t in &input.ai_tiles {
        let lo = t.low.min(t.high);
        let hi = t.low.max(t.high);
        let idx = lookup::tile_id_to_index(lo, hi);
        ai_hand |= 1 << idx;
    }
    let mut human_hand: i32 = 0;
    for t in &input.human_tiles {
        let lo = t.low.min(t.high);
        let hi = t.low.max(t.high);
        let idx = lookup::tile_id_to_index(lo, hi);
        human_hand |= 1 << idx;
    }

    let left: i8 = if input.board_empty { 7 } else { input.left.unwrap_or(7) };
    let right: i8 = if input.board_empty { 7 } else { input.right.unwrap_or(7) };

    let match_diff = input.match_score.as_ref()
        .map(|ms| ms.ai - ms.human)
        .unwrap_or(0);

    // Seed puppeteer history from move_history
    let mut p1_who: i8 = -1;
    let mut p1_l: i8 = 0;
    let mut p1_r: i8 = 0;
    let mut p1_tile: i8 = -1;
    let mut p2_who: i8 = -1;
    let mut p2_l: i8 = 0;
    let mut p2_r: i8 = 0;

    let mut placement_count = 0;
    for entry in input.move_history.iter().rev() {
        if placement_count >= 2 { break; }
        if !entry.pass {
            if placement_count == 0 {
                p1_who = if entry.player == "ai" { 1 } else { 0 };
                p1_l = entry.board_left;
                p1_r = entry.board_right;
                let t_lo = entry.tile_low.min(entry.tile_high);
                let t_hi = entry.tile_low.max(entry.tile_high);
                p1_tile = lookup::tile_id_to_index(t_lo, t_hi) as i8;
            } else {
                p2_who = if entry.player == "ai" { 1 } else { 0 };
                p2_l = entry.board_left;
                p2_r = entry.board_right;
            }
            placement_count += 1;
        }
    }

    let time_budget = input.time_budget.unwrap_or(5000.0);

    // Run the search
    let result = search::choose_move(
        ai_hand, human_hand, left, right,
        0, // cons_pass always 0 at root (AI is about to move)
        match_diff,
        p1_who, p1_l, p1_r, p1_tile,
        p2_who, p2_l, p2_r,
        time_budget,
    );

    // Map result back to tile ID format
    let best_tile_id = if result.best_tile_idx >= 0 {
        let idx = result.best_tile_idx as usize;
        format!("{}-{}", lookup::TILE_LOW[idx], lookup::TILE_HIGH[idx])
    } else if !input.legal_moves.is_empty() {
        // Fallback to first legal move
        let lm = &input.legal_moves[0];
        let lo = lm.tile_low.min(lm.tile_high);
        let hi = lm.tile_low.max(lm.tile_high);
        format!("{}-{}", lo, hi)
    } else {
        String::new()
    };

    let best_end = if result.best_end == 0 {
        "left".to_string()
    } else if result.best_end == 1 {
        "right".to_string()
    } else if !input.legal_moves.is_empty() {
        input.legal_moves[0].end.clone()
    } else {
        "left".to_string()
    };

    // Try to match the best move to a legal move (validate)
    let final_tile_id;
    let final_end;
    if find_legal_move(&input.legal_moves, &best_tile_id, &best_end).is_some() {
        final_tile_id = best_tile_id;
        final_end = best_end;
    } else if let Some(lm) = find_legal_move_by_tile(&input.legal_moves, &best_tile_id) {
        final_end = lm.end.clone();
        final_tile_id = best_tile_id;
    } else if !input.legal_moves.is_empty() {
        let lm = &input.legal_moves[0];
        let lo = lm.tile_low.min(lm.tile_high);
        let hi = lm.tile_low.max(lm.tile_high);
        final_tile_id = format!("{}-{}", lo, hi);
        final_end = lm.end.clone();
    } else {
        final_tile_id = String::new();
        final_end = "left".to_string();
    }

    // Build analysis array
    let mut analysis: Vec<AnalysisEntry> = result.analysis.iter().map(|&(ti, ei, sc)| {
        let idx = ti as usize;
        AnalysisEntry {
            tile_id: format!("{}-{}", lookup::TILE_LOW[idx], lookup::TILE_HIGH[idx]),
            end: if ei == 0 { "left".to_string() } else { "right".to_string() },
            score: sc,
        }
    }).collect();
    analysis.sort_by(|a, b| b.score.cmp(&a.score));

    let output = SearchOutput {
        tile_id: final_tile_id,
        end: final_end,
        best_score: result.best_score,
        depth: result.depth,
        nodes: result.nodes,
        analysis,
        tt_probes: Some(result.tt_probes),
        tt_hits: Some(result.tt_hits),
        tt_cutoffs: Some(result.tt_cutoffs),
        tt_hints: Some(result.tt_hints),
    };

    serde_json::to_string(&output).unwrap_or_else(|_| "{}".to_string())
}

fn find_legal_move<'a>(moves: &'a [LegalMoveDesc], tile_id: &str, end: &str) -> Option<&'a LegalMoveDesc> {
    moves.iter().find(|lm| {
        let lo = lm.tile_low.min(lm.tile_high);
        let hi = lm.tile_low.max(lm.tile_high);
        let lm_id = format!("{}-{}", lo, hi);
        lm_id == tile_id && lm.end == end
    })
}

fn find_legal_move_by_tile<'a>(moves: &'a [LegalMoveDesc], tile_id: &str) -> Option<&'a LegalMoveDesc> {
    moves.iter().find(|lm| {
        let lo = lm.tile_low.min(lm.tile_high);
        let hi = lm.tile_low.max(lm.tile_high);
        let lm_id = format!("{}-{}", lo, hi);
        lm_id == tile_id
    })
}
