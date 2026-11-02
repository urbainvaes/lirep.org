import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

from app import cache, store


def request(username=None):
    session = {"username": username, "access_token": "t"} if username else {}
    return Request({"type": "http", "session": session})


class ExplorerCacheTests(unittest.TestCase):
    """The shared Explorer cache: written by the accounts with server
    storage only, read by anyone signed in; seeded at startup."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.dir = Path(directory.name)
        db = patch.object(store, "DB_PATH", self.dir / "test.db")
        db.start()
        self.addCleanup(db.stop)
        store.init_db()
        # The first account registered (id 1) has server storage.
        for username in ("owner", "someone"):
            store.register_user_limited(username, 10)

    def put(self, username, key="k", fetched_at=1.0, data=None):
        entry = cache.ExplorerEntryIn(key=key, data=data or {"moves": []}, fetchedAt=fetched_at)
        return cache.explorer_store(cache.ExplorerStoreIn(entries=[entry]), request(username))

    def lookup(self, username, keys=("k",)):
        return cache.explorer_lookup(cache.ExplorerLookupIn(keys=list(keys)), request(username))

    def test_only_server_storage_accounts_write(self):
        self.assertEqual(self.put("owner"), {"stored": 1})
        with self.assertRaises(HTTPException) as raised:
            self.put("someone")
        self.assertEqual(raised.exception.status_code, 403)

    def test_anyone_signed_in_reads(self):
        self.put("owner", data={"moves": [1]})
        self.assertEqual(self.lookup("someone")["entries"]["k"]["data"], {"moves": [1]})
        with self.assertRaises(HTTPException) as raised:
            self.lookup(None)
        self.assertEqual(raised.exception.status_code, 401)

    def test_seed_loads_where_newer(self):
        self.put("owner", key="old", fetched_at=5.0, data={"v": "cached"})
        self.put("owner", key="new", fetched_at=50.0, data={"v": "cached"})
        seed = self.dir / "seed.json"
        seed.write_text(json.dumps({"entries": [
            {"key": "old", "data": {"v": "seed"}, "fetchedAt": 10.0},
            {"key": "new", "data": {"v": "seed"}, "fetchedAt": 10.0},
            {"key": "absent", "data": {"v": "seed"}, "fetchedAt": 10.0},
        ]}))
        self.assertEqual(cache.load_explorer_seed(seed), 3)
        entries = self.lookup("owner", ["old", "new", "absent"])["entries"]
        self.assertEqual({key: entry["data"]["v"] for key, entry in entries.items()},
                         {"old": "seed", "new": "cached", "absent": "seed"})

    def test_no_seed_file(self):
        self.assertEqual(cache.load_explorer_seed(self.dir / "missing.json"), 0)


if __name__ == "__main__":
    unittest.main()
