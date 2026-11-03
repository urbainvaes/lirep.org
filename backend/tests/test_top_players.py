import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from starlette.requests import Request

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


class ProfileRatingsTests(unittest.IsolatedAsyncioTestCase):
    """A public profile's ratings, from the same kept Lichess data."""

    async def asyncSetUp(self):
        self.names = community._Names()
        self.fetch = AsyncMock(return_value=[
            {"username": "Alice", "title": "GM", "perfs": {
                "blitz": {"rating": 2199, "games": 10},
                "rapid": {"rating": 1850, "games": 3, "prov": True},
                "classical": {"rating": 1500, "games": 0},
            }},
        ])
        user = {"number": 1, "username": "Alice", "joined": "2026-01-01 00:00:00", "anonymous": False}
        patches = [
            patch.object(community, "_top_players", None),
            patch.object(community, "_top_players_at", 0),
            patch.object(community, "_top_players_lock", asyncio.Lock()),
            patch.object(community, "_fetch_lichess_users", self.fetch),
            patch.object(community.store, "list_users", return_value=[{"username": "Alice"}]),
            patch.object(community.store, "get_user", return_value=user),
            patch.object(community.store, "list_shared_studies", return_value=[]),
            patch.object(community, "_names", side_effect=lambda: self.names),
        ]
        for mocked in patches:
            mocked.start()
            self.addCleanup(mocked.stop)

    async def profile(self, username="Alice", me=None):
        request = Request({"type": "http", "session": {"username": me} if me else {}})
        return await community.player(username, request)

    async def test_exact_ratings_and_title_under_the_real_name(self):
        data = await self.profile()
        self.assertEqual(data["title"], "GM")
        self.assertEqual(data["ratings"], {
            "blitz": {"rating": 2199, "games": 10, "provisional": False, "roundedDown": False},
            "rapid": {"rating": 1850, "games": 3, "provisional": True, "roundedDown": False},
        })
        await self.profile()
        self.fetch.assert_awaited_once()

    async def test_rounded_without_games_or_title_under_a_pen_name(self):
        self.names = community._Names(aliases={"alice": "Pen name"})
        data = await self.profile("Pen name")
        self.assertIsNone(data["title"])
        self.assertEqual(data["ratings"]["blitz"], {"rating": 2100, "games": None, "provisional": False, "roundedDown": True})
        mine = await self.profile("Pen name", me="Alice")
        self.assertEqual(mine["ratings"]["blitz"]["rating"], 2199)

    async def test_no_ratings_for_a_closed_account_or_without_lichess(self):
        self.fetch.return_value[0]["disabled"] = True
        self.assertIsNone((await self.profile())["ratings"])
        community._top_players, community._top_players_at = None, 0
        self.fetch.side_effect = httpx.ConnectError("offline")
        data = await self.profile()
        self.assertIsNone(data["ratings"])
        self.assertEqual(data["username"], "Alice")


if __name__ == "__main__":
    unittest.main()
