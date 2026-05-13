import asyncio
import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.dependencies import get_current_user, require_auth
from app.core.security import create_access_token, hash_password, verify_password
from app.database.session import get_db
from app.models.password_reset_token import PasswordResetToken
from app.models.user import User
from app.schemas.auth import (
    ForgotPasswordRequest,
    LoginRequest,
    RegisterRequest,
    ResetPasswordRequest,
    UserResponse,
)
from app.services import odoo_mail
from app.utils.geo import country_from_request

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Password reset helpers ────────────────────────────────────────────────

def _hash_token(plaintext: str) -> str:
    """SHA-256 hex of the token. Cheap one-shot hash (collision-free in
    practice for 32-byte URL-safe inputs); we don't need bcrypt here
    because the input itself is high-entropy random."""
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _ensure_aware(value: datetime) -> datetime:
    """SQLite (default DB) round-trips datetimes as naive — tag them UTC
    so comparisons with `_now_utc()` don't raise."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _set_auth_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key="access_token",
        value=token,
        httponly=True,
        samesite="lax",
        max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        secure=settings.COOKIE_SECURE,
    )


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def register(
    body: RegisterRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    # Check uniqueness
    existing = await db.execute(
        select(User).where((User.email == body.email) | (User.username == body.username))
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email or username already taken.")

    country = country_from_request(request)
    user = User(
        username=body.username,
        email=body.email,
        hashed_password=hash_password(body.password),
        signup_country=country,
        last_country=country,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    token = create_access_token({"sub": user.id})
    _set_auth_cookie(response, token)

    # Synchronously upsert the Odoo partner BEFORE firing the async
    # welcome. This serializes partner creation at the Velxio HTTP
    # layer so a subsequent forgot-password (or any other mail) lands
    # on a partner whose existence is already committed — sidestepping
    # the REPEATABLE-READ snapshot race two parallel mail workers
    # would otherwise hit. `sync_partner` swallows its own errors and
    # returns None if Odoo is down, so the user is never blocked.
    await odoo_mail.sync_partner(
        velxio_user_id=user.id,
        email=user.email,
        name=user.username,
        country_code=user.signup_country or None,
    )

    asyncio.create_task(
        odoo_mail.send_welcome(
            velxio_user_id=user.id,
            email=user.email,
            name=user.username,
            country_code=user.signup_country or None,
            editor_url=f"{settings.FRONTEND_URL.rstrip('/')}/editor",
            examples_url=f"{settings.FRONTEND_URL.rstrip('/')}/examples",
        )
    )

    return user


@router.post("/login", response_model=UserResponse)
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(User.email == body.email))
    user = result.scalar_one_or_none()
    if not user or not user.hashed_password or not verify_password(body.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid credentials.")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account is disabled.")

    country = country_from_request(request)
    if country:
        user.last_country = country
        await db.commit()

    token = create_access_token({"sub": user.id})
    _set_auth_cookie(response, token)
    return user


@router.get("/me", response_model=UserResponse)
async def me(user: User = Depends(get_current_user)):
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated.")
    return user


@router.post("/logout")
async def logout(response: Response, _user: User = Depends(require_auth)):
    response.delete_cookie("access_token")
    return {"message": "Logged out."}


# ── Password reset flow ───────────────────────────────────────────────────

_GENERIC_FORGOT_REPLY = {
    "message": "If that email is registered, a reset link is on its way.",
}


@router.post("/forgot-password")
async def forgot_password(
    body: ForgotPasswordRequest,
    db: AsyncSession = Depends(get_db),
):
    """Send a password-reset email if the address is registered.

    Always returns 200 with the same generic message so a stranger can't
    enumerate which emails belong to Velxio accounts. Rate-limited: at
    most N=PASSWORD_RESET_RATE_LIMIT_PER_HOUR fresh tokens per user per
    rolling hour. Excess attempts succeed silently (same generic 200) but
    do NOT generate a token or email.

    Tokens are 32-byte URL-safe random strings; only their SHA-256 hash
    is persisted. The plaintext only leaves the server inside the reset
    URL emailed via Odoo.
    """
    email = body.email.lower()
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        # Anti-enumeration: identical response shape and roughly identical
        # latency. We don't sleep to fake the per-user code path — the
        # bcrypt + token round-trips below are dominated by Odoo's
        # network call, which only fires for real users anyway.
        return _GENERIC_FORGOT_REPLY

    # Rate-limit: count tokens minted in the last hour for this user.
    window_start = _now_utc() - timedelta(hours=1)
    count_result = await db.execute(
        select(func.count(PasswordResetToken.id)).where(
            PasswordResetToken.user_id == user.id,
            PasswordResetToken.created_at >= window_start,
        )
    )
    recent = count_result.scalar_one() or 0
    if recent >= settings.PASSWORD_RESET_RATE_LIMIT_PER_HOUR:
        logger.warning(
            "[forgot-password] rate-limited user=%s email=%s recent=%s",
            user.id, email, recent,
        )
        return _GENERIC_FORGOT_REPLY

    # Mint a fresh one-time token; store only the hash.
    plaintext = secrets.token_urlsafe(32)
    token_row = PasswordResetToken(
        user_id=user.id,
        token_hash=_hash_token(plaintext),
        expires_at=_now_utc() + timedelta(
            minutes=settings.PASSWORD_RESET_TOKEN_TTL_MINUTES,
        ),
    )
    db.add(token_row)
    await db.commit()

    reset_url = (
        f"{settings.FRONTEND_URL.rstrip('/')}/reset-password?token={plaintext}"
    )
    # Same trick as register: ensure the Odoo partner exists synchronously
    # before firing the async reset mail. Cheap (~50ms) and removes the
    # REPEATABLE-READ snapshot race entirely.
    await odoo_mail.sync_partner(
        velxio_user_id=user.id,
        email=user.email,
        name=user.username,
        country_code=user.signup_country or None,
    )

    asyncio.create_task(
        odoo_mail.send_password_reset(
            email=user.email,
            reset_url=reset_url,
            expires_in_minutes=settings.PASSWORD_RESET_TOKEN_TTL_MINUTES,
            user_name=user.username,
            velxio_user_id=user.id,
        )
    )
    logger.info("[forgot-password] token minted user=%s", user.id)
    return _GENERIC_FORGOT_REPLY


@router.post("/reset-password")
async def reset_password(
    body: ResetPasswordRequest,
    db: AsyncSession = Depends(get_db),
):
    """Consume a one-time token and set the user's new password.

    Returns 400 for: token unknown, expired, or already used. We don't
    distinguish those cases in the response — keeps probing useless — but
    the server log records the exact reason.
    """
    token_hash = _hash_token(body.token)
    result = await db.execute(
        select(PasswordResetToken).where(PasswordResetToken.token_hash == token_hash)
    )
    token_row = result.scalar_one_or_none()
    if not token_row:
        logger.info("[reset-password] unknown token hash=%s", token_hash[:8])
        raise HTTPException(status_code=400, detail="Reset link is invalid or has expired.")

    expires_at = _ensure_aware(token_row.expires_at)
    if expires_at < _now_utc():
        logger.info("[reset-password] expired token id=%s", token_row.id)
        raise HTTPException(status_code=400, detail="Reset link is invalid or has expired.")
    if token_row.used_at is not None:
        logger.info("[reset-password] reused token id=%s", token_row.id)
        raise HTTPException(status_code=400, detail="Reset link is invalid or has expired.")

    user_result = await db.execute(select(User).where(User.id == token_row.user_id))
    user = user_result.scalar_one_or_none()
    if not user or not user.is_active:
        raise HTTPException(status_code=400, detail="Reset link is invalid or has expired.")

    user.hashed_password = hash_password(body.new_password)
    token_row.used_at = _now_utc()
    await db.commit()
    logger.info("[reset-password] consumed token id=%s user=%s", token_row.id, user.id)
    return {"message": "Password has been reset. You can now sign in with your new password."}


# ── Google OAuth ──────────────────────────────────────────────────────────────

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"


@router.get("/google")
async def google_login():
    if not settings.GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=501, detail="Google OAuth not configured.")
    params = {
        "client_id": settings.GOOGLE_CLIENT_ID,
        "redirect_uri": settings.GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "access_type": "offline",
    }
    from urllib.parse import urlencode
    url = f"{GOOGLE_AUTH_URL}?{urlencode(params)}"
    return RedirectResponse(url)


@router.get("/google/callback")
async def google_callback(
    code: str,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    if not settings.GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=501, detail="Google OAuth not configured.")

    async with httpx.AsyncClient() as client:
        token_resp = await client.post(
            GOOGLE_TOKEN_URL,
            data={
                "code": code,
                "client_id": settings.GOOGLE_CLIENT_ID,
                "client_secret": settings.GOOGLE_CLIENT_SECRET,
                "redirect_uri": settings.GOOGLE_REDIRECT_URI,
                "grant_type": "authorization_code",
            },
        )
        token_resp.raise_for_status()
        access_token = token_resp.json()["access_token"]

        userinfo_resp = await client.get(
            GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {access_token}"},
        )
        userinfo_resp.raise_for_status()
        userinfo = userinfo_resp.json()

    google_id: str = userinfo["sub"]
    email: str = userinfo.get("email", "")
    avatar_url: str | None = userinfo.get("picture")
    country = country_from_request(request)

    # Upsert user by google_id
    result = await db.execute(select(User).where(User.google_id == google_id))
    user = result.scalar_one_or_none()

    if not user:
        # Try to find by email (link accounts)
        result2 = await db.execute(select(User).where(User.email == email))
        user = result2.scalar_one_or_none()
        if user:
            user.google_id = google_id
            if avatar_url and not user.avatar_url:
                user.avatar_url = avatar_url
        else:
            # Generate username from email prefix
            base_username = email.split("@")[0].lower()
            import re
            base_username = re.sub(r"[^a-z0-9_-]", "-", base_username)[:28]
            username = base_username
            counter = 1
            while True:
                existing = await db.execute(select(User).where(User.username == username))
                if not existing.scalar_one_or_none():
                    break
                username = f"{base_username}{counter}"
                counter += 1

            user = User(
                username=username,
                email=email,
                google_id=google_id,
                avatar_url=avatar_url,
                signup_country=country,
                last_country=country,
            )
            db.add(user)

    if country:
        user.last_country = country

    await db.commit()
    await db.refresh(user)

    jwt_token = create_access_token({"sub": user.id}, expires_delta=timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES))
    # Send the user straight to the editor after OAuth login
    redirect = RedirectResponse(url=f"{settings.FRONTEND_URL}/editor")
    _set_auth_cookie(redirect, jwt_token)
    return redirect
