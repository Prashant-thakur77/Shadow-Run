"""Small signed-token auth. Two public demo logins, so approver and requester can really differ.

Maker-checker here is by identity: whoever requested a run cannot approve it. The judge and reviewer
accounts have no other difference, and the demo does not model approver roles.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time

from fastapi import Cookie, Header, HTTPException

from control import settings

COOKIE = "sr_session"


def users() -> dict[str, dict]:
    return {
        "judge": {"password": os.environ.get("SHADOWRUN_JUDGE_PASSWORD", ""), "role": "member", "name": "Judge"},
        "reviewer": {"password": os.environ.get("SHADOWRUN_REVIEWER_PASSWORD", ""), "role": "member", "name": "Reviewer"},
        "admin": {"password": os.environ.get("SHADOWRUN_ADMIN_PASSWORD", ""), "role": "admin", "name": "Admin"},
    }


def _key() -> bytes:
    return settings.require_secret("SHADOWRUN_HMAC_SECRET", settings.HMAC_SECRET).encode() + b"|session"


def issue(username: str, ttl: int = settings.SESSION_TTL_S) -> str:
    body = base64.urlsafe_b64encode(json.dumps({"u": username, "exp": int(time.time()) + ttl}).encode()).decode().rstrip("=")
    mac = hmac.new(_key(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{mac}"


def verify_token(token: str) -> str | None:
    try:
        body, mac = token.rsplit(".", 1)
        if not hmac.compare_digest(hmac.new(_key(), body.encode(), hashlib.sha256).hexdigest(), mac):
            return None
        data = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except (ValueError, TypeError):
        return None
    if data["exp"] < time.time() or data["u"] not in users():
        return None
    return data["u"]


def check_password(username: str, password: str) -> bool:
    u = users().get(username)
    return bool(u and u["password"] and hmac.compare_digest(u["password"], password))


def current_user(authorization: str = Header(default=""), sr_session: str = Cookie(default="")) -> str:
    token = authorization[7:] if authorization.startswith("Bearer ") else sr_session
    user = verify_token(token) if token else None
    if not user:
        raise HTTPException(401, "not signed in")
    return user
