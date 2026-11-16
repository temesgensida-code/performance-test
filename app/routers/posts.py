from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlalchemy import or_, select

from app.cache import bump_feed_versions, cache_get, cache_set, feed_page_key, get_feed_version
from app.config import settings
from app.deps import CurrentUser, DbSession
from app.models import Follow, Post
from app.schemas import FeedPage, PostCreate, PostPublic
from app.tasks import fanout_feed_invalidation

router = APIRouter(tags=["posts"])

PageParam = Annotated[int, Query(ge=1)]
PageSizeParam = Annotated[int, Query(ge=1, le=100)]


@router.post("/posts", response_model=PostPublic, status_code=status.HTTP_201_CREATED)
def create_post(payload: PostCreate, current: CurrentUser, db: DbSession) -> Post:
    post = Post(author_id=current.id, content=payload.content)
    db.add(post)
    db.commit()
    db.refresh(post)

    bump_feed_versions([current.id])          # author sees it immediately
    fanout_feed_invalidation.delay(current.id)  # followers are refreshed async
    return post


@router.get("/posts/{post_id}", response_model=PostPublic)
def get_post(post_id: int, _: CurrentUser, db: DbSession) -> Post:
    post = db.get(Post, post_id)
    if post is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Post not found")
    return post


@router.delete("/posts/{post_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_post(post_id: int, current: CurrentUser, db: DbSession) -> Response:
    post = db.get(Post, post_id)
    if post is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Post not found")
    if post.author_id != current.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only delete your own posts")

    db.delete(post)
    db.commit()
    bump_feed_versions([current.id])
    fanout_feed_invalidation.delay(current.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/feed", response_model=FeedPage)
def get_feed(
    current: CurrentUser,
    db: DbSession,
    page: PageParam = 1,
    page_size: PageSizeParam = 20,
) -> FeedPage:
    key = feed_page_key(current.id, get_feed_version(current.id), page, page_size)
    cached = cache_get(key)
    if cached is not None:
        return FeedPage(**cached)

    followee_ids = select(Follow.followee_id).where(Follow.follower_id == current.id)
    stmt = (
        select(Post)
        .where(or_(Post.author_id == current.id, Post.author_id.in_(followee_ids)))
        .order_by(Post.created_at.desc(), Post.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    posts = db.scalars(stmt).all()

    result = FeedPage(
        items=[PostPublic.model_validate(p) for p in posts],
        page=page,
        page_size=page_size,
    )
    cache_set(key, result.model_dump(mode="json"), settings.feed_cache_ttl_seconds)
    return result
