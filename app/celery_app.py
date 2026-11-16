from celery import Celery
from celery.signals import worker_process_init

from app.config import settings

celery_app = Celery(
    "social",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
    include=["app.tasks"],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    # Reliability: ack after the task finishes so a crashed worker's task is redelivered.
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    # Matching is CPU/DB heavy and tasks are short; don't let one worker hoard tasks.
    worker_prefetch_multiplier=1,
    task_track_started=True,
    result_expires=60 * 60,
    beat_schedule={
        "refresh-all-matches": {
            "task": "app.tasks.refresh_all_matches",
            "schedule": float(settings.match_refresh_minutes * 60),
        },
    },
)


@worker_process_init.connect
def _reset_db_pool_in_child(**_: object) -> None:
    # Connections must not be shared across forked worker processes.
    from app.database import engine

    engine.dispose()
