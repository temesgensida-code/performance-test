from celery.result import AsyncResult
from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from app.cache import acquire_lock, cache_get, cache_set, matches_key
from app.celery_app import celery_app
from app.config import settings
from app.deps import CurrentUser, DbSession
from app.models import User, UserMatch
from app.schemas import MatchPublic, TaskQueued, TaskStatusPublic, UserPublic
from app.tasks import compute_matches_for_user

router = APIRouter(tags=["matches"])


@router.get("/matches", response_model=list[MatchPublic])
def list_matches(current: CurrentUser, db: DbSession) -> list[MatchPublic]:
    key = matches_key(current.id)
    cached = cache_get(key)
    if cached is not None:
        return [MatchPublic(**item) for item in cached]

    rows = db.execute(
        select(UserMatch, User)
        .join(User, User.id == UserMatch.matched_user_id)
        .where(UserMatch.user_id == current.id, User.is_active.is_(True))
        .order_by(UserMatch.score.desc(), UserMatch.id)
        .limit(settings.match_limit)
    ).all()

    matches = [
        MatchPublic(
            user=UserPublic.model_validate(user),
            score=match.score,
            shared_interests=match.shared_interests,
        )
        for match, user in rows
    ]
    cache_set(key, [m.model_dump(mode="json") for m in matches], settings.cache_ttl_seconds)
    return matches


@router.post(
    "/matches/refresh",
    response_model=TaskQueued,
    status_code=status.HTTP_202_ACCEPTED,
)
def refresh_matches(current: CurrentUser) -> TaskQueued:
    # Redis lock: at most one refresh per user per minute.
    if not acquire_lock(f"lock:match-refresh:{current.id}", ttl_seconds=60):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "A match refresh was requested recently; try again in a minute",
        )
    task = compute_matches_for_user.delay(current.id)
    return TaskQueued(task_id=task.id, status="queued")


@router.get("/tasks/{task_id}", response_model=TaskStatusPublic)
def get_task_status(task_id: str, _: CurrentUser) -> TaskStatusPublic:
    result = AsyncResult(task_id, app=celery_app)
    body = TaskStatusPublic(task_id=task_id, status=result.status)
    if result.successful():
        body.result = result.result
    elif result.failed():
        body.error = "Task failed"
    return body
