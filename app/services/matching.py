from collections.abc import Iterable


def jaccard(a: set[str], b: set[str]) -> float:
    """Similarity in [0, 1]: |A ∩ B| / |A ∪ B|."""
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def rank_matches(
    my_interests: list[str],
    candidates: Iterable[tuple[int, list[str]]],
    limit: int,
) -> list[tuple[int, float, list[str]]]:
    """Rank candidates by interest similarity.

    Returns (user_id, score, shared_interests) tuples, best first.
    Candidates with no shared interests are dropped. Ties break on user id
    so results are deterministic.
    """
    mine = set(my_interests)
    scored: list[tuple[int, float, list[str]]] = []
    for user_id, interests in candidates:
        other = set(interests)
        shared = mine & other
        if not shared:
            continue
        scored.append((user_id, round(jaccard(mine, other), 4), sorted(shared)))

    scored.sort(key=lambda item: (-item[1], item[0]))
    return scored[:limit]
