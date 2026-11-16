from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "Social API"
    environment: str = "development"

    # PostgreSQL (psycopg v3 driver)
    database_url: str = "postgresql+psycopg://social:social@localhost:5432/social"

    # Redis cache (evictable; used only for cache-aside data and short-lived locks)
    redis_url: str = "redis://localhost:6379/0"
    cache_ttl_seconds: int = 300
    feed_cache_ttl_seconds: int = 60

    # Celery broker/result backend (should NOT be evicted, so keep it on its own Redis)
    celery_broker_url: str = "redis://localhost:6379/1"
    celery_result_backend: str = "redis://localhost:6379/2"

    # Auth
    jwt_secret: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60

    # Matching
    match_limit: int = 20
    match_refresh_minutes: int = 15


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
