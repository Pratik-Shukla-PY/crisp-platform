"""
Auth Dependencies - FastAPI Depends() for JWT validation and RBAC.
Zero-trust: every protected endpoint validates token + role.
"""
import logging
from typing import Optional
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.core.security import decode_token
from app.models.auth import User, RoleEnum
from jwt import PyJWTError as JWTError  # May 2026: jose → PyJWT (CVE closure)

logger = logging.getLogger(__name__)

# OAuth2 scheme - extracts Bearer token from Authorization header
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=True)
oauth2_scheme_optional = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    """Extract and validate JWT, return authenticated User or raise 401."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = decode_token(token)
        user_id: str = payload.get("sub")
        token_type: str = payload.get("type")
        if user_id is None or token_type != "access":
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    user = db.query(User).filter(User.id == user_id, User.is_active == True).first()
    if user is None:
        raise credentials_exception
    return user


async def get_optional_user(
    token: Optional[str] = Depends(oauth2_scheme_optional),
    db: Session = Depends(get_db),
) -> Optional[User]:
    """Return User if valid token present, None if anonymous. Never raises 401."""
    if not token:
        return None
    try:
        payload = decode_token(token)
        user_id = payload.get("sub")
        if not user_id or payload.get("type") != "access":
            return None
        return db.query(User).filter(User.id == user_id, User.is_active == True).first()
    except JWTError:
        return None


def require_role(*allowed_roles: str):
    """Factory: returns a dependency that checks user.role is in allowed_roles."""
    async def _check_role(user: User = Depends(get_current_user)):
        if user.role not in [r if isinstance(r, str) else r.value for r in allowed_roles]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Insufficient permissions. Required: {', '.join(str(r) for r in allowed_roles)}",
            )
        return user
    return _check_role


# ── Convenience shortcuts ─────────────────────────────────────────────────────

require_viewer = require_role(
    RoleEnum.VIEWER, RoleEnum.ANALYST, RoleEnum.ADMIN, RoleEnum.SUPER_ADMIN
)

require_analyst = require_role(
    RoleEnum.ANALYST, RoleEnum.ADMIN, RoleEnum.SUPER_ADMIN
)

require_admin = require_role(
    RoleEnum.ADMIN, RoleEnum.SUPER_ADMIN
)

require_super_admin = require_role(RoleEnum.SUPER_ADMIN)
