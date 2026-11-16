from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

USERNAME_PATTERN = r"^[a-zA-Z0-9_]{3,30}$"


def normalize_interests(values: list[str]) -> list[str]:
    """Lowercase, trim, drop blanks and duplicates, preserve order."""
    cleaned: list[str] = []
    seen: set[str] = set()
    for raw in values:
        term = raw.strip().lower()
        if not term:
            continue
        if len(term) > 50:
            raise ValueError("each interest must be 50 characters or fewer")
        if term not in seen:
            seen.add(term)
            cleaned.append(term)
    return cleaned


# ---- users / auth -----------------------------------------------------------

class UserCreate(BaseModel):
    username: str = Field(pattern=USERNAME_PATTERN)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(min_length=1, max_length=100)


class UserUpdate(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=100)
    bio: str | None = Field(default=None, max_length=500)
    interests: list[str] | None = Field(default=None, max_length=20)

    @field_validator("interests")
    @classmethod
    def _clean_interests(cls, value: list[str] | None) -> list[str] | None:
        return None if value is None else normalize_interests(value)


class UserPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    display_name: str
    bio: str | None
    interests: list[str]
    created_at: datetime


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


# ---- posts / feed -----------------------------------------------------------

class PostCreate(BaseModel):
    content: str = Field(min_length=1, max_length=2000)


class PostPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    author_id: int
    content: str
    created_at: datetime


class FeedPage(BaseModel):
    items: list[PostPublic]
    page: int
    page_size: int


# ---- matches / tasks --------------------------------------------------------

class MatchPublic(BaseModel):
    user: UserPublic
    score: float
    shared_interests: list[str]


class TaskQueued(BaseModel):
    task_id: str
    status: str


class TaskStatusPublic(BaseModel):
    task_id: str
    status: str
    result: dict | None = None
    error: str | None = None
