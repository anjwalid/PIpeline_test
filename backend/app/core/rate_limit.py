from __future__ import annotations

from collections import defaultdict, deque
from threading import Lock
from time import monotonic
from typing import Callable

from fastapi import Depends, HTTPException, Request, status

from app.core.auth import AuthenticatedUser, get_optional_current_user


class InMemoryRateLimiter:
    def __init__(self) -> None:
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def hit(self, key: str, limit: int, window_seconds: int) -> None:
        now = monotonic()
        cutoff = now - window_seconds

        with self._lock:
            events = self._events[key]
            while events and events[0] <= cutoff:
                events.popleft()

            if len(events) >= limit:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="Trop de requetes sur cette operation. Merci de reessayer plus tard.",
                )

            events.append(now)


rate_limiter = InMemoryRateLimiter()


def _extract_client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("X-Forwarded-For", "").strip()
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def _build_key(prefix: str, request: Request, current_user: AuthenticatedUser | None) -> str:
    if current_user is not None:
        return f"{prefix}:user:{current_user.user_id}"
    return f"{prefix}:ip:{_extract_client_ip(request)}"


def build_rate_limit_dependency(
    *,
    prefix: str,
    limit: int,
    window_seconds: int,
) -> Callable[..., None]:
    def dependency(
        request: Request,
        current_user: AuthenticatedUser | None = Depends(get_optional_current_user),
    ) -> None:
        key = _build_key(prefix, request, current_user)
        rate_limiter.hit(key, limit=limit, window_seconds=window_seconds)

    return dependency
