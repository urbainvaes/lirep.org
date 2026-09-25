import asyncio
import json
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from app import explorer, store


class ExplorerCacheTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        original_path = store.DB_PATH
        store.DB_PATH = Path(tmp.name) / "test.db"
        self.addCleanup(setattr, store, "DB_PATH", original_path)
        store.init_db()

    async def test_startup_removes_expired_entries(self) -> None:
        now = datetime.now(UTC)
        store.set_explorer_cache("old", {"moves": []}, (now - timedelta(days=2)).isoformat())
        store.set_explorer_cache("new", {"moves": []}, now.isoformat())
        store.init_db()
        with store._connect() as conn:
            keys = {row[0] for row in conn.execute("SELECT cache_key FROM explorer_cache")}
        self.assertEqual(keys, {"new"})

    async def test_writes_trigger_expiry_cleanup(self) -> None:
        now = datetime.now(UTC)
        with patch.object(store, "EXPLORER_CACHE_CLEANUP_WRITE_INTERVAL", 2):
            store.set_explorer_cache("old", {"moves": []}, (now - timedelta(days=2)).isoformat())
            store.set_explorer_cache("new", {"moves": []}, now.isoformat())
        with store._connect() as conn:
            keys = {row[0] for row in conn.execute("SELECT cache_key FROM explorer_cache")}
        self.assertEqual(keys, {"new"})

    async def test_size_limit_evicts_oldest_entries(self) -> None:
        now = datetime.now(UTC)
        response = {"moves": ["x" * 50]}
        row_size = len("key0") + len(json.dumps(response))
        with patch.object(store, "EXPLORER_CACHE_MAX_BYTES", row_size * 2):
            for i in range(3):
                store.set_explorer_cache(f"key{i}", response, (now - timedelta(hours=3 - i)).isoformat())
            store.prune_explorer_cache(now)
        with store._connect() as conn:
            keys = {row[0] for row in conn.execute("SELECT cache_key FROM explorer_cache")}
        self.assertEqual(keys, {"key1", "key2"})

    async def test_simultaneous_misses_share_one_fetch(self) -> None:
        calls = 0

        async def fetch(*_args):
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.02)
            return {"moves": [{"san": "e4"}]}

        with patch.object(explorer, "fetch_explorer", fetch):
            results = await asyncio.gather(*(
                explorer.fetch_explorer_cached(None, {}, "fen", "lichess", "lichess", 1600, "rapid")
                for _ in range(10)
            ))
            cached = await explorer.fetch_explorer_cached(None, {}, "fen", "lichess", "lichess", 1600, "rapid")
        self.assertEqual(calls, 1)
        self.assertTrue(all(result == results[0] for result in results))
        self.assertEqual(cached, results[0])

    async def test_failed_fetch_is_not_cached(self) -> None:
        calls = 0

        async def fail(*_args):
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.02)
            raise HTTPException(status_code=429, detail="rate limited")

        with patch.object(explorer, "fetch_explorer", fail):
            results = await asyncio.gather(*(
                explorer.fetch_explorer_cached(None, {}, "fen", "lichess", "lichess", 1600, "rapid")
                for _ in range(4)
            ), return_exceptions=True)
        self.assertEqual(calls, 1)
        self.assertTrue(all(isinstance(result, HTTPException) and result.status_code == 429 for result in results))

        async def succeed(*_args):
            return {"moves": []}

        with patch.object(explorer, "fetch_explorer", succeed):
            result = await explorer.fetch_explorer_cached(None, {}, "fen", "lichess", "lichess", 1600, "rapid")
        self.assertEqual(result[0], {"moves": []})

    async def test_cancelled_waiter_does_not_cancel_first_fetch(self) -> None:
        started = asyncio.Event()
        release = asyncio.Event()
        calls = 0

        async def fetch(*_args):
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return {"moves": []}

        with patch.object(explorer, "fetch_explorer", fetch):
            first = asyncio.create_task(
                explorer.fetch_explorer_cached(None, {}, "fen", "lichess", "lichess", 1600, "rapid")
            )
            await started.wait()
            second = asyncio.create_task(
                explorer.fetch_explorer_cached(None, {}, "fen", "lichess", "lichess", 1600, "rapid")
            )
            await asyncio.sleep(0)
            second.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await second
            release.set()
            self.assertEqual((await first)[0], {"moves": []})
        self.assertEqual(calls, 1)

    async def test_cancelled_owner_does_not_cancel_shared_fetch(self) -> None:
        started = asyncio.Event()
        calls = 0

        async def fetch(*_args):
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return {"moves": []}

        release = asyncio.Event()
        with patch.object(explorer, "fetch_explorer", fetch):
            first = asyncio.create_task(
                explorer.fetch_explorer_cached(None, {}, "fen", "lichess", "lichess", 1600, "rapid")
            )
            await started.wait()
            second = asyncio.create_task(
                explorer.fetch_explorer_cached(None, {}, "fen", "lichess", "lichess", 1600, "rapid")
            )
            await asyncio.sleep(0)
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
            release.set()
            self.assertEqual((await second)[0], {"moves": []})
        self.assertEqual(calls, 1)

    async def test_closed_initiator_client_retries_for_waiters(self) -> None:
        calls = 0

        class ClosedClient:
            is_closed = True
            timeout = 10

        class ReplacementClient:
            def __init__(self, *, timeout):
                self.timeout = timeout

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                pass

        origin = ClosedClient()

        async def fetch(client, *_args):
            nonlocal calls
            calls += 1
            if client is origin:
                await asyncio.sleep(0)
                raise RuntimeError("client closed")
            self.assertIsInstance(client, ReplacementClient)
            return {"moves": []}

        with patch.object(explorer, "fetch_explorer", fetch), patch.object(explorer.httpx, "AsyncClient", ReplacementClient):
            results = await asyncio.gather(*(
                explorer.fetch_explorer_cached(origin, {}, "fen", "lichess", "lichess", 1600, "rapid")
                for _ in range(3)
            ))
        self.assertEqual(calls, 2)
        self.assertTrue(all(result == results[0] for result in results))


if __name__ == "__main__":
    unittest.main()
