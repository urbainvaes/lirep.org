import json
import sqlite3
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).resolve().parent.parent / "chesster.db"

DEFAULT_EXPLORER_SETTINGS: dict[str, Any] = {"enabled": True, "database": "lichess", "minRating": None}
DEFAULT_SIDE = "white"


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


def _row_to_study(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "tree": json.loads(row["tree"]),
        "explorerSettings": json.loads(row["explorer_settings"]) if row["explorer_settings"] else DEFAULT_EXPLORER_SETTINGS,
        "side": row["side"] or DEFAULT_SIDE,
        "stats": json.loads(row["stats"]) if row["stats"] else None,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


_COLUMNS = "id, name, tree, explorer_settings, side, stats, created_at, updated_at"


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


def create_study(
    owner: str, name: str, tree: dict[str, Any], explorer_settings: dict[str, Any], side: str
) -> dict[str, Any]:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO studies (owner, name, tree, explorer_settings, side) VALUES (?, ?, ?, ?, ?)",
            (owner, name, json.dumps(tree), json.dumps(explorer_settings), side),
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
) -> dict[str, Any] | None:
    with _connect() as conn:
        cur = conn.execute(
            """
            UPDATE studies
            SET name = ?, tree = ?, explorer_settings = ?, side = ?, updated_at = datetime('now')
            WHERE owner = ? AND id = ?
            """,
            (name, json.dumps(tree), json.dumps(explorer_settings), side, owner, study_id),
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
