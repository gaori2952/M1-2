from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

bearer = HTTPBearer(auto_error=False)


def require_owner(
    request: Request, credential: HTTPAuthorizationCredentials | None = Depends(bearer)
):
    if not credential:
        raise HTTPException(401, "Google 로그인이 필요합니다.")
    try:
        decoded = request.app.state.verify_token(credential.credentials)
        uid = decoded["uid"]
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(401, "로그인이 만료되었거나 유효하지 않습니다.") from None
    if not uid or uid not in request.app.state.settings.allowed_user_uids:
        raise HTTPException(403, "등록된 사용자만 사용할 수 있습니다.")
    return uid
