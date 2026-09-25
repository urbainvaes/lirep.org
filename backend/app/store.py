import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .config import DEFAULT_EXPLORER_SOURCE

DB_PATH = Path(__file__).resolve().parent.parent / "lirep.db"

DEFAULT_EXPLORER_SETTINGS: dict[str, Any] = {
    "enabled": True,
    "source": DEFAULT_EXPLORER_SOURCE,
    "database": "lichess",
    "minRating": None,
    "speeds": ["blitz", "rapid", "classical"],
}
DEFAULT_SIDE = "white"

# A position's real-world move frequencies shift slowly, so a day-old cached
# Opening Explorer response is still practically accurate — and it's shared
# across every study and user, keyed by provider and query (fen + database +
# ratings + speeds), not tied to any one study.
EXPLORER_CACHE_TTL_SECONDS = 24 * 60 * 60

# How long a resolved "my current rating" bucket is trusted before
# re-checking Lichess. Persisted (not in-memory) specifically so a backend
# restart can't silently erase a still-fresh resolution and force a live
# account call it didn't actually need — see explorer-cache.md.
RATING_CACHE_TTL_SECONDS = 60 * 60

# A real evaluation never changes for a fixed position, so a hit is trusted
# forever (no TTL check at all). A miss ("no cloud eval for this position
# yet") is retried after this long, in case Lichess has since analyzed it.
CLOUD_EVAL_MISS_TTL_SECONDS = 24 * 60 * 60


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _tree_from_moves(moves: list[str]) -> dict[str, Any]:
    """Converts a flat SAN list (the old, pre-tree schema) into a linear tree."""
    nodes: dict[int, dict[str, Any]] = {0: {"id": 0, "san": None, "parentId": None, "children": []}}
    parent_id = 0
    next_id = 1
    for san in moves:
        nodes[next_id] = {"id": next_id, "san": san, "parentId": parent_id, "children": []}
        nodes[parent_id]["children"].append(next_id)
        parent_id = next_id
        next_id += 1
    return {"nodes": nodes, "rootId": 0, "nextId": next_id}


def init_db() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS studies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner TEXT NOT NULL,
                name TEXT NOT NULL,
                tree TEXT NOT NULL,
                explorer_settings TEXT NOT NULL DEFAULT '{}',
                side TEXT NOT NULL DEFAULT 'white',
                stats TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(studies)")}
        if "moves" in columns:
            if "tree" not in columns:
                conn.execute("ALTER TABLE studies ADD COLUMN tree TEXT")
                for row in conn.execute("SELECT id, moves FROM studies"):
                    tree = _tree_from_moves(json.loads(row["moves"]))
                    conn.execute("UPDATE studies SET tree = ? WHERE id = ?", (json.dumps(tree), row["id"]))
            conn.execute("ALTER TABLE studies DROP COLUMN moves")
            columns.discard("moves")

        if "explorer_settings" not in columns:
            conn.execute("ALTER TABLE studies ADD COLUMN explorer_settings TEXT")
            conn.execute(
                "UPDATE studies SET explorer_settings = ? WHERE explorer_settings IS NULL",
                (json.dumps(DEFAULT_EXPLORER_SETTINGS),),
            )

        if "side" not in columns:
            conn.execute(f"ALTER TABLE studies ADD COLUMN side TEXT NOT NULL DEFAULT '{DEFAULT_SIDE}'")

        if "stats" not in columns:
            conn.execute("ALTER TABLE studies ADD COLUMN stats TEXT")

        if "evals" not in columns:
            conn.execute("ALTER TABLE studies ADD COLUMN evals TEXT")

        if "start_node_id" not in columns:
            conn.execute("ALTER TABLE studies ADD COLUMN start_node_id INTEGER")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS explorer_cache (
                cache_key TEXT PRIMARY KEY,
                response TEXT NOT NULL,
                fetched_at TEXT NOT NULL
            )
            """
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS rating_cache (
                username TEXT PRIMARY KEY,
                bucket INTEGER NOT NULL,
                fetched_at TEXT NOT NULL
            )
            """
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_eval_cache (
                fen TEXT PRIMARY KEY,
                cp REAL,
                fetched_at TEXT NOT NULL
            )
            """
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS practice_state (
                owner TEXT NOT NULL,
                study_id INTEGER NOT NULL,
                node_id INTEGER NOT NULL,
                streak INTEGER NOT NULL DEFAULT 0,
                tau_days REAL NOT NULL DEFAULT 1.0,
                last_seen_at TEXT NOT NULL,
                PRIMARY KEY (owner, study_id, node_id)
            )
            """
        )


def _row_to_study(row: sqlite3.Row) -> dict[str, Any]:
    # Merged with defaults so older rows saved before a new explorerSettings
    # field existed (e.g. "speeds") still come back with a sensible value.
    saved_explorer_settings = json.loads(row["explorer_settings"]) if row["explorer_settings"] else {}
    explorer_settings = {**DEFAULT_EXPLORER_SETTINGS, **saved_explorer_settings}
    if "source" not in saved_explorer_settings and explorer_settings["database"] == "masters":
        explorer_settings["source"] = "lichess"
    if explorer_settings["source"] == "lirep" and explorer_settings["database"] == "masters":
        explorer_settings["database"] = "lichess"
    return {
        "id": row["id"],
        "name": row["name"],
        "tree": json.loads(row["tree"]),
        "explorerSettings": explorer_settings,
        "side": row["side"] or DEFAULT_SIDE,
        "stats": json.loads(row["stats"]) if row["stats"] else None,
        "evals": json.loads(row["evals"]) if row["evals"] else None,
        # None means "no override — calculations start at the tree's real
        # root", the default for every study. See starting-point.md.
        "startNodeId": row["start_node_id"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


_COLUMNS = "id, name, tree, explorer_settings, side, stats, evals, start_node_id, created_at, updated_at"


def list_studies(owner: str) -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            f"SELECT {_COLUMNS} FROM studies WHERE owner = ? ORDER BY updated_at DESC",
            (owner,),
        ).fetchall()
    return [_row_to_study(row) for row in rows]


def get_study(owner: str, study_id: int) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            f"SELECT {_COLUMNS} FROM studies WHERE owner = ? AND id = ?",
            (owner, study_id),
        ).fetchone()
    return _row_to_study(row) if row else None


def delete_study(owner: str, study_id: int) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM studies WHERE owner = ? AND id = ?", (owner, study_id))
        if cur.rowcount == 0:
            return False
        conn.execute("DELETE FROM practice_state WHERE owner = ? AND study_id = ?", (owner, study_id))
    return True


def create_study(
    owner: str,
    name: str,
    tree: dict[str, Any],
    explorer_settings: dict[str, Any],
    side: str,
    start_node_id: int | None = None,
) -> dict[str, Any]:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO studies (owner, name, tree, explorer_settings, side, start_node_id) VALUES (?, ?, ?, ?, ?, ?)",
            (owner, name, json.dumps(tree), json.dumps(explorer_settings), side, start_node_id),
        )
        study_id = cur.lastrowid
        row = conn.execute(f"SELECT {_COLUMNS} FROM studies WHERE id = ?", (study_id,)).fetchone()
    assert row is not None
    return _row_to_study(row)


def update_study(
    owner: str,
    study_id: int,
    name: str,
    tree: dict[str, Any],
    explorer_settings: dict[str, Any],
    side: str,
    start_node_id: int | None = None,
) -> dict[str, Any] | None:
    with _connect() as conn:
        cur = conn.execute(
            """
            UPDATE studies
            SET name = ?, tree = ?, explorer_settings = ?, side = ?, start_node_id = ?, updated_at = datetime('now')
            WHERE owner = ? AND id = ?
            """,
            (name, json.dumps(tree), json.dumps(explorer_settings), side, start_node_id, owner, study_id),
        )
        if cur.rowcount == 0:
            return None
        row = conn.execute(f"SELECT {_COLUMNS} FROM studies WHERE id = ?", (study_id,)).fetchone()
    assert row is not None
    return _row_to_study(row)


def update_explorer_settings(owner: str, study_id: int, explorer_settings: dict[str, Any]) -> dict[str, Any] | None:
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE studies SET explorer_settings = ?, updated_at = datetime('now') WHERE owner = ? AND id = ?",
            (json.dumps(explorer_settings), owner, study_id),
        )
        if cur.rowcount == 0:
            return None
        row = conn.execute(f"SELECT {_COLUMNS} FROM studies WHERE id = ?", (study_id,)).fetchone()
    assert row is not None
    return _row_to_study(row)


def set_study_stats(owner: str, study_id: int, stats: dict[str, Any]) -> dict[str, Any] | None:
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE studies SET stats = ? WHERE owner = ? AND id = ?",
            (json.dumps(stats), owner, study_id),
        )
        if cur.rowcount == 0:
            return None
        row = conn.execute(f"SELECT {_COLUMNS} FROM studies WHERE id = ?", (study_id,)).fetchone()
    assert row is not None
    return _row_to_study(row)


def set_study_evals(owner: str, study_id: int, evals: dict[str, Any]) -> dict[str, Any] | None:
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE studies SET evals = ? WHERE owner = ? AND id = ?",
            (json.dumps(evals), owner, study_id),
        )
        if cur.rowcount == 0:
            return None
        row = conn.execute(f"SELECT {_COLUMNS} FROM studies WHERE id = ?", (study_id,)).fetchone()
    assert row is not None
    return _row_to_study(row)


def get_explorer_cache(cache_key: str) -> dict[str, Any] | None:
    """None on a miss, whether that's because the key was never fetched or
    because the cached entry is older than EXPLORER_CACHE_TTL_SECONDS —
    either way the caller should fetch fresh and call set_explorer_cache."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT response, fetched_at FROM explorer_cache WHERE cache_key = ?", (cache_key,)
        ).fetchone()
    if row is None:
        return None
    fetched_at = datetime.fromisoformat(row["fetched_at"])
    if (datetime.now(UTC) - fetched_at).total_seconds() > EXPLORER_CACHE_TTL_SECONDS:
        return None
    return {"response": json.loads(row["response"]), "fetchedAt": row["fetched_at"]}


def set_explorer_cache(cache_key: str, response: dict[str, Any], fetched_at: str) -> None:
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO explorer_cache (cache_key, response, fetched_at) VALUES (?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET response = excluded.response, fetched_at = excluded.fetched_at
            """,
            (cache_key, json.dumps(response), fetched_at),
        )


def get_rating_cache(username: str, *, allow_stale: bool = False) -> int | None:
    """The signed-in player's cached rating bucket, or None on a miss.

    `allow_stale=True` returns whatever's stored regardless of
    RATING_CACHE_TTL_SECONDS — used only as a fallback when a live refresh
    attempt itself fails (e.g. rate limited), where a somewhat-stale bucket
    is strictly better than failing a request that might otherwise be a
    cache hit. The normal (`allow_stale=False`) path is what makes this
    persistent rather than in-memory actually matter: an in-memory cache is
    wiped by every backend restart, which would otherwise force a live
    account call — and risk hitting a live rate limit — for a bucket that
    was, from the user's perspective, resolved minutes ago and still fresh.
    """
    with _connect() as conn:
        row = conn.execute("SELECT bucket, fetched_at FROM rating_cache WHERE username = ?", (username,)).fetchone()
    if row is None:
        return None
    if not allow_stale:
        fetched_at = datetime.fromisoformat(row["fetched_at"])
        if (datetime.now(UTC) - fetched_at).total_seconds() > RATING_CACHE_TTL_SECONDS:
            return None
    return row["bucket"]


def set_rating_cache(username: str, bucket: int, fetched_at: str) -> None:
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO rating_cache (username, bucket, fetched_at) VALUES (?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET bucket = excluded.bucket, fetched_at = excluded.fetched_at
            """,
            (username, bucket, fetched_at),
        )


def get_cloud_eval_cache(fen: str) -> dict[str, Any] | None:
    """None on a miss that's worth retrying (never fetched, or a stored
    "no eval" older than CLOUD_EVAL_MISS_TTL_SECONDS). A stored real value
    (cp is not None) is always returned regardless of age — an engine
    evaluation of a fixed position doesn't go stale the way real-world game
    stats do. Global and permanent-ish by design: this is what lets
    "Calculate scores" reuse an opponent-move-outside-your-tree evaluation
    indefinitely, across every future recalculation of any study that ever
    needs that exact position, instead of re-fetching it from Lichess every
    single run — see explorer-cache.md.
    """
    with _connect() as conn:
        row = conn.execute("SELECT cp, fetched_at FROM cloud_eval_cache WHERE fen = ?", (fen,)).fetchone()
    if row is None:
        return None
    if row["cp"] is None:
        fetched_at = datetime.fromisoformat(row["fetched_at"])
        if (datetime.now(UTC) - fetched_at).total_seconds() > CLOUD_EVAL_MISS_TTL_SECONDS:
            return None
    return {"cp": row["cp"], "fetchedAt": row["fetched_at"]}


def set_cloud_eval_cache(fen: str, cp: float | None, fetched_at: str) -> None:
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO cloud_eval_cache (fen, cp, fetched_at) VALUES (?, ?, ?)
            ON CONFLICT(fen) DO UPDATE SET cp = excluded.cp, fetched_at = excluded.fetched_at
            """,
            (fen, cp, fetched_at),
        )


def get_practice_states(owner: str, study_id: int) -> dict[int, dict[str, Any]]:
    """Every drill-item node this study has ever recorded an attempt for,
    keyed by node_id. A node missing from the result has never been
    attempted ("new" — see practice.md §3); there's deliberately no row for
    it until the first attempt, rather than a zeroed-out row up front, so
    "never attempted" and "attempted and reset to streak 0" stay
    distinguishable at the storage layer too."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT node_id, streak, tau_days, last_seen_at FROM practice_state WHERE owner = ? AND study_id = ?",
            (owner, study_id),
        ).fetchall()
    return {
        row["node_id"]: {"streak": row["streak"], "tau_days": row["tau_days"], "last_seen_at": row["last_seen_at"]}
        for row in rows
    }


def upsert_practice_state(
    owner: str, study_id: int, node_id: int, streak: int, tau_days: float, last_seen_at: str
) -> None:
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO practice_state (owner, study_id, node_id, streak, tau_days, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(owner, study_id, node_id) DO UPDATE SET
                streak = excluded.streak, tau_days = excluded.tau_days, last_seen_at = excluded.last_seen_at
            """,
            (owner, study_id, node_id, streak, tau_days, last_seen_at),
        )
