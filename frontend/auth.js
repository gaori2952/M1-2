export async function connectAuth(callback) {
  const config = window.APP_CONFIG?.firebase;
  if (!config?.apiKey || !config?.authDomain || !config?.projectId)
    throw new Error(
      "Firebase 웹 설정이 필요합니다. README의 연결 단계를 확인하세요.",
    );
  const [
    { initializeApp },
    {
      getAuth,
      GoogleAuthProvider,
      onAuthStateChanged,
      signInWithPopup,
      signOut,
    },
  ] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js"),
  ]);
  const auth = getAuth(initializeApp(config));
  onAuthStateChanged(auth, callback);
  return {
    login: () => signInWithPopup(auth, new GoogleAuthProvider()),
    logout: () => signOut(auth),
  };
}
