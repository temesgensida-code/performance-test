# Social Backend

A production-style social media API built with:

- **FastAPI**: HTTP API, validation, OpenAPI docs at `/docs`
- **PostgreSQL**: system of record (users, posts, follows, matches)
- **Redis**: cache-aside layer for profiles, feeds and match lists, plus locks
- **Celery**: background user matching and feed-cache fan-out, with Celery beat for periodic refreshes

## Architecture

```
            ┌──────────┐   read/write    ┌────────────┐
client ───► │ FastAPI  │ ──────────────► │ PostgreSQL │
            │  (api)   │                 └────────────┘
            │          │ ◄──────┐              ▲  ▲
            └──┬───┬───┘        │ cache        │  │ read/write
               │   │ enqueue    │              │  │
               │   ▼            ▼              │  │
               │ ┌────────┐ ┌────────┐         │  │
               │ │ broker │ │ cache  │         │  │
               │ │ Redis  │ │ Redis  │         │  │
               │ └────────┘ └────────┘         │  │
               │   ▲              ▲            │  │
               │   │ consume      │ invalidate │  │
               ▼   │              │            │  │
            ┌─────────────────────────────┐─────┘  │
            │ Celery worker  ·  Celery beat│────────┘
            └─────────────────────────────┘
```

Two Redis instances on purpose:

| Instance | Policy | Why |
|---|---|---|
| `cache` | `allkeys-lru` | Cached data is disposable; eviction just causes a DB read. |
| `broker` | `noeviction` + AOF | Evicting a queued task would silently lose work. |

## Running it

With Docker:

```bash
docker compose up --build
```

- API: http://localhost:8000 (docs at `/docs`)
- Health: `GET /health` reports database and Redis status

Locally (needs PostgreSQL and two Redis instances or one Redis for dev):

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload
celery -A app.celery_app:celery_app worker --loglevel=INFO   # in another terminal
celery -A app.celery_app:celery_app beat --loglevel=INFO     # in another terminal
```

Tests (pure unit tests, no infrastructure needed):

```bash
pytest
```

## Endpoints

All routes are under `/api/v1`.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | – | Create an account |
| POST | `/auth/login` | – | OAuth2 password form; returns a bearer token |
| GET | `/users/me` | ✔ | Current profile |
| PATCH | `/users/me` | ✔ | Update profile. Changing `interests` queues a match recomputation. |
| GET | `/users/{id}` | ✔ | Public profile (cached) |
| POST | `/users/{id}/follow` | ✔ | Follow a user |
| DELETE | `/users/{id}/follow` | ✔ | Unfollow |
| POST | `/posts` | ✔ | Create a post |
| GET | `/posts/{id}` | ✔ | Get a post |
| DELETE | `/posts/{id}` | ✔ | Delete your own post |
| GET | `/feed?page=&page_size=` | ✔ | Posts from you and people you follow (cached) |
| GET | `/matches` | ✔ | Your top matches, ranked by shared interests (cached) |
| POST | `/matches/refresh` | ✔ | Queue a recomputation; returns `202` with a `task_id` |
| GET | `/tasks/{task_id}` | ✔ | Poll a Celery task's status and result |

Example flow:

```bash
curl -X POST localhost:8000/api/v1/auth/register -H 'content-type: application/json' \
  -d '{"username":"alice","email":"alice@example.com","password":"supersecret","display_name":"Alice"}'

TOKEN=$(curl -s -X POST localhost:8000/api/v1/auth/login \
  -d 'username=alice&password=supersecret' | python -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

curl -X PATCH localhost:8000/api/v1/users/me -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"interests":["python","ml","rust"]}'
curl localhost:8000/api/v1/matches -H "authorization: Bearer $TOKEN"
```

## How matching works

1. A user's interests change (`PATCH /users/me`) or the beat schedule fires `refresh_all_matches`.
2. Each user gets a `compute_matches_for_user` task.
3. The task finds candidates with overlapping interests (a GIN index serves the `&&` query), scores them by **Jaccard similarity** (`|A∩B| / |A∪B|`), and keeps the top `MATCH_LIMIT`.
4. The user's match rows are replaced in one transaction, and the Redis `matches:{id}` key is deleted so the next read is fresh.
5. Similarity is symmetric, so the task also queues a refresh for everyone the user newly matches with or previously matched with. Those refreshes don't cascade further (`propagate=False`), which keeps the fan-out to one hop. The periodic beat job runs without propagation because it already covers every user.

Scoring lives in `app/services/matching.py` as a pure function, so it is easy to test and to swap for a better model later.

## How caching works

| Key | Filled by | Invalidated by |
|---|---|---|
| `user:{id}` | `GET /users/{id}` | `PATCH /users/me` |
| `matches:{id}` | `GET /matches` | match recomputation task |
| `feed:{id}:v{n}:p{page}:s{size}` | `GET /feed` | bumping `feedver:{id}`: on own post/delete, follow/unfollow, and (via Celery) follower fan-out |

Feed invalidation uses a version counter inside the key. Bumping one integer invalidates every cached page of that feed at once without scanning keys. Redis errors degrade to database reads rather than failing requests.

## Production notes and next steps

- **Migrations**: the app calls `create_all` at startup for convenience. For production, add Alembic and run `alembic upgrade head` as a deploy step.
- **Secrets**: set a real `JWT_SECRET`. The default is for development only.
- **Rate limiting**: add per-IP limits on `/auth/login` using Redis `INCR` with expiry.
- **Task ownership**: `GET /tasks/{id}` returns results to any authenticated user who knows the id (UUIDs are unguessable, but results are not scoped). Store the owner in task metadata and check it if results become sensitive.
- **Scale**: `refresh_all_matches` queues one task per user. At large scale, shard by user id range or compute matches incrementally when interests change.
- **Observability**: add structured logging, Prometheus metrics (e.g. `prometheus-fastapi-instrumentator`, Celery Flower), and tracing.
- **Integration tests**: add tests against real Postgres and Redis (e.g. with `testcontainers`).
