from app.services.matching import jaccard, rank_matches


def test_jaccard_basic_cases():
    assert jaccard({"a", "b"}, {"b", "c"}) == 1 / 3
    assert jaccard(set(), {"a"}) == 0.0


def test_ranks_by_similarity_and_drops_non_overlapping_users():
    mine = ["python", "ml", "rust"]
    candidates = [
        (2, ["python", "ml"]),          # 2 / 3
        (3, ["go"]),                    # no overlap -> dropped
        (4, ["python", "rust", "ml", "web"]),  # 3 / 4
    ]
    ranked = rank_matches(mine, candidates, limit=10)
    assert [uid for uid, _, _ in ranked] == [4, 2]
    assert ranked[0][2] == ["ml", "python", "rust"]


def test_limit_is_respected():
    mine = ["x"]
    candidates = [(i, ["x"]) for i in range(1, 10)]
    assert len(rank_matches(mine, candidates, limit=3)) == 3


def test_ties_break_on_user_id_for_determinism():
    mine = ["x"]
    ranked = rank_matches(mine, [(9, ["x"]), (5, ["x"])], limit=10)
    assert [uid for uid, _, _ in ranked] == [5, 9]
