"""Redis cache helpers.

Design notes:
- Cache-aside: readers populate keys on miss; writers delete or bump keys.
- Redis failures never break requests: reads fall back to the database and
  invalidations are logged and skipped.
- Feed caching uses a per-user version counter embedded in the key, so one
  INCR invalidates every cached page of that user's feed at once.
"""

import json
import logging
from collections.abc import Iterable
from typing import Any

import redis

from app.config import settings

logger = logging.getLogger(__name__)

redis_client = redis.Redis.from_url(
    settings.redis_url,
    decode_responses=True,
    socket_connect_timeout=2,
    socket_timeout=2,
)


# ---- key builders -----------------------------------------------------------

def user_key(user_id: int) -> str:
    return f"user:{user_id}"


def matches_key(user_id: int) -> str:
    return f"matches:{user_id}"


def feed_version_key(user_id: int) -> str:
    return f"feedver:{user_id}"


def feed_page_key(user_id: int, version: int, page: int, page_size: int) -> str:
    return f"feed:{user_id}:v{version}:p{page}:s{page_size}"


# ---- primitives -------------------------------------------------------------

def cache_get(key: str) -> Any | None:
    try:
        raw = redis_client.get(key)
    except redis.RedisError:
        logger.warning("cache read failed for %s", key, exc_info=True)
        return None
    return json.loads(raw) if raw is not None else None


def cache_set(key: str, value: Any, ttl: int) -> None:
    try:
        redis_client.set(key, json.dumps(value, default=str), ex=ttl)
    except redis.RedisError:
        logger.warning("cache write failed for %s", key, exc_info=True)


def cache_delete(*keys: str) -> None:
    if not keys:
        return
    try:
        redis_client.delete(*keys)
    except redis.RedisError:
        logger.warning("cache delete failed for %s", keys, exc_info=True)


def get_feed_version(user_id: int) -> int:
    try:
        value = redis_client.get(feed_version_key(user_id))
    except redis.RedisError:
        return 0
    return int(value) if value else 0


def bump_feed_versions(user_ids: Iterable[int]) -> None:
    ids = list(user_ids)
    if not ids:
        return
    try:
        pipe = redis_client.pipeline(transaction=False)
        for uid in ids:
            pipe.incr(feed_version_key(uid))
        pipe.execute()
    except redis.RedisError:
        logger.warning("feed version bump failed for %d users", len(ids), exc_info=True)


def acquire_lock(key: str, ttl_seconds: int) -> bool:
    """Best-effort lock. Fails open so a Redis outage doesn't block the API."""
    try:
        return bool(redis_client.set(key, "1", nx=True, ex=ttl_seconds))
    except redis.RedisError:
        logger.warning("lock acquisition failed for %s", key, exc_info=True)
        return True
