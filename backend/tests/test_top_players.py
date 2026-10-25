import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app import community


class TopPlayersPrivacyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.registered = [{"username": "Alice"}, {"username": "Bob"}]
        self.names = community._Names()
        self.fetch = AsyncMock(return_value=[
            {"username": "Alice", "title": "GM", "perfs": {"blitz": {"rating": 2199, "games": 10}}},
            {"username": "Bob", "perfs": {"blitz": {"rating": 2150, "games": 10}}},
        ])
        patches = [
            patch.object(community, "_top_players", None),
            patch.object(community, "_top_players_at", 0),
            patch.object(community, "_top_players_lock", asyncio.Lock()),
            patch.object(community, "_fetch_lichess_users", self.fetch),
            patch.object(community.store, "list_users", side_effect=lambda: self.registered),
            patch.object(community, "_names", side_effect=lambda: self.names),
        ]
        for mocked in patches:
            mocked.start()
            self.addCleanup(mocked.stop)

    async def test_anonymity_applies_immediately_and_reranks_cached_ratings(self):
        initial = await community.top_players()
        self.assertEqual(initial["blitz"][0]["username"], "Alice")
        self.names = community._Names(frozenset({"alice"}))
        current = await community.top_players()
        self.assertEqual(current["blitz"][0]["username"], "Bob")
        self.assertEqual(current["blitz"][1]["rating"], 2100)
        self.assertIsNone(current["blitz"][1]["username"])
        self.fetch.assert_awaited_once()

    async def test_alias_changes_hide_identity_and_title_without_refresh(self):
        await community.top_players()
        self.names = community._Names(aliases={"alice": "Pen name"})
        current = await community.top_players()
        alice = next(p for p in current["blitz"] if p["username"] == "Pen name")
        self.assertEqual(alice, {"username": "Pen name", "title": None, "rating": 2100, "roundedDown": True})
        self.fetch.assert_awaited_once()

    async def test_deleted_players_disappear_without_refresh(self):
        await community.top_players()
        self.registered = [{"username": "Bob"}]
        current = await community.top_players()
        self.assertEqual([p["username"] for p in current["blitz"]], ["Bob"])
        self.fetch.assert_awaited_once()

    async def test_stale_fallback_still_applies_current_privacy_and_registration(self):
        await community.top_players()
        community._top_players_at = -community.TOP_PLAYERS_TTL_SECONDS
        self.fetch.side_effect = httpx.ConnectError("offline")
        self.names = community._Names(frozenset({"alice"}))
        self.registered = [{"username": "Alice"}]
        current = await community.top_players()
        self.assertEqual(len(current["blitz"]), 1)
        self.assertIsNone(current["blitz"][0]["username"])
        self.assertEqual(current["blitz"][0]["rating"], 2100)


if __name__ == "__main__":
    unittest.main()
