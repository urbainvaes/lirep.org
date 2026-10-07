import hashlib
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime
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
        # The study's game sections, in order: a JSON list of names (see
        # study_games), so a section keeps its place even while empty.
        if "game_sections" not in columns:
            conn.execute("ALTER TABLE studies ADD COLUMN game_sections TEXT")

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
        # Anonymous players keep sharing their studies, but their name is not
        # shown next to them (see community.py).
        if "anonymous" not in user_columns:
            conn.execute("ALTER TABLE users ADD COLUMN anonymous INTEGER NOT NULL DEFAULT 0")
        conn.execute(
            """
            INSERT OR IGNORE INTO users (username, created_at)
            SELECT owner, MIN(created_at) FROM studies
            WHERE owner COLLATE NOCASE NOT IN (SELECT username FROM users)
            GROUP BY owner
            ORDER BY MIN(created_at), MIN(id)
            """
        )

        # Lichess Explorer responses used to be cached here; the browser now
        # queries Lichess itself and caches them (see explorer-cache.md).
        conn.execute("DROP TABLE IF EXISTS explorer_cache")

        # Games attached to a study (its Games page): the PGN as given, a
        # comment, and the game's section and place within it.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS study_games (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                study_id INTEGER NOT NULL,
                section TEXT NOT NULL,
                position INTEGER NOT NULL,
                pgn TEXT NOT NULL,
                comment TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS study_games_study ON study_games (study_id)")

        # The forum: topics, each with its posts (the first post opens the
        # topic). Authors are Lichess usernames, always shown.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS forum_topics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                author TEXT NOT NULL,
                category TEXT NOT NULL,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_post_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS forum_posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                topic_id INTEGER NOT NULL,
                author TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS forum_posts_topic ON forum_posts (topic_id, id)")

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



def moves_fingerprint(tree: dict[str, Any], start_node_id: int | None) -> str:
    """A short hash of what the stats depend on: every move in the tree, in
    order (the first child of a prepared-side node is the prepared move), and
    the starting point. Comments and node ids don't count. Each result stores
    the fingerprint it was calculated from, so the Stats page can tell when
    the moves changed since."""
    nodes = tree["nodes"]

    def serialize(node_id: int) -> str:
        node = nodes[str(node_id)]
        return f"{node.get('san') or ''}({','.join(serialize(child) for child in node['children'])})"

    start = start_node_id if start_node_id is not None and str(start_node_id) in nodes else tree["rootId"]
    path: list[str] = []
    node_id: int | None = start
    while node_id is not None and node_id != tree["rootId"]:
        node = nodes[str(node_id)]
        path.append(node.get("san") or "")
        node_id = node.get("parentId")
    payload = serialize(tree["rootId"]) + "|" + " ".join(reversed(path))
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def _row_to_study(row: sqlite3.Row) -> dict[str, Any]:
    # Merged with defaults so older rows saved before a new explorerSettings
    # field existed (e.g. "speeds") still come back with a sensible value.
    saved_explorer_settings = json.loads(row["explorer_settings"]) if row["explorer_settings"] else {}
    explorer_settings = {**DEFAULT_EXPLORER_SETTINGS, **saved_explorer_settings}
    if "source" not in saved_explorer_settings and explorer_settings["database"] == "masters":
        explorer_settings["source"] = "lichess"
    if explorer_settings["source"] == "lirep" and explorer_settings["database"] == "masters":
        explorer_settings["database"] = "lichess"
    tree = json.loads(row["tree"])
    return {
        "id": row["id"],
        "name": row["name"],
        "tree": tree,
        "movesFingerprint": moves_fingerprint(tree, row["start_node_id"]),
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
            SELECT u.id, u.username, u.created_at, u.anonymous,
                   (SELECT COUNT(*) FROM studies s
                     WHERE s.owner = u.username COLLATE NOCASE AND s.shared = 1) AS shared
            FROM users u ORDER BY u.id
            """
        ).fetchall()
    return [
        {
            "number": row["id"],
            "username": row["username"],
            "joined": row["created_at"],
            "sharedStudies": row["shared"],
            "anonymous": bool(row["anonymous"]),
        }
        for row in rows
    ]


def get_user(username: str) -> dict[str, Any] | None:
    """A registered user (matched case-insensitively), or None."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, username, created_at, anonymous FROM users WHERE username = ? COLLATE NOCASE", (username,)
        ).fetchone()
    if row is None:
        return None
    return {
        "number": row["id"],
        "username": row["username"],
        "joined": row["created_at"],
        "anonymous": bool(row["anonymous"]),
    }


def set_user_anonymous(username: str, anonymous: bool) -> bool:
    """False if the user is not registered."""
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE users SET anonymous = ? WHERE username = ? COLLATE NOCASE", (1 if anonymous else 0, username)
        )
    return cur.rowcount > 0


def anonymous_usernames() -> set[str]:
    """The lowercased usernames of the players who chose to be anonymous."""
    with _connect() as conn:
        rows = conn.execute("SELECT username FROM users WHERE anonymous = 1").fetchall()
    return {row["username"].lower() for row in rows}


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
        counts = dict(
            conn.execute(
                """
                SELECT g.study_id, COUNT(*) FROM study_games g JOIN studies s ON s.id = g.study_id
                WHERE s.owner = ? GROUP BY g.study_id
                """,
                (owner,),
            ).fetchall()
        )
    # The home page's cards show how many games a study has.
    return [{**_row_to_study(row), "gameCount": counts.get(row["id"], 0)} for row in rows]


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
        conn.execute("DELETE FROM study_games WHERE study_id = ?", (study_id,))
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


def list_forum_topics(category: str | None = None) -> list[dict[str, Any]]:
    """Topics, most recently active first, with their reply count and the
    author of the last post."""
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT t.id, t.author, t.category, t.title, t.created_at, t.last_post_at,
                   (SELECT COUNT(*) - 1 FROM forum_posts p WHERE p.topic_id = t.id) AS replies,
                   (SELECT p.author FROM forum_posts p WHERE p.topic_id = t.id ORDER BY p.id DESC LIMIT 1) AS last_author
            FROM forum_topics t
            WHERE ? IS NULL OR t.category = ?
            ORDER BY t.last_post_at DESC, t.id DESC
            """,
            (category, category),
        ).fetchall()
    return [
        {
            "id": row["id"],
            "author": row["author"],
            "category": row["category"],
            "title": row["title"],
            "createdAt": row["created_at"],
            "lastPostAt": row["last_post_at"],
            "replies": max(0, row["replies"]),
            "lastAuthor": row["last_author"],
        }
        for row in rows
    ]


def get_forum_topic(topic_id: int) -> dict[str, Any] | None:
    """A topic with all its posts, oldest first; None if it doesn't exist."""
    with _connect() as conn:
        topic = conn.execute(
            "SELECT id, author, category, title, created_at FROM forum_topics WHERE id = ?", (topic_id,)
        ).fetchone()
        if topic is None:
            return None
        posts = conn.execute(
            "SELECT id, author, body, created_at FROM forum_posts WHERE topic_id = ? ORDER BY id", (topic_id,)
        ).fetchall()
    return {
        "id": topic["id"],
        "author": topic["author"],
        "category": topic["category"],
        "title": topic["title"],
        "createdAt": topic["created_at"],
        "posts": [
            {"id": p["id"], "author": p["author"], "body": p["body"], "createdAt": p["created_at"]} for p in posts
        ],
    }


def create_forum_topic(author: str, category: str, title: str, body: str) -> int:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO forum_topics (author, category, title) VALUES (?, ?, ?)", (author, category, title)
        )
        topic_id = cur.lastrowid
        conn.execute("INSERT INTO forum_posts (topic_id, author, body) VALUES (?, ?, ?)", (topic_id, author, body))
    assert topic_id is not None
    return topic_id


def add_forum_post(topic_id: int, author: str, body: str) -> int | None:
    """None if the topic doesn't exist."""
    with _connect() as conn:
        cur = conn.execute("UPDATE forum_topics SET last_post_at = datetime('now') WHERE id = ?", (topic_id,))
        if cur.rowcount == 0:
            return None
        cur = conn.execute(
            "INSERT INTO forum_posts (topic_id, author, body) VALUES (?, ?, ?)", (topic_id, author, body)
        )
    return cur.lastrowid


def get_forum_post(post_id: int) -> dict[str, Any] | None:
    """A post's author and topic, and whether it opens the topic."""
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT p.id, p.topic_id, p.author,
                   p.id = (SELECT MIN(q.id) FROM forum_posts q WHERE q.topic_id = p.topic_id) AS first
            FROM forum_posts p WHERE p.id = ?
            """,
            (post_id,),
        ).fetchone()
    return {"id": row["id"], "topicId": row["topic_id"], "author": row["author"], "first": bool(row["first"])} if row else None


def delete_forum_post(post_id: int) -> None:
    """Deletes a reply; deleting a topic's first post deletes the topic."""
    post = get_forum_post(post_id)
    if post is None:
        return
    with _connect() as conn:
        if post["first"]:
            conn.execute("DELETE FROM forum_posts WHERE topic_id = ?", (post["topicId"],))
            conn.execute("DELETE FROM forum_topics WHERE id = ?", (post["topicId"],))
        else:
            conn.execute("DELETE FROM forum_posts WHERE id = ?", (post_id,))
            # The topic's activity is its latest remaining post.
            conn.execute(
                """
                UPDATE forum_topics SET last_post_at =
                    (SELECT MAX(created_at) FROM forum_posts WHERE topic_id = ?)
                WHERE id = ?
                """,
                (post["topicId"], post["topicId"]),
            )


def count_recent_forum_posts(author: str, minutes: int) -> int:
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT COUNT(*) AS n FROM forum_posts
            WHERE author = ? COLLATE NOCASE AND created_at >= datetime('now', ?)
            """,
            (author, f"-{minutes} minutes"),
        ).fetchone()
    return int(row["n"])


# Games attached to a study. The caller checks that the study is the
# player's own; these only take its id.


def _game_sections(conn: sqlite3.Connection, study_id: int) -> list[str]:
    row = conn.execute("SELECT game_sections FROM studies WHERE id = ?", (study_id,)).fetchone()
    return json.loads(row["game_sections"]) if row and row["game_sections"] else []


def get_study_games(study_id: int) -> dict[str, Any]:
    """The study's sections in order, and its games in section order then
    their place within the section."""
    with _connect() as conn:
        sections = _game_sections(conn, study_id)
        rows = conn.execute(
            "SELECT id, section, position, pgn, comment FROM study_games WHERE study_id = ?", (study_id,)
        ).fetchall()
    order = {name: i for i, name in enumerate(sections)}
    games = sorted(rows, key=lambda r: (order.get(r["section"], len(order)), r["position"], r["id"]))
    # A game whose section is missing from the list (shouldn't happen) still shows.
    sections += [name for name in dict.fromkeys(r["section"] for r in games) if name not in order]
    return {
        "sections": sections,
        "games": [{"id": r["id"], "section": r["section"], "pgn": r["pgn"], "comment": r["comment"]} for r in games],
    }


def count_study_games(study_id: int) -> int:
    with _connect() as conn:
        return int(conn.execute("SELECT COUNT(*) FROM study_games WHERE study_id = ?", (study_id,)).fetchone()[0])


def add_study_games(study_id: int, section: str, games: list[dict[str, str]]) -> list[int]:
    """Appends games ({"pgn", "comment"}) to the end of a section, which is
    created at the end of the list if new."""
    with _connect() as conn:
        sections = _game_sections(conn, study_id)
        if section not in sections:
            sections.append(section)
            conn.execute("UPDATE studies SET game_sections = ? WHERE id = ?", (json.dumps(sections), study_id))
        position = conn.execute(
            "SELECT COALESCE(MAX(position), -1) FROM study_games WHERE study_id = ? AND section = ?", (study_id, section)
        ).fetchone()[0]
        ids = []
        for game in games:
            position += 1
            cur = conn.execute(
                "INSERT INTO study_games (study_id, section, position, pgn, comment) VALUES (?, ?, ?, ?, ?)",
                (study_id, section, position, game["pgn"], game.get("comment", "")),
            )
            ids.append(cur.lastrowid)
    return ids


def set_study_game_comment(study_id: int, game_id: int, comment: str) -> bool:
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE study_games SET comment = ? WHERE id = ? AND study_id = ?", (comment, game_id, study_id)
        )
    return cur.rowcount > 0


def delete_study_game(study_id: int, game_id: int) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM study_games WHERE id = ? AND study_id = ?", (game_id, study_id))
    return cur.rowcount > 0


def set_study_game_layout(study_id: int, layout: list[dict[str, Any]]) -> bool:
    """Sets the sections, in order, and each one's games, in order:
    [{"name", "gameIds"}]. This is how sections are reordered, renamed,
    added or removed, and games reordered or moved between sections. Every
    game of the study must appear exactly once; False otherwise."""
    with _connect() as conn:
        existing = {r[0] for r in conn.execute("SELECT id FROM study_games WHERE study_id = ?", (study_id,))}
        listed = [game_id for section in layout for game_id in section["gameIds"]]
        if sorted(listed) != sorted(existing) or len(set(listed)) != len(listed):
            return False
        for section in layout:
            for position, game_id in enumerate(section["gameIds"]):
                conn.execute(
                    "UPDATE study_games SET section = ?, position = ? WHERE id = ?", (section["name"], position, game_id)
                )
        conn.execute(
            "UPDATE studies SET game_sections = ? WHERE id = ?",
            (json.dumps([section["name"] for section in layout]), study_id),
        )
    return True
