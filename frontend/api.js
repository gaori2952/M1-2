export class ApiError extends Error {constructor(message,status){super(message);this.status=status;}}
export function createApi(getUser,notifySlow) {
  return async (path,{method='GET',body}={})=>{
    const user=getUser();
    if (!user) throw new ApiError('Google 로그인 후 이용해 주세요.',401);
    const token=await user.getIdToken();
    const controller=new AbortController();
    const slow=setTimeout(()=>notifySlow('첫 요청은 서버 시작으로 지연될 수 있어요. 잠시 기다려 주세요.'),8000);
    const timeout=setTimeout(()=>controller.abort(),115000);
    try {
      const res=await fetch(`${window.APP_CONFIG.apiBaseUrl}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});
      const data=res.status===204?null:await res.json();
      if(getUser()!==user) throw new ApiError('로그인이 변경되었습니다. 다시 시도하세요.',401);
      if(!res.ok) {
        const detail=Array.isArray(data?.detail)?data.detail.map(d=>`${d.loc.slice(1).join('.')}: ${d.msg}`).join('\n'):data?.detail;
        throw new ApiError(detail||'요청을 처리하지 못했어요.',res.status);
      }
      return data;
    } catch(error) {
      if(error.name==='AbortError') throw new ApiError('응답이 지연되고 있어요. 대화 기록을 확인하거나 같은 요청을 재시도하세요.',0);
      if(error instanceof TypeError) throw new ApiError('서버 연결에 실패했어요. 입력은 유지됩니다.',0);
      throw error;
    } finally {clearTimeout(slow);clearTimeout(timeout);}
  };
}
