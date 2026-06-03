"""ONE-TIME season backfill of player_game_logs (calibration Stage 1).

Pulls each projected player's FULL-season per-game actuals from the MLB Stats API
and INSERTS them into player_game_logs flagged backfilled=true, so the hit-rate
trends + confidence scores reflect the whole season instead of only the games the
engine has graded since it started (~May 30).

FOUNDATION SAFETY (the whole point):
  * Rows are flagged backfilled=true and INSERT-ONLY (ON CONFLICT DO NOTHING on
    the (player_id, game_id) PK), so a genuinely-graded row — which carries the
    full context features — is NEVER overwritten by a feature-less backfill row.
  * model.train() EXCLUDES backfilled rows -> the XGBoost model trains on exactly
    the same graded rows as before (byte-identical; verify with the row count).
  * Edges / CLV / the calibration scorecard read the `edges` table, which a
    backfill has none of -> the probability/edge calibration is untouched.
  * Only trends + confidence (which read every row) gain the season.
  * The flag is what lets this data be fed INTO training later — deliberately,
    once a measured Stage-2 pass shows it improves prediction — never silently.

Idempotent: re-running inserts only games not already present. The daily grader
keeps things current going forward; this just fills the pre-engine history.

Run AFTER applying db/migrations/add_backfilled_flag.sql (the insert refuses to
run without the flag column, to avoid inserting un-flagged rows):
    python engine/backfill_logs.py
"""
from __future__ import annotations

from dotenv import load_dotenv

load_dotenv()

import db
import fantasy_score
import stats
from constants import et_today

LOOKBACK_DAYS = 240   # whole season + margin (opening day ~late March)
BATCH = 500


def _distinct_player_ids(prop_type: str) -> list[int]:
    """Distinct player_ids we project for `prop_type` (the board players)."""
    c = db._client()
    ids: set[int] = set()
    frm = 0
    while True:
        batch = (
            c.table("projections")
            .select("player_id")
            .eq("prop_type", prop_type)
            .range(frm, frm + 999)
            .execute()
            .data
            or []
        )
        for r in batch:
            if r.get("player_id") is not None:
                ids.add(int(r["player_id"]))
        if len(batch) < 1000:
            break
        frm += 1000
    return sorted(ids)


def _pitcher_rows(pid: int, ref) -> list[dict]:
    rows: list[dict] = []
    for g in stats.get_pitcher_starts(pid, LOOKBACK_DAYS, ref):
        gid = g.get("game_id")
        if gid is None:
            continue
        outs = int(g.get("outs_recorded") or 0)
        k = int(g.get("strikeouts") or 0)
        er = int(g.get("earned_runs") or 0)
        rows.append(
            {
                "player_id": pid,
                "game_id": int(gid),
                "game_date": g["game_date"],
                "player_type": "pitcher",
                "backfilled": True,
                "actual_strikeouts": k,
                "actual_hits_allowed": g.get("hits_allowed"),
                "actual_walks": g.get("walks"),
                "actual_earned_runs": er,
                "actual_outs_recorded": outs,
                # win unknown historically -> False, same ~6-FP-low bias the
                # pitcher fantasy baseline already documents.
                "actual_pitcher_fantasy_score": fantasy_score.pitcher_fantasy_score(
                    outs, k, er, False
                ),
            }
        )
    return rows


def _hitter_rows(pid: int, ref) -> list[dict]:
    rows: list[dict] = []
    for g in stats.get_hitter_games(pid, LOOKBACK_DAYS, ref):
        gid = g.get("game_id")
        if gid is None:
            continue
        hits = int(g.get("hits") or 0)
        doubles = int(g.get("doubles") or 0)
        triples = int(g.get("triples") or 0)
        hr = int(g.get("home_runs") or 0)
        runs = int(g.get("runs") or 0)
        rbis = int(g.get("rbis") or 0)
        bb = int(g.get("walks") or 0)
        hbp = int(g.get("hit_by_pitch") or 0)
        sb = int(g.get("stolen_bases") or 0)
        rows.append(
            {
                "player_id": pid,
                "game_id": int(gid),
                "game_date": g["game_date"],
                "player_type": "hitter",
                "backfilled": True,
                "actual_hits": hits,
                "actual_total_bases": g.get("total_bases"),
                "actual_hits_runs_rbis": g.get("hits_runs_rbis"),
                "actual_rbis": rbis,
                "actual_runs": runs,
                "actual_home_runs": hr,
                "doubles": doubles,
                "triples": triples,
                "hit_by_pitch": hbp,
                "stolen_bases": sb,
                "actual_hitter_fantasy_score": fantasy_score.hitter_fantasy_score(
                    hits, doubles, triples, hr, runs, rbis, bb, hbp, sb
                ),
            }
        )
    return rows


def build_rows(dry_run_player: int | None = None) -> list[dict]:
    """Build all backfill rows (no DB writes). With dry_run_player set, builds
    only that one player's rows — used to eyeball the shape before inserting."""
    ref = et_today()
    if dry_run_player is not None:
        return _pitcher_rows(dry_run_player, ref) + _hitter_rows(dry_run_player, ref)
    rows: list[dict] = []
    for pid in _distinct_player_ids("strikeouts"):
        rows += _pitcher_rows(pid, ref)
    for pid in _distinct_player_ids("hitter_hits"):
        rows += _hitter_rows(pid, ref)
    return rows


def main() -> None:
    ref = et_today()
    pitchers = _distinct_player_ids("strikeouts")
    hitters = _distinct_player_ids("hitter_hits")
    print(
        f"season backfill: {len(pitchers)} pitchers + {len(hitters)} hitters "
        f"(lookback {LOOKBACK_DAYS}d, ref {ref})"
    )

    buf: list[dict] = []
    submitted = 0

    def flush() -> None:
        nonlocal buf, submitted
        if buf:
            submitted += db.insert_backfill_game_logs(buf)
            buf = []

    for i, pid in enumerate(pitchers, 1):
        buf += _pitcher_rows(pid, ref)
        if len(buf) >= BATCH:
            flush()
        if i % 25 == 0:
            print(f"  pitchers {i}/{len(pitchers)} ...")
    for i, pid in enumerate(hitters, 1):
        buf += _hitter_rows(pid, ref)
        if len(buf) >= BATCH:
            flush()
        if i % 25 == 0:
            print(f"  hitters {i}/{len(hitters)} ...")
    flush()
    print(
        f"Done. submitted {submitted} backfill rows "
        f"(already-present games are skipped by ON CONFLICT DO NOTHING)."
    )


if __name__ == "__main__":
    main()
