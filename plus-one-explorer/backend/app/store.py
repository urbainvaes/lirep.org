import json
import sqlite3
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).resolve().parent.parent / "chesster.db"


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


def _row_to_study(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "tree": json.loads(row["tree"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_studies(owner: str) -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, name, tree, created_at, updated_at FROM studies WHERE owner = ? ORDER BY updated_at DESC",
            (owner,),
        ).fetchall()
    return [_row_to_study(row) for row in rows]


def get_study(owner: str, study_id: int) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, name, tree, created_at, updated_at FROM studies WHERE owner = ? AND id = ?",
            (owner, study_id),
        ).fetchone()
    return _row_to_study(row) if row else None


def create_study(owner: str, name: str, tree: dict[str, Any]) -> dict[str, Any]:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO studies (owner, name, tree) VALUES (?, ?, ?)",
            (owner, name, json.dumps(tree)),
        )
        study_id = cur.lastrowid
        row = conn.execute(
            "SELECT id, name, tree, created_at, updated_at FROM studies WHERE id = ?",
            (study_id,),
        ).fetchone()
    assert row is not None
    return _row_to_study(row)


def update_study(owner: str, study_id: int, name: str, tree: dict[str, Any]) -> dict[str, Any] | None:
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE studies SET name = ?, tree = ?, updated_at = datetime('now') WHERE owner = ? AND id = ?",
            (name, json.dumps(tree), owner, study_id),
        )
        if cur.rowcount == 0:
            return None
        row = conn.execute(
            "SELECT id, name, tree, created_at, updated_at FROM studies WHERE id = ?",
            (study_id,),
        ).fetchone()
    assert row is not None
    return _row_to_study(row)
