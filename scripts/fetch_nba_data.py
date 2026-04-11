"""
Fetch yesterday's NBA box scores using nba_api and write to data/nba_data.json.

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
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import requests.exceptions

from nba_api.stats.endpoints import (
    scoreboardv2,
    boxscoretraditionalv2,
    boxscoreadvancedv2,
)

_API_TIMEOUT = 60
_MAX_RETRIES = 3
_RETRY_BACKOFF = 5  # seconds; doubles on each retry
_RETRYABLE = (
    requests.exceptions.Timeout,
    requests.exceptions.ConnectionError,
    requests.exceptions.ChunkedEncodingError,
)


def _retry(fn, *args, **kwargs):
    """Call fn(*args, **kwargs), retrying on network errors up to _MAX_RETRIES times."""
    delay = _RETRY_BACKOFF
    for attempt in range(1, _MAX_RETRIES + 1):
        try:
            return fn(*args, **kwargs)
        except _RETRYABLE as exc:
            if attempt == _MAX_RETRIES:
                raise
            print(f"  Attempt {attempt} failed ({exc}). Retrying in {delay}s…")
            time.sleep(delay)
            delay *= 2


def get_yesterday_et():
    """Return yesterday's date in ET as MM/DD/YYYY (format expected by NBA stats API)."""
    et = ZoneInfo("America/New_York")
    yesterday = datetime.now(et) - timedelta(days=1)
    return yesterday.strftime("%m/%d/%Y")


def fetch_scoreboard(date_str):
    """Return (games, team_info) from ScoreboardV2 for the given date."""
    board = _retry(scoreboardv2.ScoreboardV2, game_date=date_str, timeout=_API_TIMEOUT)

    game_header = board.game_header.get_dict()
    line_score = board.line_score.get_dict()

    gh_idx = {h: i for i, h in enumerate(game_header["headers"])}
    ls_idx = {h: i for i, h in enumerate(line_score["headers"])}

    # Build team lookup: (game_id, team_id) -> {abbr, pts}
    team_info = {}
    for row in line_score["data"]:
        game_id = str(row[ls_idx["GAME_ID"]])
        team_id = row[ls_idx["TEAM_ID"]]
        team_info[(game_id, team_id)] = {
            "abbr": row[ls_idx["TEAM_ABBREVIATION"]],
            "pts": row[ls_idx["PTS"]] or 0,
        }

    games = []
    for row in game_header["data"]:
        game_id = str(row[gh_idx["GAME_ID"]])
        home_id = row[gh_idx["HOME_TEAM_ID"]]
        away_id = row[gh_idx["VISITOR_TEAM_ID"]]

        home = team_info.get((game_id, home_id), {"abbr": "?", "pts": 0})
        away = team_info.get((game_id, away_id), {"abbr": "?", "pts": 0})

        games.append(
            {
                "game_id": game_id,
                "home_alias": home["abbr"],
                "away_alias": away["abbr"],
                "home_points": home["pts"],
                "away_points": away["pts"],
            }
        )

    return games


def fetch_players_for_game(game):
    """Fetch and parse player rows for one game. Returns list of player dicts."""
    game_id = game["game_id"]

    trad = _retry(boxscoretraditionalv2.BoxScoreTraditionalV2, game_id=game_id, timeout=_API_TIMEOUT)
    time.sleep(0.6)
    adv = _retry(boxscoreadvancedv2.BoxScoreAdvancedV2, game_id=game_id, timeout=_API_TIMEOUT)

    trad_dict = trad.player_stats.get_dict()
    adv_dict = adv.player_stats.get_dict()

    t_idx = {h: i for i, h in enumerate(trad_dict["headers"])}
    a_idx = {h: i for i, h in enumerate(adv_dict["headers"])}

    # Build advanced lookup: player_id -> row
    adv_map = {row[a_idx["PLAYER_ID"]]: row for row in adv_dict["data"]}

    players = []
    for row in trad_dict["data"]:
        # Parse "MM:SS" minutes string
        min_str = str(row[t_idx["MIN"]] or "0:00")
        try:
            m, s = min_str.split(":")
            minutes = float(m) + float(s) / 60
        except (ValueError, AttributeError):
            minutes = 0.0

        if minutes < 5:
            continue

        player_id = row[t_idx["PLAYER_ID"]]
        team_abbr = row[t_idx["TEAM_ABBREVIATION"]]
        is_home = team_abbr == game["home_alias"]

        fta = row[t_idx["FTA"]] or 0
        ftm = row[t_idx["FTM"]] or 0
        ft_pct = row[t_idx["FT_PCT"]]
        if ft_pct is None:
            ft_pct = (ftm / fta) if fta > 0 else 0.75

        off_rtg, def_rtg = 110.0, 110.0
        if player_id in adv_map:
            arow = adv_map[player_id]
            off_rtg = arow[a_idx["OFF_RATING"]] or 110.0
            def_rtg = arow[a_idx["DEF_RATING"]] or 110.0

        position = row[t_idx["START_POSITION"]] or "G"

        players.append(
            {
                "name": row[t_idx["PLAYER_NAME"]],
                "team": team_abbr,
                "position": position,
                "minutes": minutes,
                "points": row[t_idx["PTS"]] or 0,
                "rebounds": row[t_idx["REB"]] or 0,
                "offensive_rebounds": row[t_idx["OREB"]] or 0,
                "defensive_rebounds": row[t_idx["DREB"]] or 0,
                "assists": row[t_idx["AST"]] or 0,
                "steals": row[t_idx["STL"]] or 0,
                "blocks": row[t_idx["BLK"]] or 0,
                "turnovers": row[t_idx["TO"]] or 0,
                "fgm": row[t_idx["FGM"]] or 0,
                "fga": row[t_idx["FGA"]] or 0,
                "fg3m": row[t_idx["FG3M"]] or 0,
                "fg3a": row[t_idx["FG3A"]] or 0,
                "ftm": ftm,
                "fta": fta,
                "ft_pct": ft_pct,
                "plus_minus": row[t_idx["PLUS_MINUS"]] or 0,
                "offensive_rating": off_rtg,
                "defensive_rating": def_rtg,
                "second_chance_points": 0,
                "fast_break_points": 0,
                "points_in_paint": 0,
                "game": f"{game['away_alias']} @ {game['home_alias']}",
                "home_alias": game["home_alias"],
                "away_alias": game["away_alias"],
                "home_points": game["home_points"],
                "away_points": game["away_points"],
                "is_home": is_home,
            }
        )

    return players


def main():
    date_str = get_yesterday_et()
    print(f"Fetching NBA data for {date_str}")

    # Fetch scoreboard
    try:
        games = fetch_scoreboard(date_str)
    except Exception as e:
        print(f"Error fetching scoreboard: {e}")
        os.makedirs("data", exist_ok=True)
        with open("data/nba_data.json", "w") as f:
            json.dump({"games": [], "players": []}, f)
        return

    print(f"Found {len(games)} games")

    # Fetch player stats for each game
    all_players = []
    for game in games:
        print(f"  {game['away_alias']} @ {game['home_alias']} ({game['game_id']})")
        time.sleep(1)
        try:
            players = fetch_players_for_game(game)
            all_players.extend(players)
        except Exception as e:
            print(f"  Error fetching boxscore for {game['game_id']}: {e}")
            continue

    print(f"Total players: {len(all_players)}")

    os.makedirs("data", exist_ok=True)
    with open("data/nba_data.json", "w") as f:
        json.dump({"games": games, "players": all_players}, f, indent=2)

    print("Written to data/nba_data.json")


if __name__ == "__main__":
    main()
