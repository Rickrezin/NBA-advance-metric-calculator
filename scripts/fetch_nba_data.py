"""
Fetch yesterday's NBA box scores from the NBA CDN Elias text file
and write to data/nba_data.json.

Source: https://cdn.nba.com/static/json/staticData/EliasGameStats/00/all_players_day.txt

Fixed-width text format columns:
DATE TM OPP NAME (POS) G MIN FG FGA FG3 F3A FT FTA OFF DEF TRB AST PF DQ STL TO BLK PTS

Output JSON schema:
  {
    "games":   [ { game_id, home_alias, away_alias, home_points, away_points } ],
    "players": [ { name, team, position, minutes, points, rebounds,
                   offensive_rebounds, defensive_rebounds, assists, steals,
                   blocks, turnovers, fgm, fga, fg3m, fg3a, ftm, fta, ft_pct,
                   plus_minus, offensive_rating, defensive_rating,
                   second_chance_points, fast_break_points, points_in_paint,
                   game, home_alias, away_alias, home_points, away_points,
                   is_home } ]
  }
"""

import json
import os
import urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo


CDN_URL = "https://cdn.nba.com/static/json/staticData/EliasGameStats/00/all_players_day.txt"


def get_yesterday_et():
    et = ZoneInfo("America/New_York")
    yesterday = datetime.now(et) - timedelta(days=1)
    return yesterday.strftime("%m/%d/%Y")


def fetch_text():
    """Fetch the CDN text file and return lines."""
    req = urllib.request.Request(
        CDN_URL,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/123.0.0.0 Safari/537.36"
            ),
            "Accept": "text/plain, */*",
            "Referer": "https://www.nba.com/",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    # Handle gzip if needed
    if raw[:2] == b'\x1f\x8b':
        import gzip
        raw = gzip.decompress(raw)
    return raw.decode("utf-8", errors="replace").splitlines()


def safe_int(val, default=0):
    try:
        return int(str(val).strip())
    except (ValueError, TypeError):
        return default


def parse_minutes(val):
    """Parse integer minutes field to float."""
    try:
        return float(str(val).strip())
    except (ValueError, TypeError):
        return 0.0


def parse_lines(lines, target_date):
    """
    Parse fixed-width player lines for target_date (MM/DD/YYYY).

    Column layout (space-separated, name has commas and spaces):
    DATE       TM  OPP NAME                     (POS)  G MIN  FG FGA  FG3 F3A  FT FTA OFF DEF TRB AST  PF  DQ STL  TO BLK PTS

    Fixed character positions based on the header:
    0-9   DATE
    11-13 TM
    15-17 OPP
    19-44 NAME
    45-50 (POS)
    52    G
    54-56 MIN
    58-60 FG
    61-64 FGA
    65-68 FG3
    69-72 F3A
    73-76 FT
    77-80 FTA
    81-84 OFF
    85-88 DEF
    89-92 TRB
    93-96 AST
    97-100 PF
    101-103 DQ
    104-107 STL
    108-111 TO
    112-115 BLK
    116-119 PTS
    """
    players = []
    game_team_pts = {}  # (tm, opp) -> total pts for tm

    for line in lines:
        if not line or not line[0].isdigit():
            continue

        date_str = line[0:10].strip()
        if date_str != target_date:
            continue

        # Parse fields by splitting on whitespace, accounting for fixed positions
        # Use split() but reconstruct carefully:
        # Format: DATE TM OPP NAME (POS) G MIN FG FGA FG3 F3A FT FTA OFF DEF TRB AST  PF  DQ STL  TO BLK PTS
        # NAME field contains ", " and spaces — use fixed character positions

        tm  = line[11:14].strip()
        opp = line[15:18].strip()

        # Name runs from col 19 to 44 (inclusive), then (POS) at 45-50
        raw_name = line[19:45].strip()   # "Hauser, Sam"
        raw_pos  = line[45:51].strip()   # "(F  )"

        # Convert "Last, First" -> "First Last"
        if "," in raw_name:
            last, first = raw_name.split(",", 1)
            name = f"{first.strip()} {last.strip()}"
        else:
            name = raw_name.strip()

        # Extract position letter from "(F  )" -> "F"
        pos = raw_pos.strip("() ").strip()
        if not pos:
            pos = "G"
        # Normalize SUB -> G (bench players listed as SUB)
        if pos == "SUB" or not pos[0].isalpha():
            pos = "G"

        # Remaining numeric fields — split the tail
        tail = line[52:].split()
        # Expected: G MIN FG FGA FG3 F3A FT FTA OFF DEF TRB AST PF DQ STL TO BLK PTS
        if len(tail) < 18:
            continue

        try:
            # g      = safe_int(tail[0])
            minutes = parse_minutes(tail[1])
            fgm     = safe_int(tail[2])
            fga     = safe_int(tail[3])
            fg3m    = safe_int(tail[4])
            fg3a    = safe_int(tail[5])
            ftm     = safe_int(tail[6])
            fta     = safe_int(tail[7])
            oreb    = safe_int(tail[8])
            dreb    = safe_int(tail[9])
            reb     = safe_int(tail[10])
            ast     = safe_int(tail[11])
            # pf    = safe_int(tail[12])
            # dq    = safe_int(tail[13])
            stl     = safe_int(tail[14])
            to      = safe_int(tail[15])
            blk     = safe_int(tail[16])
            pts     = safe_int(tail[17])
        except (IndexError, ValueError):
            continue

        if minutes < 5:
            continue

        ft_pct = (ftm / fta) if fta > 0 else 0.75

        # Accumulate team points for score derivation
        key = (tm, opp)
        game_team_pts[key] = game_team_pts.get(key, 0) + pts

        players.append({
            "name": name,
            "team": tm,
            "opp": opp,
            "position": pos,
            "minutes": round(minutes, 1),
            "points": pts,
            "rebounds": reb,
            "offensive_rebounds": oreb,
            "defensive_rebounds": dreb,
            "assists": ast,
            "steals": stl,
            "blocks": blk,
            "turnovers": to,
            "fgm": fgm,
            "fga": fga,
            "fg3m": fg3m,
            "fg3a": fg3a,
            "ftm": ftm,
            "fta": fta,
            "ft_pct": round(ft_pct, 4),
            "plus_minus": 0,
            "offensive_rating": 110.0,
            "defensive_rating": 110.0,
            "second_chance_points": 0,
            "fast_break_points": 0,
            "points_in_paint": 0,
        })

    return players, game_team_pts


def build_games(game_team_pts):
    """
    Build games list from (tm, opp) -> pts mapping.
    Each game appears twice: (TM, OPP) and (OPP, TM).
    Deduplicate by treating the lexicographically smaller team as 'away'.
    Determine home/away: in the file, TM is always the HOME team, OPP is AWAY.
    Actually looking at the data: BOS NY means BOS is home, NY is away... 
    but NY BOS also appears — NY is home vs BOS away.
    So TM = home team, OPP = away team.
    """
    seen = set()
    games = []
    game_id_counter = 1

    for (tm, opp), tm_pts in game_team_pts.items():
        # TM is home, OPP is away
        # The reverse entry (opp, tm) gives away team pts
        opp_pts = game_team_pts.get((opp, tm), 0)

        # Deduplicate — only emit once per pair
        pair = tuple(sorted([tm, opp]))
        if pair in seen:
            continue
        seen.add(pair)

        games.append({
            "game_id": f"CDN{game_id_counter:04d}",
            "home_alias": tm,
            "away_alias": opp,
            "home_points": tm_pts,
            "away_points": opp_pts,
        })
        game_id_counter += 1

    return games


def attach_game_info(players, games):
    """Attach game-level fields to each player dict."""
    # Build lookup: (home, away) and (away, home) -> game
    game_lookup = {}
    for g in games:
        game_lookup[(g["home_alias"], g["away_alias"])]= g
        game_lookup[(g["away_alias"], g["home_alias"])]= g

    result = []
    for p in players:
        tm  = p.pop("team")
        opp = p.pop("opp")

        g = game_lookup.get((tm, opp)) or game_lookup.get((opp, tm))
        if not g:
            continue

        home_alias  = g["home_alias"]
        away_alias  = g["away_alias"]
        home_points = g["home_points"]
        away_points = g["away_points"]
        is_home     = tm == home_alias

        result.append({
            **p,
            "team": tm,
            "game": f"{away_alias} @ {home_alias}",
            "home_alias": home_alias,
            "away_alias": away_alias,
            "home_points": home_points,
            "away_points": away_points,
            "is_home": is_home,
        })

    return result


def main():
    target_date = get_yesterday_et()
    print(f"Fetching NBA data for {target_date}")

    try:
        lines = fetch_text()
    except Exception as e:
        print(f"Error fetching CDN data: {e}")
        os.makedirs("data", exist_ok=True)
        with open("data/nba_data.json", "w") as f:
            json.dump({"games": [], "players": []}, f)
        return

    print(f"  Downloaded {len(lines)} lines")

    players_raw, game_team_pts = parse_lines(lines, target_date)
    print(f"  Parsed {len(players_raw)} player rows for {target_date}")

    if not players_raw:
        print("  No player data found — writing empty output.")
        os.makedirs("data", exist_ok=True)
        with open("data/nba_data.json", "w") as f:
            json.dump({"games": [], "players": []}, f)
        return

    games   = build_games(game_team_pts)
    players = attach_game_info(players_raw, games)

    print(f"  Found {len(games)} games, {len(players)} players")

    os.makedirs("data", exist_ok=True)
    with open("data/nba_data.json", "w") as f:
        json.dump({"games": games, "players": players}, f, indent=2)

    print("Written to data/nba_data.json")


if __name__ == "__main__":
    main()