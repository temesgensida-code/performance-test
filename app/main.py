import logging
from contextlib import asynccontextmanager

import redis
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app import models  # noqa: F401  (registers ORM models with Base.metadata)
from app.cache import redis_client
from app.config import settings
from app.database import Base, engine
from app.routers import auth, matches, posts, users

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Convenience for local development. In production, run `alembic upgrade head`
    # as a deploy step instead of creating tables at app startup.
    Base.metadata.create_all(bind=engine)
    yield
    engine.dispose()


app = FastAPI(
    title=settings.app_name,
    version="1.0.0",
    lifespan=lifespan,
)

API_PREFIX = "/api/v1"
for router in (auth.router, users.router, posts.router, matches.router):
    app.include_router(router, prefix=API_PREFIX)


@app.get("/health", tags=["ops"])
def health() -> JSONResponse:
    checks = {"database": "ok", "redis": "ok"}

    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:
        checks["database"] = "unavailable"

    try:
        redis_client.ping()
    except redis.RedisError:
        checks["redis"] = "unavailable"

    healthy = all(value == "ok" for value in checks.values())
    return JSONResponse(
        status_code=200 if healthy else 503,
        content={"status": "ok" if healthy else "degraded", "checks": checks},
    )
