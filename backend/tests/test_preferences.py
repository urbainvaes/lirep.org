import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError
from starlette.requests import Request

from app import auth, store


class PreferencesTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        db = patch.object(store, "DB_PATH", Path(directory.name) / "test.db")
        db.start()
        self.addCleanup(db.stop)
        store.init_db()
        store.register_user("alice")
        self.request = Request({"type": "http", "session": {"username": "alice", "access_token": "x"}})

    def me(self):
        return asyncio.run(auth.me(self.request))

    def test_saved_with_the_account_merged_and_returned_by_me(self):
        self.assertEqual(self.me()["preferences"], {})
        auth.set_preferences(auth.PreferencesIn(badgeShine="flat"), self.request)
        auth.set_preferences(auth.PreferencesIn(badgeIcons="lichess"), self.request)
        self.assertEqual(self.me()["preferences"], {"badgeShine": "flat", "badgeIcons": "lichess"})

    def test_unknown_values_and_fields_are_refused(self):
        for bad in ({"badgeShine": "sparkly"}, {"badgeIcons": "emoji"}, {"theme": "dark"}):
            with self.subTest(bad=bad), self.assertRaises(ValidationError):
                auth.PreferencesIn(**bad)

    def test_signed_out_cannot_save(self):
        request = Request({"type": "http", "session": {}})
        with self.assertRaises(HTTPException) as error:
            auth.set_preferences(auth.PreferencesIn(badgeShine="flat"), request)
        self.assertEqual(error.exception.status_code, 401)


if __name__ == "__main__":
    unittest.main()
