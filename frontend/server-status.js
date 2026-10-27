export function mountServerStatus(root) {
  const title = root.querySelector("#server-status-title");
  const elapsed = root.querySelector("#server-elapsed");
  const estimate = root.querySelector("#server-estimate");
  const retry = root.querySelector("#server-retry");
  let generation = 0,
    active = false,
    started = 0,
    failures = 0;
  let ticker, nextProbe, controller;

  function stop() {
    clearInterval(ticker);
    clearTimeout(nextProbe);
    controller?.abort();
  }
  function tick() {
    const seconds = Math.floor((performance.now() - started) / 1000);
    elapsed.textContent = `${seconds}초 경과`;
    if (seconds >= 90) {
      active = false;
      stop();
      root.dataset.state = "delayed";
      title.textContent = "서버 연결이 지연되고 있어요";
      estimate.textContent =
        "예상 대기 범위를 초과했어요. 잠시 후 다시 연결해 주세요.";
      retry.hidden = false;
    } else {
      estimate.textContent = `예상 남은 대기 약 ${Math.max(0, 30 - seconds)}~${90 - seconds}초 · 일반적인 준비 시간 기준`;
    }
  }
  async function probe(version) {
    const current = new AbortController();
    controller = current;
    const timeout = setTimeout(() => current.abort(), 15000);
    try {
      const response = await fetch(`${window.APP_CONFIG.apiBaseUrl}/health`, {
        signal: current.signal,
        cache: "no-store",
        credentials: "omit",
        headers: { Accept: "application/json" },
      });
      const data = await response.json();
      if (version !== generation || !active) return;
      if (response.ok && data?.status === "ok") {
        active = false;
        stop();
        root.hidden = true;
        return;
      }
    } catch {
      // Retry only this public readiness check, never a user's data or AI request.
    } finally {
      clearTimeout(timeout);
    }
    if (version !== generation || !active) return;
    failures += 1;
    nextProbe = setTimeout(
      () => probe(version),
      Math.min(failures * 5000, 15000),
    );
  }
  function start() {
    generation += 1;
    stop();
    active = true;
    started = performance.now();
    failures = 0;
    root.hidden = false;
    root.dataset.state = "checking";
    title.textContent = "서버 연결을 준비하고 있어요";
    retry.hidden = true;
    tick();
    ticker = setInterval(tick, 1000);
    probe(generation);
  }
  retry.addEventListener("click", start);
  start();
}
