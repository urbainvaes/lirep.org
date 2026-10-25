import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

from app import store, studies
from app.study_tree import InvalidTree, MAX_TREE_DEPTH, MAX_TREE_NODES, validate_tree


def tree(moves=None):
    return json.loads(json.dumps(store._tree_from_moves(moves or ["e4", "e5", "Nf3"])))


def disconnected_cycle():
    return {"rootId": 0, "nextId": 3, "nodes": {
        "0": {"id": 0, "san": None, "parentId": None, "children": []},
        "1": {"id": 1, "san": "e4", "parentId": 2, "children": [2]},
        "2": {"id": 2, "san": "e5", "parentId": 1, "children": [1]},
    }}


class TreeValidationTests(unittest.TestCase):
    def test_legal_tree_and_opponent_variations(self):
        valid = tree()
        valid["nodes"]["4"] = {"id": 4, "san": "c5", "parentId": 1, "children": []}
        valid["nodes"]["1"]["children"].append(4)
        valid["nextId"] = 5
        validate_tree(valid, "white")
        # Node IDs need not match traversal order, and root need not be zero.
        renamed = copy.deepcopy(valid)
        renamed["rootId"] = 9
        renamed["nextId"] = 10
        renamed["nodes"]["9"] = renamed["nodes"].pop("0")
        renamed["nodes"]["9"]["id"] = 9
        renamed["nodes"]["1"]["parentId"] = 9
        validate_tree(renamed, "white")

    def test_bad_shapes_and_references_are_controlled_errors(self):
        mutations = [
            lambda t: t["nodes"].update({"1": []}),
            lambda t: t["nodes"]["0"].pop("parentId"),
            lambda t: t["nodes"]["0"].pop("san"),
            lambda t: t["nodes"]["0"].update(children=[1, 1]),
            lambda t: t["nodes"]["0"].update(children=[True]),
            lambda t: t.update(rootId=False),
            lambda t: t.update(nextId=1),
            lambda t: t["nodes"]["1"].update(parentId=99),
            lambda t: t["nodes"]["0"].update(children=[99]),
            lambda t: t["nodes"]["1"].update(children=[0]),
            lambda t: t["nodes"]["1"].update(san="e5"),
            lambda t: t["nodes"]["1"].update(san="--"),
        ]
        for mutation in mutations:
            invalid = tree()
            mutation(invalid)
            with self.subTest(tree=invalid), self.assertRaises(InvalidTree):
                validate_tree(invalid, "white")

    def test_disconnected_cycles_rejected_before_fingerprinting(self):
        invalid = disconnected_cycle()
        with self.assertRaisesRegex(InvalidTree, "unreachable"):
            validate_tree(invalid, "white")
        with self.assertRaises(InvalidTree):
            store.moves_fingerprint(invalid, 1)

    def test_only_one_prepared_side_move_for_either_side(self):
        invalid = tree(["e4"])
        invalid["nodes"]["2"] = {"id": 2, "san": "d4", "parentId": 0, "children": []}
        invalid["nodes"]["0"]["children"].append(2)
        invalid["nextId"] = 3
        with self.assertRaisesRegex(InvalidTree, "prepared-side"):
            validate_tree(invalid, "white")
        validate_tree(invalid, "black")
        invalid = tree(["e4", "e5"])
        invalid["nodes"]["3"] = {"id": 3, "san": "c5", "parentId": 1, "children": []}
        invalid["nodes"]["1"]["children"].append(3)
        invalid["nextId"] = 4
        with self.assertRaisesRegex(InvalidTree, "prepared-side"):
            validate_tree(invalid, "black")

    def test_size_and_depth_are_bounded(self):
        oversized = {"rootId": 0, "nextId": MAX_TREE_NODES + 1, "nodes": dict.fromkeys(map(str, range(MAX_TREE_NODES + 1)), {})}
        with self.assertRaises(InvalidTree):
            validate_tree(oversized, "white")
        moves = (["Nf3", "Nf6", "Ng1", "Ng8"] * (MAX_TREE_DEPTH // 4 + 1))
        at_limit = tree(moves[:MAX_TREE_DEPTH])
        validate_tree(at_limit, "white")
        self.assertEqual(len(store.moves_fingerprint(at_limit, MAX_TREE_DEPTH)), 16)
        with self.assertRaisesRegex(InvalidTree, "depth"):
            validate_tree(tree(moves[:MAX_TREE_DEPTH + 1]), "white")

    def test_fingerprint_remains_compatible(self):
        # The serialization format must not change for existing valid results.
        import hashlib
        expected = hashlib.sha256(b"(e4(e5(Nf3())))|").hexdigest()[:16]
        self.assertEqual(store.moves_fingerprint(tree(), None), expected)


class TreePersistenceTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        db = patch.object(store, "DB_PATH", Path(directory.name) / "test.db")
        db.start()
        self.addCleanup(db.stop)
        store.init_db()
        self.request = Request({"type": "http", "session": {"username": "alice"}})

    def test_invalid_creates_and_updates_do_not_persist(self):
        invalid = disconnected_cycle()
        with self.assertRaises(HTTPException) as error:
            studies.create_study(studies.StudyIn(name="Bad", tree=invalid, startNodeId=1), self.request)
        self.assertEqual(error.exception.status_code, 400)
        self.assertEqual(store.list_studies("alice"), [])
        valid = studies.create_study(studies.StudyIn(name="Good", tree=tree()), self.request)
        with self.assertRaises(HTTPException) as error:
            studies.update_study(valid["id"], studies.StudyIn(name="Bad", tree=invalid), self.request)
        self.assertEqual(error.exception.status_code, 400)
        self.assertEqual(store.get_study("alice", valid["id"]), valid)
        # Store callers cannot bypass validation either.
        with self.assertRaises(InvalidTree):
            store.update_study("alice", valid["id"], "Bad", invalid, {}, "white")
        self.assertEqual(store.get_study("alice", valid["id"]), valid)

    def test_update_validates_the_stored_side_not_the_submitted_side(self):
        valid = studies.create_study(studies.StudyIn(name="Black", tree=tree(["e4"]), side="black"), self.request)
        branches = tree(["e4", "e5"])
        branches["nodes"]["3"] = {"id": 3, "san": "c5", "parentId": 1, "children": []}
        branches["nodes"]["1"]["children"].append(3)
        branches["nextId"] = 4
        with self.assertRaises(HTTPException):
            studies.update_study(valid["id"], studies.StudyIn(name="Black", tree=branches, side="white"), self.request)

    def test_bad_legacy_rows_are_preserved_but_do_not_break_other_studies(self):
        good = store.create_study("alice", "Good", tree(), {}, "white")
        bad = store.create_study("alice", "Bad", tree(), {}, "white")
        for malformed in (json.dumps(disconnected_cycle()), '{"nodes":'):
            with self.subTest(malformed=malformed):
                with store._connect() as conn:
                    conn.execute("UPDATE studies SET tree = ?, start_node_id = 1 WHERE id = ?", (malformed, bad["id"]))
                with self.assertLogs("app.store", level="WARNING"):
                    self.assertIsNone(store.get_study("alice", bad["id"]))
                    self.assertIsNone(store.get_shared_study(bad["id"]))
                    self.assertEqual([s["id"] for s in store.list_studies("alice")], [good["id"]])
                    self.assertEqual([s["id"] for _, s in store.list_shared_studies()], [good["id"]])
                    self.assertIsNone(store.duplicate_study("alice", bad["id"], "Copy"))
                with store._connect() as conn:
                    self.assertEqual(conn.execute("SELECT tree FROM studies WHERE id = ?", (bad["id"],)).fetchone()["tree"], malformed)


if __name__ == "__main__":
    unittest.main()
