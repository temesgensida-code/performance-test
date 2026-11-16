from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import delete
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.cache import bump_feed_versions, cache_delete, cache_get, cache_set, user_key
from app.config import settings
from app.deps import CurrentUser, DbSession
from app.models import Follow, User
from app.schemas import UserPublic, UserUpdate
from app.tasks import compute_matches_for_user

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/me", response_model=UserPublic)
def read_me(current: CurrentUser) -> User:
    return current


@router.patch("/me", response_model=UserPublic)
def update_me(payload: UserUpdate, current: CurrentUser, db: DbSession) -> User:
    changes = payload.model_dump(exclude_unset=True)
    # display_name and interests are NOT NULL, so an explicit null means "no change".
    for required in ("display_name", "interests"):
        if required in changes and changes[required] is None:
            del changes[required]

    interests_changed = "interests" in changes and changes["interests"] != current.interests
    for field, value in changes.items():
        setattr(current, field, value)
    db.commit()
    db.refresh(current)

    cache_delete(user_key(current.id))
    if interests_changed:
        # Matching is expensive, so it runs in a worker instead of the request.
        compute_matches_for_user.delay(current.id)
    return current


@router.get("/{user_id}", response_model=UserPublic)
def get_user(user_id: int, _: CurrentUser, db: DbSession) -> UserPublic:
    cached = cache_get(user_key(user_id))
    if cached is not None:
        return UserPublic(**cached)

    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")

    profile = UserPublic.model_validate(user)
    cache_set(user_key(user_id), profile.model_dump(mode="json"), settings.cache_ttl_seconds)
    return profile


@router.post("/{user_id}/follow", status_code=status.HTTP_204_NO_CONTENT)
def follow_user(user_id: int, current: CurrentUser, db: DbSession) -> Response:
    if user_id == current.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You cannot follow yourself")
    target = db.get(User, user_id)
    if target is None or not target.is_active:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")

    db.execute(
        pg_insert(Follow)
        .values(follower_id=current.id, followee_id=user_id)
        .on_conflict_do_nothing()
    )
    db.commit()
    bump_feed_versions([current.id])  # my feed now includes their posts
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/{user_id}/follow", status_code=status.HTTP_204_NO_CONTENT)
def unfollow_user(user_id: int, current: CurrentUser, db: DbSession) -> Response:
    db.execute(
        delete(Follow).where(Follow.follower_id == current.id, Follow.followee_id == user_id)
    )
    db.commit()
    bump_feed_versions([current.id])
    return Response(status_code=status.HTTP_204_NO_CONTENT)
