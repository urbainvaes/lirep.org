"""Read-only: lists the studies that fail the read checks, and why.

Usage (from backend/): python check_studies.py [path/to/lirep.db] [name filter]
"""

import sqlite3
import sys

from app.study_tree import InvalidTree, validate_tree

import json

path = sys.argv[1] if len(sys.argv) > 1 else "lirep.db"
name_filter = sys.argv[2].lower() if len(sys.argv) > 2 else ""
conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
for row in conn.execute("SELECT id, owner, name, side, tree, archived_at FROM studies ORDER BY id"):
    if name_filter not in row["name"].lower():
        continue
    try:
        validate_tree(json.loads(row["tree"]), row["side"] or "white")
        status = "ok"
    except (InvalidTree, ValueError, KeyError, TypeError, RecursionError) as exc:
        status = f"FAILS: {exc}"
    if name_filter or status != "ok":
        archived = " (archived)" if row["archived_at"] else ""
        print(f"{row['id']}\t{row['owner']}\t{row['name']}{archived}\t{status}")
