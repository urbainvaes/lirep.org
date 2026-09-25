import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Iterator

from .config import DEFAULT_EXPLORER_SOURCE

# LIREP_DB_PATH lets a deployment keep the database outside the source tree.
DB_PATH = Path(os.getenv("LIREP_DB_PATH") or Path(__file__).resolve().parent.parent / "lirep.db")

DEFAULT_EXPLORER_SETTINGS: dict[str, Any] = {
    "enabled": True,
    "source": DEFAULT_EXPLORER_SOURCE,
    "database": "lichess",
    "minRating": None,
    "player": None,
    "speeds": ["blitz", "rapid", "classical"],
}
DEFAULT_SIDE = "white"

# A position's real-world move frequencies shift slowly, so a day-old cached
# Opening Explorer response is still practically accurate — and it's shared
# across every study and user, keyed by provider and query (fen + database +
# ratings + speeds), not tied to any one study.
EXPLORER_CACHE_TTL_SECONDS = 24 * 60 * 60
EXPLORER_CACHE_MAX_BYTES = 512 * 1024 * 1024
EXPLORER_CACHE_CLEANUP_INTERVAL_SECONDS = 60 * 60
EXPLORER_CACHE_CLEANUP_WRITE_INTERVAL = 1000

_last_explorer_cache_cleanup: datetime | None = None
_explorer_cache_writes_since_cleanup = 0

# How long a resolved "my current rating" bucket is trusted before
# re-checking Lichess. Persisted (not in-memory) specifically so a backend
# restart can't silently erase a still-fresh resolution and force a live
# account call it didn't actually need — see explorer-cache.md.
RATING_CACHE_TTL_SECONDS = 60 * 60


@contextmanager
def _connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        with conn:
            yield conn
    finally:
        conn.close()


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

        # Sharing with the Community page: public by default, and the owner can
        # switch it off per study. (Databases that got the column before this
        # default existed keep their stored values.)
        if "shared" not in columns:
            conn.execute("ALTER TABLE studies ADD COLUMN shared INTEGER NOT NULL DEFAULT 1")

        # Registration order: users.id is the user number, starting at 1. Lichess
        # usernames are case-insensitive. Accounts that existed before this table
        # (known only through their studies) are numbered by their first study.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        user_columns = {row["name"] for row in conn.execute("PRAGMA table_info(users)")}
        if "last_seen_at" not in user_columns:
            conn.execute("ALTER TABLE users ADD COLUMN last_seen_at TEXT")
        conn.execute(
            """
            INSERT OR IGNORE INTO users (username, created_at)
            SELECT owner, MIN(created_at) FROM studies
            WHERE owner COLLATE NOCASE NOT IN (SELECT username FROM users)
            GROUP BY owner
            ORDER BY MIN(created_at), MIN(id)
            """
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS explorer_cache (
                cache_key TEXT PRIMARY KEY,
                response TEXT NOT NULL,
                fetched_at TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS explorer_cache_fetched_at ON explorer_cache(fetched_at)")

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

    prune_explorer_cache()


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
        "shared": bool(row["shared"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


_COLUMNS = "id, name, tree, explorer_settings, side, stats, evals, start_node_id, shared, created_at, updated_at"


def register_user(username: str) -> int:
    """Returns the user's number (1 for the first registered), registering them
    on first sight."""
    with _connect() as conn:
        row = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if row is None:
            # Insert only when missing: even an ignored INSERT would use up an
            # AUTOINCREMENT value and leave gaps in the numbering.
            conn.execute("INSERT OR IGNORE INTO users (username) VALUES (?)", (username,))
            row = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
    assert row is not None
    return int(row["id"])


def register_user_limited(username: str, limit: int) -> int | None:
    """Like register_user, but a *new* user is refused (None) once `limit`
    users exist (0 = no limit). Users already registered always get their
    number back. The check and the insert share one write transaction, so two
    simultaneous first sign-ins cannot both take the last place."""
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if row is None:
            if limit and conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"] >= limit:
                return None
            conn.execute("INSERT INTO users (username) VALUES (?)", (username,))
            row = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
    assert row is not None
    return int(row["id"])


def touch_user(username: str) -> None:
    """Records that the user was seen now (at most once an hour), for the
    Community page's "active this week" count. Registers them if needed."""
    with _connect() as conn:
        cur = conn.execute(
            """
            UPDATE users SET last_seen_at = datetime('now')
            WHERE username = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-1 hour'))
            """,
            (username,),
        )
        if cur.rowcount == 0 and conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone() is None:
            conn.execute(
                "INSERT OR IGNORE INTO users (username, last_seen_at) VALUES (?, datetime('now'))", (username,)
            )


def list_users() -> list[dict[str, Any]]:
    """Everyone registered, in registration order, with how many of their
    studies are shared."""
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT u.id, u.username, u.created_at,
                   (SELECT COUNT(*) FROM studies s
                     WHERE s.owner = u.username COLLATE NOCASE AND s.shared = 1) AS shared
            FROM users u ORDER BY u.id
            """
        ).fetchall()
    return [
        {"number": row["id"], "username": row["username"], "joined": row["created_at"], "sharedStudies": row["shared"]}
        for row in rows
    ]


def set_study_shared(owner: str, study_id: int, shared: bool) -> dict[str, Any] | None:
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE studies SET shared = ? WHERE owner = ? AND id = ?",
            (1 if shared else 0, owner, study_id),
        )
        if cur.rowcount == 0:
            return None
        row = conn.execute(f"SELECT {_COLUMNS} FROM studies WHERE id = ?", (study_id,)).fetchone()
    assert row is not None
    return _row_to_study(row)


def list_shared_studies() -> list[tuple[str, dict[str, Any]]]:
    """(owner, study) for every study its owner has chosen to share."""
    with _connect() as conn:
        rows = conn.execute(f"SELECT owner, {_COLUMNS} FROM studies WHERE shared = 1").fetchall()
    return [(row["owner"], _row_to_study(row)) for row in rows]


def get_shared_study(study_id: int) -> tuple[str, dict[str, Any]] | None:
    with _connect() as conn:
        row = conn.execute(
            f"SELECT owner, {_COLUMNS} FROM studies WHERE id = ? AND shared = 1", (study_id,)
        ).fetchone()
    return (row["owner"], _row_to_study(row)) if row else None


def community_counts() -> dict[str, int]:
    with _connect() as conn:
        players = conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
        studies = conn.execute("SELECT COUNT(*) AS n FROM studies").fetchone()["n"]
        shared = conn.execute("SELECT COUNT(*) AS n FROM studies WHERE shared = 1").fetchone()["n"]
        active = conn.execute(
            "SELECT COUNT(*) AS n FROM users WHERE last_seen_at >= datetime('now', '-7 days')"
        ).fetchone()["n"]
    return {
        "players": int(players),
        "studies": int(studies),
        "sharedStudies": int(shared),
        "activeThisWeek": int(active),
    }


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
    shared: bool = True,
) -> dict[str, Any]:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO studies (owner, name, tree, explorer_settings, side, start_node_id, shared)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (owner, name, json.dumps(tree), json.dumps(explorer_settings), side, start_node_id, 1 if shared else 0),
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


def merge_study_stats(
    owner: str, study_id: int, updates: dict[str, Any], *, explorer_settings: dict[str, Any] | None = None
) -> dict[str, Any] | None:
    """Merge against the latest row inside one transaction, preserving other stats jobs' results."""
    with _connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT stats FROM studies WHERE owner = ? AND id = ?", (owner, study_id)).fetchone()
        if row is None:
            return None
        stats = json.loads(row["stats"]) if row["stats"] else {}
        stats.update(updates)
        if explorer_settings is None:
            conn.execute("UPDATE studies SET stats = ? WHERE owner = ? AND id = ?", (json.dumps(stats), owner, study_id))
        else:
            conn.execute(
                "UPDATE studies SET stats = ?, explorer_settings = ?, updated_at = datetime('now') WHERE owner = ? AND id = ?",
                (json.dumps(stats), json.dumps(explorer_settings), owner, study_id),
            )
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
    global _explorer_cache_writes_since_cleanup
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO explorer_cache (cache_key, response, fetched_at) VALUES (?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET response = excluded.response, fetched_at = excluded.fetched_at
            """,
            (cache_key, json.dumps(response), fetched_at),
        )
    _explorer_cache_writes_since_cleanup += 1
    now = datetime.now(UTC)
    if (
        _last_explorer_cache_cleanup is None
        or (now - _last_explorer_cache_cleanup).total_seconds() >= EXPLORER_CACHE_CLEANUP_INTERVAL_SECONDS
        or _explorer_cache_writes_since_cleanup >= EXPLORER_CACHE_CLEANUP_WRITE_INTERVAL
    ):
        prune_explorer_cache(now)


def prune_explorer_cache(now: datetime | None = None) -> None:
    global _last_explorer_cache_cleanup, _explorer_cache_writes_since_cleanup
    now = now or datetime.now(UTC)
    cutoff = (now - timedelta(seconds=EXPLORER_CACHE_TTL_SECONDS)).isoformat()
    with _connect() as conn:
        conn.execute("DELETE FROM explorer_cache WHERE fetched_at < ?", (cutoff,))
        total = conn.execute(
            "SELECT coalesce(sum(length(cache_key) + length(response)), 0) FROM explorer_cache"
        ).fetchone()[0]
        if total > EXPLORER_CACHE_MAX_BYTES:
            oldest = conn.execute(
                "SELECT cache_key, length(cache_key) + length(response) AS size "
                "FROM explorer_cache ORDER BY fetched_at, cache_key"
            )
            to_delete = []
            for row in oldest:
                to_delete.append((row["cache_key"],))
                total -= row["size"]
                if total <= EXPLORER_CACHE_MAX_BYTES:
                    break
            conn.executemany("DELETE FROM explorer_cache WHERE cache_key = ?", to_delete)
    _last_explorer_cache_cleanup = now
    _explorer_cache_writes_since_cleanup = 0


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
