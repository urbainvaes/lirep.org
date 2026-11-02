import copy
import unittest
from unittest.mock import patch

from starlette.requests import Request

from app import community
from app.stats import EVAL_METHOD


class CommunityFreshnessTests(unittest.TestCase):
    def setUp(self):
        self.study = {
            "id": 1, "name": "Test", "side": "white", "startNodeId": None,
            "movesFingerprint": "current",
            "tree": {"rootId": 0, "nodes": {
                "0": {"san": None, "parentId": None, "children": [1]},
                "1": {"san": "e4", "parentId": 0, "children": []},
            }},
            "explorerSettings": {"source": "lichess", "database": "lichess"},
            "stats": {
                "winProbability": 0.6, "winProbabilityMovesFingerprint": "current",
                "evalCp": 30, "evalMovesFingerprint": "current", "evalDepth": 12,
                "evalMethod": EVAL_METHOD,
                "evalSettings": {"source": "lichess", "database": "lichess", "minRating": None, "speeds": []},
            },
        }

    def test_current_metrics_rank(self):
        self.assertEqual(community._entry("alice", self.study, None)["winProbability"], 0.6)
        self.assertEqual(community._eval_entry("alice", self.study, None, "lichess")["evalCp"], 30)

    def test_stale_and_legacy_metrics_do_not_rank_but_keep_labeled_values(self):
        for fingerprint in ("old", None):
            with self.subTest(fingerprint=fingerprint):
                study = copy.deepcopy(self.study)
                for key in ("winProbabilityMovesFingerprint", "evalMovesFingerprint"):
                    if fingerprint is None:
                        study["stats"].pop(key)
                    else:
                        study["stats"][key] = fingerprint
                entry = community._entry("alice", study, None)
                self.assertIsNone(entry["winProbability"])
                self.assertTrue(entry["reason"])
                self.assertIsNone(community._eval_entry("alice", study, None, "lichess"))
                self.assertEqual(entry["badge"]["winProbability"], 0.6)
                self.assertEqual(entry["badge"]["evalCp"], 30)
                self.assertTrue(entry["badge"]["scoreFreshnessReason"])
                self.assertTrue(entry["badge"]["evalFreshnessReason"])
                profile = community._entry("alice", study, None, any_source=True)
                self.assertEqual(profile["winProbability"], 0.6)
                self.assertTrue(profile["reason"])

    def test_metrics_have_independent_freshness(self):
        self.study["stats"]["evalMovesFingerprint"] = "old"
        self.assertEqual(community._entry("alice", self.study, None)["winProbability"], 0.6)
        self.assertIsNone(community._eval_entry("alice", self.study, None, "lichess"))
        self.study["stats"]["evalMovesFingerprint"] = "current"
        self.study["stats"]["winProbabilityMovesFingerprint"] = "old"
        self.assertIsNone(community._entry("alice", self.study, None)["winProbability"])
        self.assertIsNotNone(community._eval_entry("alice", self.study, None, "lichess"))

    def test_leaderboards_and_counts_exclude_stale_results_for_both_sources(self):
        request = Request({"type": "http", "session": {}})
        self.study["movesFingerprint"] = "edited"
        for source in ("lichess", "lirep"):
            with self.subTest(source=source):
                self.study["explorerSettings"]["source"] = source
                self.study["stats"]["evalSettings"]["source"] = source
                with (
                    patch.object(community.store, "list_shared_studies", return_value=[("alice", self.study)]),
                    patch.object(community.store, "community_counts", return_value={}),
                    patch.object(community, "_names", return_value=community._Names()),
                ):
                    self.assertEqual(community.openings(request, source), [])
                    self.assertEqual(community.openings_by_eval(request, source), [])
                    counts = community.summary()
                    self.assertEqual(counts["rankedOpenings"], 0)
                    self.assertEqual(counts["lirepOpenings"], 0)


if __name__ == "__main__":
    unittest.main()


class SharedGamesTests(unittest.TestCase):
    """A shared opening's games are shown to everyone; under a hidden name
    (anonymous, or a pen name), not those the author played, whose PGN
    would give the name away."""

    names = community._Names(frozenset({"hidden"}), {"penned": "Pen"})

    @staticmethod
    def game(id, white, black, section=""):
        pgn = f'[Event "?"]\n[White "{white}"]\n[Black "{black}"]\n[Result "*"]\n\n1. e4 *'
        return {"id": id, "section": section, "pgn": pgn, "comment": ""}

    def games(self, owner):
        return {
            "sections": ["Mine", "Masters"],
            "games": [
                self.game(1, "Carlsen, M.", "Grischuk, A.", "Masters"),
                self.game(2, owner.upper(), "someone", "Mine"),
                self.game(3, "someone", owner, "Mine"),
            ],
        }

    def shown(self, owner, me=None):
        request = Request({"type": "http", "session": {"username": me} if me else {}})
        with patch.object(community, "_names", return_value=self.names), \
                patch.object(community.store, "get_study_games", return_value=self.games(owner)), \
                patch.object(community.store, "get_shared_study", return_value=(owner, {})):
            return community.shared_study_games(1, request)

    def test_games_shown_to_others_under_own_name(self):
        self.assertEqual(self.shown("alice"), self.games("alice"))

    def test_hidden_names_games_shown_without_the_authors_own(self):
        for owner in ("hidden", "penned"):
            with self.subTest(owner=owner):
                self.assertEqual(self.shown(owner), {"sections": ["Masters"], "games": [self.games(owner)["games"][0]]})

    def test_hidden_author_sees_all_their_games(self):
        self.assertEqual(self.shown("hidden", "Hidden"), self.games("hidden"))

    def test_card_counts_the_games_shown(self):
        tree = {"rootId": 0, "nodes": {"0": {"id": 0, "san": None, "parentId": None, "children": []}}}
        study = {"id": 1, "tree": tree, "startNodeId": None, "gameCount": 3, "side": "white"}
        with patch.object(community.store, "get_study_games", return_value=self.games("hidden")):
            self.assertEqual(community._card_fields(study, "hidden", None, self.names)["games"], 1)
            self.assertEqual(community._card_fields(study, "alice", None, self.names)["games"], 3)
