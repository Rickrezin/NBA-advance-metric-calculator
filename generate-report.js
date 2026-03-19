/**
 * QPIX™ NBA Daily Performance Index — generate-report.js
 * QCore Labs | QCoreLabs.com
 *
 * 13-Category Engine:
 *  1.  Base Production
 *  2.  Shooting Efficiency
 *  3.  Proprietary Off/Def ± Split
 *  4.  Defensive Activity
 *  5.  Playmaking Quality
 *  6.  Offensive Context
 *  7.  Gravity Score
 *  8.  Context-Weighted +/− (with environment gate)
 *  9.  Multi-Category Bonuses
 * 10.  Fatigue Curve Index
 * 11.  Momentum Swing Value
 * 12.  Second Unit Anchor
 * 13.  QPIX-R (Referee Normalization Layer)
 */

import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDryRun = process.argv.includes("--dry-run");

// ─── DATE HELPERS ─────────────────────────────────────────────────
function getYesterdayET() {
  const now = new Date();
  const etOffset = isDST(now) ? -4 : -5;
  const et = new Date(now.getTime() + etOffset * 60 * 60 * 1000);
  et.setDate(et.getDate() - 1);
  return {
    year: et.getFullYear(),
    month: String(et.getMonth() + 1).padStart(2, "0"),
    day: String(et.getDate()).padStart(2, "0"),
    label: et.toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric",
      year: "numeric", timeZone: "America/New_York"
    })
  };
}

function isDST(date) {
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  return Math.min(jan, jul) === date.getTimezoneOffset();
}

// ─── SPORTRADAR NBA API ───────────────────────────────────────────
async function fetchNBAScores(date) {
  const { year, month, day } = date;
  const apiKey = process.env.SPORTRADAR_API_KEY || "YOUR_SPORTRADAR_TRIAL_KEY";
  const url = `https://api.sportradar.com/nba/trial/v8/en/games/${year}/${month}/${day}/schedule.json?api_key=${apiKey}`;

  if (isDryRun) {
    console.log(`[DRY RUN] Would fetch scores for ${year}-${month}-${day}`);
    return getMockData(date);
  }

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error("Failed to fetch scores:", err.message);
    return getMockData(date);
  }
}

async function fetchGameBoxScore(gameId) {
  const apiKey = process.env.SPORTRADAR_API_KEY || "YOUR_SPORTRADAR_TRIAL_KEY";
  const url = `https://api.sportradar.com/nba/trial/v8/en/games/${gameId}/summary.json?api_key=${apiKey}`;

  if (isDryRun) return null;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`Failed to fetch boxscore ${gameId}:`, err.message);
    return null;
  }
}

// ─── TS% HELPER ───────────────────────────────────────────────────
function computeTS(p) {
  const denom = 2 * ((p.fga || 0) + 0.44 * (p.fta || 0));
  return denom > 0 ? ((p.points || 0) / denom) * 100 : 0;
}

function pm_positive(p) {
  return (p.plus_minus || 0) > 0;
}

// ─── QPIX™ 13-CATEGORY ENGINE ─────────────────────────────────────

// C1 — BASE PRODUCTION
// PTS×1 + REB×1.2 + AST×1.5 + STL×3 + BLK×2.5 − TO×2
function computeC1(p) {
  return (
    p.points * 1.0 +
    p.rebounds * 1.2 +
    p.assists * 1.5 +
    p.steals * 3.0 +
    p.blocks * 2.5 -
    p.turnovers * 2.0
  );
}

// C2 — SHOOTING EFFICIENCY
// TS% delta vs 55% baseline × 0.3, foul drawing bonus, inefficiency penalty
function computeC2(p) {
  const ts = computeTS(p);
  let score = (ts - 55) * 0.3;
  if (p.fta >= 8) score += 3;
  else if (p.fta >= 5) score += 1.5;
  if (ts < 38 && p.fga > 5) score -= 4;
  return { score, ts };
}

// C3 — PROPRIETARY OFF/DEF ± SPLIT
// Both sides measured against 110 baseline, weighted equally — the QPIX™ moat
function computeC3(p) {
  const offImpact = (p.offensive_rating - 110) / 10;
  const defImpact = (110 - p.defensive_rating) / 10;
  return {
    score: offImpact * 2 + defImpact * 2,
    offImpact: Math.round(offImpact * 10) / 10,
    defImpact: Math.round(defImpact * 10) / 10
  };
}

// C4 — DEFENSIVE ACTIVITY
// Stocks tiered by volume, dreb threshold, elite anchor bonus
function computeC4(p) {
  let score = 0;
  const notes = [];
  const stocks = (p.steals || 0) + (p.blocks || 0);

  if (stocks >= 5)      { score += 8; notes.push(`${stocks} stocks (elite)`); }
  else if (stocks >= 4) { score += 5; notes.push(`${stocks} stocks`); }
  else if (stocks >= 3) { score += 3; notes.push(`${stocks} stocks`); }
  else if (stocks >= 2) { score += 1.5; }

  if ((p.defensive_rebounds || 0) >= 8) score += 2;

  if (p.defensive_rating < 96 && p.minutes >= 20) {
    score += 6;
    notes.push(`Elite anchor (DefRtg: ${p.defensive_rating?.toFixed(1)})`);
  } else if (p.defensive_rating < 100 && p.minutes >= 20) {
    score += 2;
  }

  return { score, notes };
}

// C5 — PLAYMAKING QUALITY
// AST/TO ratio tiered with volume gates, zero-TO bonus
function computeC5(p) {
  let score = 0;
  const notes = [];
  const ast = p.assists || 0;
  const to = p.turnovers || 0;
  const astToRatio = to > 0 ? ast / to : ast;

  if (ast >= 10) {
    if (astToRatio >= 4.0)      { score += 8; notes.push(`Elite playmaking (${ast}ast/${to}TO)`); }
    else if (astToRatio >= 2.5) { score += 5; notes.push(`Strong playmaking (${ast}ast/${to}TO)`); }
    else                        { score += 2; }
  } else if (ast >= 6) {
    if (astToRatio >= 4.0)      { score += 5; notes.push(`AST/TO ${astToRatio.toFixed(1)}`); }
    else if (astToRatio >= 2.0) { score += 2.5; }
  } else if (ast >= 3) {
    if (astToRatio >= 3.0) score += 1.5;
  }

  if (to === 0 && ast >= 3) {
    score += 2;
    notes.push("Zero turnovers");
  }

  return { score, notes };
}

// C6 — OFFENSIVE CONTEXT
// 2nd chance pts, fast break pts, points in paint
function computeC6(p) {
  let score = 0;
  const notes = [];

  const scp = p.second_chance_points || 0;
  const fbp = p.fast_break_points || 0;
  const pip = p.points_in_paint || 0;

  if (scp > 0) {
    score += scp * 0.8;
    if (scp >= 6) notes.push(`${scp} 2nd-chance pts`);
  }
  if (fbp > 0) {
    score += fbp * 0.5;
    if (fbp >= 6) notes.push(`${fbp} fast break pts`);
  }
  if (pip >= 12)     score += 3;
  else if (pip >= 8) score += 1.5;

  return { score, notes };
}

// C7 — GRAVITY SCORE
// Usage proxy + assist rate space creation signal
function computeC7(p) {
  let score = 0;
  const usageProxy = (p.fga || 0) + (p.fta || 0) * 0.44;

  if (usageProxy >= 20 && p.points >= 25)      score += 3;
  else if (usageProxy >= 15 && p.points >= 20) score += 1.5;

  if (p.assists >= 8)     score += 2;
  else if (p.assists >= 5) score += 1;

  return score;
}

// C8 — CONTEXT-WEIGHTED +/− (ENVIRONMENT GATE)
//
// Gate:
//   IF player +/− >= −5 → apply full raw deduction as normal
//   IF player +/− < −5  → fire 3-layer context model:
//     Layer 1: R+/− = Player +/− − Team Average +/−
//     Layer 2: Opponent Strength Multiplier (OSM)
//       Elite (Top 3, 7+ win streak, #1 defense): ×1.30
//       Strong (4-6 seed, winning record): ×1.10
//       Neutral (~.500): ×1.00
//       Weak (Bottom 6, losing record): ×0.80
//     Layer 3: Environment Bonus (max +5.5)
//       Road game: +1.5
//       Isolation carrier (usage >30%, 3+ teammates <10pts): +2.0 to +4.0
function computeC8(p, gameContext) {
  let score = 0;
  const notes = [];
  const pm = p.plus_minus || 0;

  if (pm >= 15) notes.push(`+${pm} net differential`);

  if (pm >= -5) {
    // Standard — player owns this result
    score = pm * 0.4;
  } else {
    // Gate fires — context model
    const teamAvgPM = gameContext?.teamAvgPlusMinus ?? 0;
    const relativePM = pm - teamAvgPM;
    const osm = gameContext?.opponentStrength ?? 1.0;
    const contextScore = relativePM * osm;

    let envBonus = 0;
    if (gameContext?.isRoad) envBonus += 1.5;
    if (gameContext?.isolationCarrier) {
      envBonus += Math.min(4.0, gameContext.isolationSeverity ?? 2.0);
    }
    envBonus = Math.min(envBonus, 5.5);

    score = (contextScore * 0.4) + envBonus;

    if (teamAvgPM < -8) notes.push(`Context gate: team avg ${teamAvgPM.toFixed(1)} +/−`);
    if (envBonus > 0)   notes.push(`Environment bonus +${envBonus.toFixed(1)}`);
  }

  return { score, notes };
}

// C9 — MULTI-CATEGORY BONUSES
// DD (+6), TD (+15), near-TD (+4), 5×5 (+10)
function computeC9(p) {
  let score = 0;
  const notes = [];

  const ddCats = [
    p.points >= 10,
    p.rebounds >= 10,
    p.assists >= 10,
    p.steals >= 5,
    p.blocks >= 5
  ].filter(Boolean).length;

  if (ddCats >= 3)      { score += 15; notes.push("TRIPLE-DOUBLE (+15)"); }
  else if (ddCats >= 2) { score += 6;  notes.push("Double-double (+6)"); }

  // Near-TD: two categories at 10+ and one at 7+
  if (ddCats === 2) {
    const nearCats = [p.points >= 7, p.rebounds >= 7, p.assists >= 7].filter(Boolean).length;
    if (nearCats >= 3) { score += 4; notes.push("Near triple-double (+4)"); }
  }

  // 5×5
  if (p.points >= 5 && p.rebounds >= 5 && p.assists >= 5 && p.steals >= 5 && p.blocks >= 5) {
    score += 10;
    notes.push("5×5 (+10)");
  }

  return { score, notes };
}

// C10 — FATIGUE CURVE INDEX
// Heavy minutes + maintained efficiency = positive; efficiency drop = negative
function computeC10(p) {
  const ts = p._ts || computeTS(p);
  if (p.minutes >= 35 && ts >= 58) return 2;
  if (p.minutes >= 35 && ts < 45)  return -2;
  return 0;
}

// C11 — MOMENTUM SWING VALUE
// Won game + positive +/− + high scoring + fast break production
function computeC11(p, gameContext) {
  let score = 0;
  if (gameContext?.wonGame && pm_positive(p) && p.points >= 20) score += 3;
  const fbp = p.fast_break_points || 0;
  if (fbp >= 8)     score += 2;
  else if (fbp >= 5) score += 1;
  return score;
}

// C12 — SECOND UNIT ANCHOR
// Bench players with positive +/− in meaningful minutes
function computeC12(p, gameContext) {
  let score = 0;
  const notes = [];
  const pm = p.plus_minus || 0;

  if (gameContext?.isBenchPlayer) {
    if (p.minutes >= 20 && pm > 8) {
      score += 8;
      notes.push("Dominant bench contribution (+8)");
    } else if (p.minutes >= 15 && pm >= 0) {
      score += 5;
      notes.push("Second unit anchor (+5)");
    }
  }

  return { score, notes };
}

// C13 — QPIX-R (REFEREE NORMALIZATION LAYER)
// Bidirectional whistle adjustment — post-processor companion score
// Raw QPIX always leads. QPIX-R displayed alongside.
//
// Type 1 — Whistle Inflation (penalty):
//   RefPenalty = (0.6 × Δ_FTpts) + (0.3 × Δ_FTA) — only when Δ_FTA > 0
//
// Type 2 — Whistle Suppression (bonus):
//   RefBonus = (0.6 × FTpts_missed) + (0.3 × FTA_suppression_delta) — only when FTA < expected
//
// QPIX-R = QPIX_raw − RefPenalty + RefBonus
//
// Seasonal FTA baselines (2025-26). Falls back to positional default
// for players not listed. Update periodically as season progresses.
// Target upgrade: rolling 20-game per-player baseline.
function computeC13_QPIXR(p, qpixRaw) {
  const seasonalFTA = {
    // Guards
    "Luka Doncic": 10.1,
    "Shai Gilgeous-Alexander": 9.1,
    "Deni Avdija": 9.0,
    "James Harden": 7.8,
    "Jaylen Brown": 7.3,
    "Keyonte George": 7.0,
    "Anthony Edwards": 7.4,
    "Donovan Mitchell": 6.2,
    "Tyrese Maxey": 6.1,
    "Jalen Brunson": 5.9,
    "LaMelo Ball": 5.2,
    "De'Aaron Fox": 4.8,
    "Trae Young": 5.6,
    "Damian Lillard": 5.4,
    "CJ McCollum": 3.8,
    "Dejounte Murray": 4.2,
    "Immanuel Quickley": 3.6,
    "Scoot Henderson": 4.1,
    "Jrue Holiday": 2.8,
    "Payton Pritchard": 2.4,
    // Forwards
    "Zion Williamson": 7.6,
    "Paolo Banchero": 8.1,
    "Kawhi Leonard": 6.8,
    "Kevin Durant": 5.9,
    "Pascal Siakam": 6.2,
    "Jayson Tatum": 4.6,
    "Julius Randle": 6.2,
    "Brandon Ingram": 4.8,
    "Jalen Johnson": 3.4,
    "OG Anunoby": 3.2,
    "Mikal Bridges": 2.6,
    "Josh Hart": 3.8,
    "Scottie Barnes": 4.4,
    "Cooper Flagg": 4.2,
    "Giannis Antetokounmpo": 8.8,
    "P.J. Washington": 3.6,
    "Christian Braun": 3.2,
    "Nickeil Alexander-Walker": 3.4,
    "Dyson Daniels": 3.1,
    "Saddiq Bey": 3.8,
    // Centers
    "Nikola Jokic": 7.7,
    "Karl-Anthony Towns": 4.8,
    "Bam Adebayo": 5.2,
    "Alperen Sengun": 5.8,
    "Donovan Clingan": 4.2,
    "Chet Holmgren": 4.4,
    "Victor Wembanyama": 6.9,
    "Jakob Poeltl": 3.8,
    "Jalen Duren": 5.6,
    "Rudy Gobert": 3.2,
    "Draymond Green": 3.4,
    "Amen Thompson": 4.8,
    "Isaiah Hartenstein": 3.0,
    "Yves Missi": 3.2,
  };

  // Positional fallback for unlisted players
  const ftaPositionDefaults = {
    "C": 4.5, "F": 3.5, "G": 2.5,
    "F-C": 4.0, "C-F": 4.0, "G-F": 3.0, "F-G": 3.0
  };

  const posKey = (p.position || "G").toUpperCase();
  const ftaExpected = seasonalFTA[p.name] ?? ftaPositionDefaults[posKey] ?? 3.0;
  const ftaActual = p.fta || 0;
  const ftaDelta = ftaActual - ftaExpected;
  const ftPct = p.ft_pct || 0.75;

  let refPenalty = 0;
  let refBonus = 0;
  let qpixRFlag = null;

  if (ftaDelta > 1.5) {
    // Type 1 — Whistle Inflation
    const ftPtsInflated = ftaDelta * ftPct;
    refPenalty = Math.max(0, (0.6 * ftPtsInflated) + (0.3 * ftaDelta));
    qpixRFlag = `Whistle inflation: +${ftaDelta.toFixed(1)} FTA above baseline`;
  } else if (ftaDelta < -1.5) {
    // Type 2 — Whistle Suppression
    const suppressionDelta = Math.abs(ftaDelta);
    const ftPtsMissed = suppressionDelta * ftPct;
    refBonus = Math.max(0, (0.6 * ftPtsMissed) + (0.3 * suppressionDelta));
    qpixRFlag = `Whistle suppression: ${ftaDelta.toFixed(1)} FTA below baseline`;
  }

  return {
    qpixR: Math.round((qpixRaw - refPenalty + refBonus) * 10) / 10,
    refPenalty: Math.round(refPenalty * 10) / 10,
    refBonus: Math.round(refBonus * 10) / 10,
    qpixRFlag
  };
}

// ─── MAIN QPIX™ COMPUTE FUNCTION ─────────────────────────────────
function computeQPIX(p, gameContext = {}) {
  let total = 0;
  const notes = [];

  // C1
  total += computeC1(p);

  // C2
  const { score: c2score, ts } = computeC2(p);
  total += c2score;
  p._ts = ts;
  if (ts >= 70) notes.push(`Elite TS% (${ts.toFixed(1)}%)`);

  // C3
  const { score: c3score, offImpact, defImpact } = computeC3(p);
  total += c3score;
  if (offImpact > 2)   notes.push(`Dominant off presence (OffRtg: ${p.offensive_rating?.toFixed(1)})`);
  if (defImpact > 1.5) notes.push(`Strong def impact (DefRtg: ${p.defensive_rating?.toFixed(1)})`);

  // C4
  const { score: c4score, notes: c4n } = computeC4(p);
  total += c4score;
  notes.push(...c4n);

  // C5
  const { score: c5score, notes: c5n } = computeC5(p);
  total += c5score;
  notes.push(...c5n);

  // C6
  const { score: c6score, notes: c6n } = computeC6(p);
  total += c6score;
  notes.push(...c6n);

  // C7
  total += computeC7(p);

  // C8
  const { score: c8score, notes: c8n } = computeC8(p, gameContext);
  total += c8score;
  notes.push(...c8n);

  // C9
  const { score: c9score, notes: c9n } = computeC9(p);
  total += c9score;
  notes.push(...c9n);

  // C10
  total += computeC10(p);

  // C11
  total += computeC11(p, gameContext);

  // C12
  const { score: c12score, notes: c12n } = computeC12(p, gameContext);
  total += c12score;
  notes.push(...c12n);

  const qpixRaw = Math.round(total * 10) / 10;

  // C13 — QPIX-R post-processor (displayed separately, never modifies raw)
  const { qpixR, refPenalty, refBonus, qpixRFlag } = computeC13_QPIXR(p, qpixRaw);
  if (qpixRFlag) notes.push(`QPIX-R flag: ${qpixRFlag}`);

  return {
    score: qpixRaw,
    qpixR,
    refPenalty,
    refBonus,
    notes,
    offImpact,
    defImpact,
    ts
  };
}

// ─── BUILD GAME CONTEXT ───────────────────────────────────────────
function buildGameContext(player, allGamePlayers, gameResult) {
  const teamPlayers = allGamePlayers.filter(p => p.team === player.team);
  const teamPMValues = teamPlayers.map(p => p.plus_minus || 0);
  const teamAvgPlusMinus = teamPMValues.length > 0
    ? teamPMValues.reduce((a, b) => a + b, 0) / teamPMValues.length
    : 0;

  const teamScore = player.team === gameResult.home_alias ? gameResult.home_points : gameResult.away_points;
  const oppScore  = player.team === gameResult.home_alias ? gameResult.away_points : gameResult.home_points;
  const wonGame   = teamScore > oppScore;
  const isRoad    = player.team === gameResult.away_alias;

  // Opponent strength — defaults to neutral; integrate standings for precision
  const opponentStrength = 1.0;

  // Isolation carrier: 25+ pts and 3+ teammates under 10 pts
  const lowScoringTm = teamPlayers.filter(tp =>
    tp.name !== player.name && (tp.points || 0) < 10
  ).length;
  const isolationCarrier = player.points >= 25 && lowScoringTm >= 3;
  const isolationSeverity = isolationCarrier
    ? Math.min(4.0, 2.0 + (lowScoringTm - 3) * 0.5)
    : 0;

  // Bench detection — bottom half of team by minutes
  const sortedByMin = [...teamPlayers].sort((a, b) => (b.minutes || 0) - (a.minutes || 0));
  const starterCutoff = sortedByMin[4]?.minutes ?? 20;
  const isBenchPlayer = (player.minutes || 0) < starterCutoff;

  return {
    teamAvgPlusMinus,
    wonGame,
    isRoad,
    opponentStrength,
    isolationCarrier,
    isolationSeverity,
    isBenchPlayer
  };
}

// ─── PARSE SPORTRADAR BOXSCORE ────────────────────────────────────
function parseBoxScore(game, boxscore) {
  const players = [];
  if (!boxscore?.home?.players && !boxscore?.away?.players) return players;

  const processTeam = (teamData, teamAbbr, isHome) => {
    if (!teamData?.players) return;
    for (const player of teamData.players) {
      if (!player.statistics) continue;
      const s = player.statistics;
      if ((s.minutes || 0) < 5) continue;

      players.push({
        name: player.full_name,
        team: teamAbbr,
        position: player.primary_position || "G",
        minutes: s.minutes || 0,
        points: s.points || 0,
        rebounds: s.rebounds || 0,
        offensive_rebounds: s.offensive_rebounds || 0,
        defensive_rebounds: s.defensive_rebounds || 0,
        assists: s.assists || 0,
        steals: s.steals || 0,
        blocks: s.blocks || 0,
        turnovers: s.turnovers || 0,
        fouls: s.personal_fouls || 0,
        fgm: s.field_goals_made || 0,
        fga: s.field_goals_att || 0,
        fg3m: s.three_points_made || 0,
        fg3a: s.three_points_att || 0,
        ftm: s.free_throws_made || 0,
        fta: s.free_throws_att || 0,
        ft_pct: s.free_throws_att > 0
          ? (s.free_throws_made || 0) / s.free_throws_att
          : 0.75,
        plus_minus: s.pls_min || 0,
        offensive_rating: s.offensive_rating || 110,
        defensive_rating: s.defensive_rating || 110,
        second_chance_points: s.second_chance_pts || 0,
        fast_break_points: s.fast_break_pts || 0,
        points_in_paint: s.points_in_paint || 0,
        game: `${boxscore.away?.alias || "?"} @ ${boxscore.home?.alias || "?"}`,
        home_alias: boxscore.home?.alias,
        away_alias: boxscore.away?.alias,
        home_points: isHome ? game.home_points : game.away_points,
        away_points: isHome ? game.away_points : game.home_points,
        is_home: isHome
      });
    }
  };

  processTeam(boxscore.home, boxscore.home?.alias, true);
  processTeam(boxscore.away, boxscore.away?.alias, false);
  return players;
}

// ─── HTML BUILDERS ────────────────────────────────────────────────
function buildDashboardHTML(top10, games, dateLabel) {
  const rows = top10.map((p, i) => {
    const offColor = p.offImpact >= 0 ? "#22c55e" : "#ef4444";
    const defColor = p.defImpact >= 0 ? "#3b82f6" : "#ef4444";
    const rankColor = ["#ffd700","#c0c0c0","#cd7f32"][i] || "#475569";
    const qpixRDiff = p.qpixR - p.score;
    const qpixRColor = qpixRDiff >= 0 ? "#22c55e" : "#ef4444";
    const qpixRLabel = qpixRDiff >= 0 ? `+${qpixRDiff.toFixed(1)}` : qpixRDiff.toFixed(1);
    return `
      <tr onclick="toggleRow(${i})" style="cursor:pointer;border-bottom:1px solid #1e293b;"
          onmouseover="this.style.background='#0f172a'" onmouseout="this.style.background='transparent'">
        <td style="padding:14px 8px;text-align:center;color:${rankColor};font-weight:900;font-size:16px;">${i<3?["🥇","🥈","🥉"][i]:i+1}</td>
        <td style="padding:14px 8px;">
          <div style="font-weight:800;color:#f1f5f9;font-size:14px;">${p.name}</div>
          <div style="font-size:11px;color:#475569;">${p.team} · ${p.position} · ${p.game}</div>
        </td>
        <td style="padding:14px 8px;text-align:center;font-weight:900;color:#f97316;font-size:18px;">${p.points}</td>
        <td style="padding:14px 8px;text-align:center;color:#e2e8f0;">${p.rebounds}</td>
        <td style="padding:14px 8px;text-align:center;color:#e2e8f0;">${p.assists}</td>
        <td style="padding:14px 8px;text-align:center;color:#e2e8f0;">${p.steals}/${p.blocks}</td>
        <td style="padding:14px 8px;text-align:center;font-size:13px;">
          <span style="color:${offColor};font-weight:700;">O:${p.offImpact>=0?"+":""}${p.offImpact}</span><br>
          <span style="color:${defColor};font-weight:700;">D:${p.defImpact>=0?"+":""}${p.defImpact}</span>
        </td>
        <td style="padding:14px 8px;text-align:center;color:#94a3b8;">${p.ts?.toFixed(1)}%</td>
        <td style="padding:14px 8px;text-align:center;">
          <span style="background:#f97316;color:#fff;font-weight:900;padding:4px 10px;border-radius:6px;">${p.score}</span>
          <div style="font-size:10px;color:${qpixRColor};margin-top:3px;">R: ${p.qpixR} (${qpixRLabel})</div>
        </td>
      </tr>
      <tr id="detail-${i}" style="display:none;background:#0a1628;">
        <td colspan="9" style="padding:16px 20px;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
            <div>
              <div style="font-size:11px;color:#f97316;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Full Stat Line</div>
              <div style="display:flex;flex-wrap:wrap;gap:8px;">
                ${[["FG",`${p.fgm}/${p.fga}`],["3P",`${p.fg3m}/${p.fg3a}`],["FT",`${p.ftm}/${p.fta}`],
                   ["TS%",`${p.ts?.toFixed(1)}%`],["+/-",p.plus_minus>=0?`+${p.plus_minus}`:p.plus_minus],
                   ["2CH",p.second_chance_points],["FBK",p.fast_break_points],["MIN",Math.round(p.minutes)],
                   ["QPIX",p.score],["QPIX-R",p.qpixR]
                  ].map(([l,v])=>`<div style="background:#0f172a;border:1px solid #1e293b;border-radius:6px;padding:6px 12px;text-align:center;">
                    <div style="font-size:13px;font-weight:700;color:#e2e8f0;">${v}</div>
                    <div style="font-size:9px;color:#475569;">${l}</div>
                  </div>`).join("")}
              </div>
            </div>
            <div>
              <div style="font-size:11px;color:#f97316;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Why This Rank</div>
              ${p.notes.map(n=>`<div style="font-size:12px;color:#94a3b8;margin-bottom:4px;">› ${n}</div>`).join("")}
            </div>
          </div>
        </td>
      </tr>`;
  }).join("");

  const scoreboard = games.map(g => `
    <div style="background:#0f1f35;border-radius:10px;padding:12px 16px;min-width:130px;">
      <div style="font-size:10px;color:#22c55e;font-weight:700;text-transform:uppercase;margin-bottom:8px;">FINAL</div>
      <div style="font-size:14px;font-weight:800;color:${g.away_points>g.home_points?"#f97316":"#64748b"};">${g.away_alias} ${g.away_points}</div>
      <div style="font-size:14px;font-weight:800;color:${g.home_points>g.away_points?"#f97316":"#64748b"};">${g.home_alias} ${g.home_points}</div>
    </div>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>QPIX™ NBA Performance Index — ${dateLabel}</title>
<style>
  * { box-sizing:border-box; }
  body { margin:0; background:#060e1a; color:#f1f5f9; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  table { width:100%; border-collapse:collapse; }
  .container { max-width:960px; margin:0 auto; padding:24px 16px 60px; }
  .card { background:#0c1520; border:1px solid #1e293b; border-radius:12px; overflow:hidden; margin-bottom:20px; }
  .card-header { padding:16px 20px; border-bottom:1px solid #1e293b; }
  th { padding:10px 8px; font-size:10px; color:#475569; text-align:center; font-weight:700; text-transform:uppercase; letter-spacing:1px; background:#0f1f35; }
  th:nth-child(2) { text-align:left; }
  .scores { display:flex; gap:10px; overflow-x:auto; padding-bottom:4px; }
  @media(max-width:600px){ .hide-mobile { display:none; } }
</style>
</head>
<body>
<div style="background:linear-gradient(180deg,#0a1628,#060e1a);border-bottom:1px solid #0f1f35;padding:20px;position:sticky;top:0;z-index:50;">
  <div style="max-width:960px;margin:0 auto;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
    <div>
      <div style="font-size:10px;color:#f97316;font-weight:700;letter-spacing:3px;text-transform:uppercase;margin-bottom:4px;">● QPIX™ Live Dashboard</div>
      <h1 style="margin:0;font-size:20px;font-weight:900;letter-spacing:-0.5px;">QCore Labs · NBA Performance Index</h1>
      <div style="font-size:12px;color:#475569;margin-top:2px;">${dateLabel} · 13-Category Engine · QCoreLabs.com</div>
    </div>
    <div style="background:#0f1f35;border-radius:8px;padding:8px 16px;text-align:center;">
      <div style="font-size:10px;color:#475569;">Games</div>
      <div style="font-size:22px;font-weight:900;color:#f97316;">${games.length}</div>
    </div>
  </div>
</div>
<div class="container">
  <div class="card">
    <div class="card-header"><div style="font-size:12px;font-weight:700;color:#f97316;text-transform:uppercase;letter-spacing:1px;">Last Night's Results</div></div>
    <div style="padding:16px;"><div class="scores">${scoreboard}</div></div>
  </div>
  <div class="card">
    <div class="card-header">
      <div style="font-size:13px;font-weight:800;color:#f97316;text-transform:uppercase;letter-spacing:1px;">QPIX™ Top 10</div>
      <div style="font-size:11px;color:#475569;margin-top:3px;">Click any row to expand · QPIX = raw · QPIX-R = referee-adjusted</div>
    </div>
    <table>
      <thead><tr>
        <th style="width:44px;"></th>
        <th style="text-align:left;">Player</th>
        <th>PTS</th>
        <th class="hide-mobile">REB</th>
        <th class="hide-mobile">AST</th>
        <th class="hide-mobile">STL/BLK</th>
        <th>O/D ±</th>
        <th class="hide-mobile">TS%</th>
        <th>QPIX</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <div style="text-align:center;font-size:11px;color:#1e3a5f;line-height:1.8;">
    QPIX™ 13 Categories: Base Production · Shooting Efficiency · Proprietary Off/Def ± Split · Defensive Activity · Playmaking Quality · Offensive Context · Gravity Score · Context-Weighted +/− · Multi-Category Bonuses · Fatigue Curve · Momentum Swing · Second Unit Anchor · QPIX-R Referee Layer<br>
    Auto-generated via GitHub Actions · Sportradar API · QCore Labs © 2026 · QCoreLabs.com
  </div>
</div>
<script>
function toggleRow(i) {
  const r = document.getElementById('detail-' + i);
  r.style.display = r.style.display === 'none' ? 'table-row' : 'none';
}
</script>
</body>
</html>`;
}

// ─── MOCK DATA ─────────────────────────────────────────────────────
function getMockData() {
  return {
    games: [
      { id: "mock-1", home: { alias: "NYK" }, away: { alias: "BOS" }, home_points: 112, away_points: 108 },
      { id: "mock-2", home: { alias: "LAL" }, away: { alias: "GSW" }, home_points: 121, away_points: 119 },
    ]
  };
}

function getMockPlayers() {
  return [
    { name: "Jalen Brunson", team: "NYK", position: "G", minutes: 36, points: 34, rebounds: 4, assists: 9, steals: 2, blocks: 0, turnovers: 2, fgm: 12, fga: 22, fg3m: 3, fg3a: 8, ftm: 7, fta: 8, ft_pct: 0.875, offensive_rebounds: 0, defensive_rebounds: 4, plus_minus: 11, offensive_rating: 124, defensive_rating: 106, second_chance_points: 2, fast_break_points: 4, points_in_paint: 10, game: "BOS @ NYK", home_alias: "NYK", away_alias: "BOS", home_points: 112, away_points: 108, is_home: true },
    { name: "Luka Doncic", team: "LAL", position: "G", minutes: 38, points: 38, rebounds: 9, assists: 12, steals: 1, blocks: 1, turnovers: 4, fgm: 13, fga: 25, fg3m: 4, fg3a: 10, ftm: 8, fta: 10, ft_pct: 0.80, offensive_rebounds: 1, defensive_rebounds: 8, plus_minus: 6, offensive_rating: 128, defensive_rating: 110, second_chance_points: 2, fast_break_points: 6, points_in_paint: 12, game: "GSW @ LAL", home_alias: "LAL", away_alias: "GSW", home_points: 121, away_points: 119, is_home: true },
  ];
}

// ─── MAIN ──────────────────────────────────────────────────────────
async function main() {
  const date = getYesterdayET();
  console.log(`\n📊 QPIX™ Daily Report — ${date.label}`);
  console.log(`Mode: ${isDryRun ? "DRY RUN" : "LIVE"}\n`);

  if (process.env.GITHUB_ENV) {
    writeFileSync(process.env.GITHUB_ENV, `REPORT_DATE=${date.month}/${date.day}/${date.year}\n`, { flag: "a" });
  }

  console.log("1. Fetching last night's scores...");
  const scoresData = await fetchNBAScores(date);
  const games = scoresData?.games || [];
  console.log(`   Found ${games.length} games`);

  if (games.length === 0) {
    console.log("   No games last night. Exiting.");
    process.exit(0);
  }

  console.log("2. Fetching box scores...");
  let allPlayers = [];

  if (isDryRun) {
    allPlayers = getMockPlayers();
  } else {
    for (const game of games) {
      const homeTeam = game.home?.alias || game.home;
      const awayTeam = game.away?.alias || game.away;
      console.log(`   Fetching: ${awayTeam} @ ${homeTeam}`);
      await new Promise(r => setTimeout(r, 1200)); // 1.2s between requests
      const boxscore = await fetchGameBoxScore(game.id);
      if (boxscore) {
        const gameSimple = {
          home_points: game.home_points || 0,
          away_points: game.away_points || 0
        };
        const players = parseBoxScore(gameSimple, boxscore);
        allPlayers.push(...players);
      }
    }
  }
  console.log(`   ${allPlayers.length} players parsed`);

  // Build game results for context
  const gameResults = games.map(g => ({
    home_alias: g.home?.alias || g.home,
    away_alias: g.away?.alias || g.away,
    home_points: g.home_points || 0,
    away_points: g.away_points || 0,
  }));

  console.log("3. Computing QPIX™ scores (13 categories)...");

  // Group players by game for context
  const playersByGame = {};
  for (const p of allPlayers) {
    if (!playersByGame[p.game]) playersByGame[p.game] = [];
    playersByGame[p.game].push(p);
  }

  const scoredPlayers = allPlayers.map(p => {
    const gamePlayers = playersByGame[p.game] || [];
    const gameResult = gameResults.find(g =>
      g.home_alias === p.home_alias && g.away_alias === p.away_alias
    ) || {};
    const gameContext = buildGameContext(p, gamePlayers, gameResult);
    const result = computeQPIX(p, gameContext);
    return { ...p, ...result };
  }).sort((a, b) => b.score - a.score);

  const top10 = scoredPlayers.slice(0, 10);
  console.log(`   Top: ${top10[0]?.name} | QPIX: ${top10[0]?.score} | QPIX-R: ${top10[0]?.qpixR}`);

  console.log("4. Building dashboard...");
  const dashboardHTML = buildDashboardHTML(top10, gameResults, date.label);
  mkdirSync(join(__dirname, "../dashboard"), { recursive: true });
  writeFileSync(join(__dirname, "../dashboard/index.html"), dashboardHTML);
  console.log("   dashboard/index.html written");

  console.log("\n✅ QPIX™ Report complete!\n");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
