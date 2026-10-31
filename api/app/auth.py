"""Signed-in users: verify Firebase ID tokens sent as `Authorization: Bearer <token>`.

Users sign in with email + password and a code from an authenticator app (TOTP). The API only
accepts tokens from a sign-in that used that second factor, so a stolen password alone can't
reach anyone's data, and an account can't be used until its authenticator is set up.

With `FIREBASE_AUTH_EMULATOR_HOST` set (local development), firebase-admin accepts the Auth
emulator's unsigned tokens, so no Firebase project or credentials are needed. The emulator can't
do authenticator codes, so local runs against it set DASHBOARDER_REQUIRE_SECOND_FACTOR=false.
"""

import logging
import re
from collections.abc import Callable
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, Header, HTTPException

from app.config import get_settings

logger = logging.getLogger("dashboarder.auth")

# Firebase UIDs are short alphanumeric strings. Checking the shape also keeps a UID from building
# storage paths outside the user's prefix.
UID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

# Token -> its decoded claims. Raises on an invalid, expired, or revoked token.
TokenVerifier = Callable[[str], dict]


@lru_cache
def _firebase_verifier() -> TokenVerifier:
    import firebase_admin
    from firebase_admin import auth

    project_id = get_settings().firebase_project_id
    try:
        app = firebase_admin.get_app()
    except ValueError:
        app = firebase_admin.initialize_app(options={"projectId": project_id})

    def verify(token: str) -> dict:
        return auth.verify_id_token(token, app=app)

    return verify


def get_token_verifier() -> TokenVerifier:
    """Overridden in tests."""
    if not get_settings().firebase_project_id:
        raise HTTPException(503, "sign-in is not configured on this server")
    return _firebase_verifier()


def current_user(
    verify: Annotated[TokenVerifier, Depends(get_token_verifier)],
    authorization: Annotated[str | None, Header()] = None,
) -> str:
    """The signed-in user's UID, taken only from a verified token that used a second factor."""
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(401, "sign in required", headers={"WWW-Authenticate": "Bearer"})
    try:
        claims = verify(token)
    except Exception as exc:  # any verification failure: expired, revoked, malformed
        logger.info("token rejected: %s", type(exc).__name__)
        raise HTTPException(401, "invalid or expired sign-in",
                            headers={"WWW-Authenticate": "Bearer"}) from exc
    uid = claims.get("uid", "")
    if not UID_PATTERN.fullmatch(uid):
        raise HTTPException(401, "invalid user id")
    second_factor = (claims.get("firebase") or {}).get("sign_in_second_factor")
    if get_settings().require_second_factor and not second_factor:
        raise HTTPException(403, "set up an authenticator app and sign in with a code")
    return uid
