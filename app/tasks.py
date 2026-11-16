"""Celery tasks: user matching and feed cache invalidation fan-out."""

import logging
from datetime import datetime, timezone

from sqlalchemy import delete, func, insert, select
from sqlalchemy.exc import OperationalError

from app.cache import bump_feed_versions, cache_delete, matches_key
from app.celery_app import celery_app
from app.config import settings
from app.database import SessionLocal
from app.models import Follow, User, UserMatch
from app.services.matching import rank_matches

logger = logging.getLogger(__name__)

CANDIDATE_LIMIT = 2000  # cap per-user work on very popular interests
BATCH_SIZE = 500

RETRYABLE = {"autoretry_for": (OperationalError,), "retry_backoff": True, "max_retries": 3}


@celery_app.task(name="app.tasks.compute_matches_for_user", **RETRYABLE)
def compute_matches_for_user(user_id: int, propagate: bool = True) -> dict:
    """Recompute the top match suggestions for one user and replace the old ones.

    Similarity is symmetric, so when `propagate` is True we also queue a refresh for
    everyone whose list might now include (or no longer include) this user. The
    propagated refreshes pass propagate=False, which keeps the fan-out to one hop.
    """
    ranked: list[tuple[int, float, list[str]]] = []

    with SessionLocal() as db:
        previous_ids = set(
            db.scalars(select(UserMatch.matched_user_id).where(UserMatch.user_id == user_id))
        )
        me = db.get(User, user_id)
        if me is not None and me.is_active and me.interests:
            candidate_rows = db.execute(
                select(User.id, User.interests)
                .where(
                    User.id != user_id,
                    User.is_active.is_(True),
                    User.interests.overlap(me.interests),  # uses the GIN index
                )
                .limit(CANDIDATE_LIMIT)
            ).all()
            ranked = rank_matches(
                me.interests,
                [(row.id, row.interests) for row in candidate_rows],
                settings.match_limit,
            )

        # Replace the set atomically so readers never see a half-written list.
        now = datetime.now(timezone.utc)
        db.execute(delete(UserMatch).where(UserMatch.user_id == user_id))
        if ranked:
            db.execute(
                insert(UserMatch),
                [
                    {
                        "user_id": user_id,
                        "matched_user_id": matched_id,
                        "score": score,
                        "shared_interests": shared,
                        "computed_at": now,
                    }
                    for matched_id, score, shared in ranked
                ],
            )
        db.commit()

    cache_delete(matches_key(user_id))
    logger.info("computed %d matches for user %s", len(ranked), user_id)

    if propagate:
        affected = previous_ids | {matched_id for matched_id, _, _ in ranked}
        for other_id in affected:
            cache_delete(matches_key(other_id))
            compute_matches_for_user.delay(other_id, propagate=False)

    return {"user_id": user_id, "matches": len(ranked), "notified": len(affected) if propagate else 0}


@celery_app.task(name="app.tasks.refresh_all_matches")
def refresh_all_matches() -> int:
    """Periodic (Celery beat) job: queue a recomputation for every user with interests."""
    dispatched = 0
    last_id = 0
    with SessionLocal() as db:
        while True:
            ids = list(
                db.scalars(
                    select(User.id)
                    .where(
                        User.id > last_id,
                        User.is_active.is_(True),
                        func.cardinality(User.interests) > 0,
                    )
                    .order_by(User.id)
                    .limit(BATCH_SIZE)
                )
            )
            if not ids:
                break
            for uid in ids:
                # propagate=False: this job already covers every user, so don't fan out again.
                compute_matches_for_user.delay(uid, propagate=False)
            dispatched += len(ids)
            last_id = ids[-1]
    logger.info("queued match refresh for %d users", dispatched)
    return dispatched


@celery_app.task(name="app.tasks.fanout_feed_invalidation", **RETRYABLE)
def fanout_feed_invalidation(author_id: int) -> int:
    """After an author posts or deletes, invalidate every follower's cached feed."""
    with SessionLocal() as db:
        follower_ids = list(
            db.scalars(select(Follow.follower_id).where(Follow.followee_id == author_id))
        )
    for start in range(0, len(follower_ids), BATCH_SIZE):
        bump_feed_versions(follower_ids[start : start + BATCH_SIZE])
    return len(follower_ids)
