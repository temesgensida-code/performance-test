from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError

from app.deps import DbSession
from app.models import User
from app.schemas import Token, UserCreate, UserPublic
from app.security import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=UserPublic, status_code=status.HTTP_201_CREATED)
def register(payload: UserCreate, db: DbSession) -> User:
    user = User(
        username=payload.username.lower(),
        email=payload.email.lower(),
        hashed_password=hash_password(payload.password),
        display_name=payload.display_name,
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        # Relying on the unique constraint avoids a check-then-insert race.
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Username or email already registered")
    db.refresh(user)
    return user


@router.post("/login", response_model=Token)
def login(db: DbSession, form: OAuth2PasswordRequestForm = Depends()) -> Token:
    identifier = form.username.strip().lower()
    user = db.scalar(
        select(User).where(or_(User.username == identifier, User.email == identifier))
    )
    if user is None or not verify_password(form.password, user.hashed_password) or not user.is_active:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Invalid credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return Token(access_token=create_access_token(user.id))
