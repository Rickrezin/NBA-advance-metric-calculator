"""
Fetch yesterday's NBA box scores from the NBA CDN and write to data/nba_data.json.

Uses https://cdn.nba.com/static/json/staticData/EliasGameStats/00/all_players_day.txt
No external dependencies — stdlib only (urllib.request, json, os, datetime, zoneinfo).

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

def parse_minutes(min_str):
    """Parse 'MM:SS' string to float minutes."""
    try:
        m, s = str(min_str or "0:00").split(":")
        return float(m) + float(s) / 60
    except (ValueError, AttributeError):
        return 0.0

def safe_int(val, default=0):
    try:
        return int(val or default)
    except (ValueError, TypeError):
        return default

def safe_float(val, default=0.0):
    try:
        return float(val or default)
    except (ValueError, TypeError):
        return default

def fetch_cdn_data():
    """Fetch the CDN JSON file and return parsed dict."""
    req = urllib.request.Request(
        CDN_URL,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/123.0.0.0 Safari/537.36"
            ),
            "Accept": "application/json, text/plain, */*",
            "Referer": "https://www.nba.com/",
            "Origin": "https://www.nba.com",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8")
    return json.loads(raw)

def parse_games_and_players(data):
    """Parse CDN gsc array into games and players lists."""
    gsc = data.get("gsc", [])
    games = []
    all_players = []

    for game_entry in gsc:
        gid = str(game_entry.get("gid", ""))
        hls = game_entry.get("hls", {})
        vls = game_entry.get("vls", {})

        home_alias = hls.get("ta", "?")
        away_alias = vls.get("ta", "?")
        home_points = safe_int(hls.get("s", 0))
        away_points = safe_int(vls.get("s", 0))

        games.append({
            "game_id": gid,
            "home_alias": home_alias,
            "away_alias": away_alias,
            "home_points": home_points,
            "away_points": away_points,
        })

        game_label = f"{away_alias} @ {home_alias}"

        for p in game_entry.get("pl", []):
            # Skip players who didn't play
            if p.get("status", "") != "A":
                continue

            minutes = parse_minutes(p.get("min", "0:00"))
            if minutes < 5:
                continue

            team_abbr = p.get("ta", "")
            is_home = team_abbr == home_alias

            fta = safe_int(p.get("fta", 0))
            ftm = safe_int(p.get("ftm", 0))
            # ftp is 0-100 scale (e.g. "80.0"), convert to 0-1
            ftp_raw = safe_float(p.get("ftp", None))
            if ftp_raw is not None and ftp_raw > 1:
                ft_pct = ftp_raw / 100.0
            elif fta > 0:
                ft_pct = ftm / fta
            else:
                ft_pct = 0.75

            # plus_minus may be "+14", "-5", or "0"
            pm_str = str(p.get("pm", "0") or "0").replace("+", "")
            plus_minus = safe_int(pm_str)

            name = f"{p.get('fn', '')} {p.get('ln', '')}".strip()

            all_players.append({
                "name": name,
                "team": team_abbr,
                "position": p.get("pos", "G") or "G",
                "minutes": round(minutes, 2),
                "points": safe_int(p.get("pts", 0)),
                "rebounds": safe_int(p.get("reb", 0)),
                "offensive_rebounds": safe_int(p.get("oreb", 0)),
                "defensive_rebounds": safe_int(p.get("dreb", 0)),
                "assists": safe_int(p.get("ast", 0)),
                "steals": safe_int(p.get("stl", 0)),
                "blocks": safe_int(p.get("blk", 0)),
                "turnovers": safe_int(p.get("to", 0)),
                "fgm": safe_int(p.get("fgm", 0)),
                "fga": safe_int(p.get("fga", 0)),
                "fg3m": safe_int(p.get("tpm", 0)),   # CDN uses tpm, not fg3m
                "fg3a": safe_int(p.get("tpa", 0)),   # CDN uses tpa, not fg3a
                "ftm": ftm,
                "fta": fta,
                "ft_pct": round(ft_pct, 4),
                "plus_minus": plus_minus,
                "offensive_rating": 110.0,
                "defensive_rating": 110.0,
                "second_chance_points": 0,
                "fast_break_points": 0,
                "points_in_paint": 0,
                "game": game_label,
                "home_alias": home_alias,
                "away_alias": away_alias,
                "home_points": home_points,
                "away_points": away_points,
                "is_home": is_home,
            })

    return games, all_players

def main():
    et = ZoneInfo("America/New_York")
    yesterday = datetime.now(et) - timedelta(days=1)
    date_label = yesterday.strftime("%m/%d/%Y")
    print(f"Fetching NBA data for {date_label}")

    try:
        data = fetch_cdn_data()
    except Exception as e:
        print(f"Error fetching CDN data: {e}")
        os.makedirs("data", exist_ok=True)
        with open("data/nba_data.json", "w") as f:
            json.dump({"games": [], "players": []}, f)
        return

    games, all_players = parse_games_and_players(data)

    print(f"Found {len(games)} games, {len(all_players)} players")

    if len(games) == 0:
        print("No games found in CDN data. Writing empty output.")

    os.makedirs("data", exist_ok=True)
    with open("data/nba_data.json", "w") as f:
        json.dump({"games": games, "players": all_players}, f, indent=2)

    print("Written to data/nba_data.json")

if __name__ == "__main__":
    main()