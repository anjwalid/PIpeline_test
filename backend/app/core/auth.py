import uuid
from dataclasses import dataclass
from functools import lru_cache
from typing import Annotated
from urllib.parse import urlsplit

import jwt
from fastapi import Depends, HTTPException, Request, status

from app.core.config import settings


@dataclass(frozen=True)
class AuthenticatedUser:
    user_id: uuid.UUID
    username: str
    email: str | None
    display_name: str
    roles: tuple[str, ...] = ()


def _unauthorized(detail: str = "Session Keycloak invalide ou expiree.") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
    )


def _forbidden(detail: str = "Vous n'etes pas autorise a effectuer cette action.") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=detail,
    )


def _normalize_issuer(value: str) -> str:
    return (value or "").strip().rstrip("/")


def _build_certs_url(issuer: str) -> str:
    normalized_issuer = _normalize_issuer(issuer)
    if not normalized_issuer:
        return ""
    return f"{normalized_issuer}/protocol/openid-connect/certs"


@lru_cache(maxsize=8)
def _jwks_client(certs_url: str) -> jwt.PyJWKClient:
    normalized_certs_url = (certs_url or "").strip().rstrip("/")
    if not normalized_certs_url:
        raise RuntimeError("KEYCLOAK_CERTS_URL manquant.")
    return jwt.PyJWKClient(normalized_certs_url)


def _read_unverified_issuer(token: str) -> str:
    try:
        payload = jwt.decode(
            token,
            options={
                "verify_signature": False,
                "verify_exp": False,
                "verify_nbf": False,
                "verify_iat": False,
                "verify_aud": False,
                "verify_iss": False,
            },
        )
    except Exception:
        return ""

    return _normalize_issuer(str(payload.get("iss") or ""))


def _same_origin(left: str, right: str) -> bool:
    if not left or not right:
        return False

    left_parts = urlsplit(left)
    right_parts = urlsplit(right)
    return (
        left_parts.scheme.lower(),
        left_parts.netloc.lower(),
    ) == (
        right_parts.scheme.lower(),
        right_parts.netloc.lower(),
    )


def _verification_candidates(token: str) -> list[tuple[str, str]]:
    configured_issuer = _normalize_issuer(settings.KEYCLOAK_ISSUER)
    configured_certs_url = (settings.KEYCLOAK_CERTS_URL or "").strip().rstrip("/")
    token_issuer = _read_unverified_issuer(token)

    candidates: list[tuple[str, str]] = []

    if token_issuer:
        allow_token_issuer = (
            not settings.KEYCLOAK_ISSUER_EXPLICIT
            or token_issuer == configured_issuer
            or _same_origin(token_issuer, settings.KEYCLOAK_URL)
        )
        if allow_token_issuer:
            token_certs_url = (
                configured_certs_url
                if settings.KEYCLOAK_CERTS_URL_EXPLICIT and token_issuer == configured_issuer
                else _build_certs_url(token_issuer)
            )
            candidates.append((token_issuer, token_certs_url))

    if configured_issuer:
        candidates.append((configured_issuer, configured_certs_url or _build_certs_url(configured_issuer)))

    deduped_candidates: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        deduped_candidates.append(candidate)

    return deduped_candidates


def _decode_and_verify_jwt(token: str) -> dict:
    last_jwt_error: jwt.PyJWTError | None = None
    last_error: Exception | None = None
    payload: dict | None = None

    for issuer, certs_url in _verification_candidates(token):
        try:
            signing_key = _jwks_client(certs_url).get_signing_key_from_jwt(token)
            payload = jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"],
                issuer=issuer,
                options={
                    "require": ["exp", "iat", "iss", "sub"],
                    "verify_aud": False,
                },
                leeway=settings.KEYCLOAK_JWT_LEEWAY_SECONDS,
            )
            break
        except jwt.PyJWTError as exc:
            last_jwt_error = exc
        except Exception as exc:
            last_error = exc

    if payload is None:
        if last_jwt_error is not None:
            raise _unauthorized("Token Keycloak invalide ou signature non verifiee.") from last_jwt_error
        if last_error is not None:
            raise _unauthorized("Impossible de verifier le token Keycloak.") from last_error
        raise _unauthorized("Configuration Keycloak incomplete.")

    expected_audience = settings.KEYCLOAK_AUDIENCE
    if expected_audience:
        raw_audience = payload.get("aud")
        audiences: set[str] = set()

        if isinstance(raw_audience, str) and raw_audience.strip():
            audiences.add(raw_audience.strip())
        elif isinstance(raw_audience, list):
            audiences.update(str(item).strip() for item in raw_audience if str(item).strip())

        azp = str(payload.get("azp") or "").strip()
        if azp:
            audiences.add(azp)

        if expected_audience not in audiences:
            raise _unauthorized("Audience Keycloak non autorisee.")

    return payload


def _coerce_user_uuid(raw_value: str) -> uuid.UUID:
    candidate = (raw_value or "").strip()
    if not candidate:
        return uuid.uuid5(uuid.NAMESPACE_URL, "anonymous")

    try:
        return uuid.UUID(candidate)
    except ValueError:
        return uuid.uuid5(uuid.NAMESPACE_URL, candidate)


def _extract_roles(payload: dict) -> tuple[str, ...]:
    roles: list[str] = []

    realm_roles = payload.get("realm_access", {}).get("roles") or []
    if isinstance(realm_roles, list):
        roles.extend(str(role).strip() for role in realm_roles if str(role).strip())

    resource_access = payload.get("resource_access") or {}
    if isinstance(resource_access, dict):
        for access in resource_access.values():
            resource_roles = (access or {}).get("roles") or []
            if isinstance(resource_roles, list):
                roles.extend(str(role).strip() for role in resource_roles if str(role).strip())

    return tuple(dict.fromkeys(roles))


def get_optional_current_user(request: Request) -> AuthenticatedUser | None:
    authorization = request.headers.get("Authorization", "").strip()
    if not authorization:
        return None

    if not authorization.lower().startswith("bearer "):
        raise _unauthorized("Authorization Bearer attendue.")

    token = authorization[7:].strip()
    if not token:
        raise _unauthorized("Token Bearer manquant.")

    payload = _decode_and_verify_jwt(token)

    preferred_username = str(payload.get("preferred_username") or "").strip()
    name = str(payload.get("name") or "").strip()
    email = str(payload.get("email") or "").strip() or None

    display_name = name or preferred_username or email or "Utilisateur"
    username = preferred_username or name or (email or "utilisateur")

    return AuthenticatedUser(
        user_id=_coerce_user_uuid(str(payload.get("sub") or username)),
        username=username,
        email=email,
        display_name=display_name,
        roles=_extract_roles(payload),
    )


def get_current_user(request: Request) -> AuthenticatedUser:
    user = get_optional_current_user(request)
    if user is None:
        raise _unauthorized("Session Keycloak requise.")
    return user


def user_has_role(user: AuthenticatedUser, role: str) -> bool:
    return role in user.roles


def user_has_any_role(user: AuthenticatedUser, *roles: str) -> bool:
    return any(role in user.roles for role in roles)


def get_admin_user(
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
) -> AuthenticatedUser:
    if not user_has_role(current_user, "admin"):
        raise _forbidden()
    return current_user
