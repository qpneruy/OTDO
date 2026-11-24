function pad2(n) {
  return String(n).padStart(2, '0');
}

function sanitizeLimitMinutes(limitMinutes) {
  const n = Number(limitMinutes);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const intVal = Math.floor(n);
  return intVal >= 1 ? Math.min(600, intVal) : 0;
}

/**
 * Format duration in seconds as MM:SS, or HH:MM:SS when >= 3600 seconds.
 */
export function formatDuration(totalSeconds) {
  const safe = Number.isFinite(Number(totalSeconds))
    ? Math.max(0, Math.floor(Number(totalSeconds)))
    : 0;

  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;

  if (hours > 0) {
    return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  }
  return `${pad2(minutes)}:${pad2(seconds)}`;
}

/**
 * Determine timer status token from limitSeconds and elapsedSeconds.
 */
export function getTimerStatus({ limitSeconds = 0, elapsedSeconds = 0 } = {}) {
  const limit = Number.isFinite(Number(limitSeconds)) ? Number(limitSeconds) : 0;
  const elapsed = Number.isFinite(Number(elapsedSeconds)) ? Math.max(0, Number(elapsedSeconds)) : 0;

  if (limit <= 0) return 'stopwatch';

  const remaining = Math.max(0, limit - elapsed);
  if (remaining <= 0) return 'expired';
  if (remaining <= 60) return 'critical';

  const warningThreshold = Math.min(300, Math.max(60, Math.floor(limit * 0.2)));
  if (remaining <= warningThreshold) return 'warning';

  return 'normal';
}

/**
 * Create a drift-free quiz timer supporting stopwatch and countdown modes.
 */
export function createQuizTimer({ now = () => Date.now(), onTick, onExpire } = {}) {
  let limitSeconds = 0;
  let accumulatedMs = 0;
  let segmentStartMs = 0;
  let running = false;
  let paused = false;
  let expired = false;
  let destroyed = false;
  let intervalId = null;
  let lastEmitKey = null;

  function clearTicker() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function computeRawElapsedMs() {
    if (!running) return accumulatedMs;
    return accumulatedMs + Math.max(0, now() - segmentStartMs);
  }

  function buildSnapshot(forcedElapsedSeconds) {
    const mode = limitSeconds > 0 ? 'countdown' : 'stopwatch';
    let elapsedSeconds = typeof forcedElapsedSeconds === 'number'
      ? forcedElapsedSeconds
      : Math.max(0, Math.floor(computeRawElapsedMs() / 1000));

    if (limitSeconds > 0 && elapsedSeconds > limitSeconds) {
      elapsedSeconds = limitSeconds;
    }

    const remainingSeconds = limitSeconds > 0 ? Math.max(0, limitSeconds - elapsedSeconds) : null;
    const elapsedDisplay = formatDuration(elapsedSeconds);
    const display = mode === 'countdown' ? formatDuration(remainingSeconds) : elapsedDisplay;
    const status = getTimerStatus({ limitSeconds, elapsedSeconds });

    return {
      mode,
      limitSeconds,
      elapsedSeconds,
      remainingSeconds,
      display,
      elapsedDisplay,
      status,
      running,
      paused
    };
  }

  function emitIfChanged(snap) {
    const key = `${snap.elapsedSeconds}|${snap.paused}|${snap.running}|${snap.mode}|${snap.limitSeconds}|${snap.status}`;
    if (key === lastEmitKey) return;
    lastEmitKey = key;
    if (typeof onTick === 'function') {
      onTick(snap);
    }
  }

  function triggerExpire() {
    accumulatedMs = limitSeconds * 1000;
    running = false;
    paused = false;
    expired = true;
    clearTicker();
    const snap = buildSnapshot(limitSeconds);
    emitIfChanged(snap);
    if (typeof onExpire === 'function') {
      onExpire(snap);
    }
    return snap;
  }

  function tick() {
    if (destroyed || !running) return;
    const totalMs = computeRawElapsedMs();
    if (limitSeconds > 0 && totalMs >= limitSeconds * 1000) {
      triggerExpire();
      return;
    }
    const snap = buildSnapshot(Math.floor(totalMs / 1000));
    emitIfChanged(snap);
  }

  function startTicker() {
    clearTicker();
    intervalId = setInterval(tick, 250);
  }

  function start(limitMinutes = 0, { initialElapsedSeconds = 0 } = {}) {
    if (destroyed) return buildSnapshot();
    clearTicker();
    limitSeconds = sanitizeLimitMinutes(limitMinutes) * 60;
    const rawInitial = Number(initialElapsedSeconds);
    const safeInitial = Number.isFinite(rawInitial)
      ? Math.max(0, Math.floor(rawInitial))
      : 0;

    if (limitSeconds > 0 && safeInitial >= limitSeconds) {
      lastEmitKey = null;
      return triggerExpire();
    }

    accumulatedMs = safeInitial * 1000;
    segmentStartMs = now();
    running = true;
    paused = false;
    expired = false;
    lastEmitKey = null;
    startTicker();
    const snap = buildSnapshot(safeInitial);
    emitIfChanged(snap);
    return snap;
  }

  function pause() {
    if (destroyed || !running || paused) return buildSnapshot();
    accumulatedMs = computeRawElapsedMs();
    if (limitSeconds > 0 && accumulatedMs >= limitSeconds * 1000) {
      return triggerExpire();
    }
    running = false;
    paused = true;
    clearTicker();
    const snap = buildSnapshot();
    emitIfChanged(snap);
    return snap;
  }

  function resume() {
    if (destroyed || !paused || running || expired) return buildSnapshot();
    segmentStartMs = now();
    running = true;
    paused = false;
    startTicker();
    const snap = buildSnapshot();
    emitIfChanged(snap);
    return snap;
  }

  function togglePause() {
    if (paused) return resume();
    if (running) return pause();
    return buildSnapshot();
  }

  function setLimitMinutes(limitMinutes) {
    if (destroyed) return buildSnapshot();
    const wasRunning = running;
    const wasPaused = paused;
    clearTicker();

    limitSeconds = sanitizeLimitMinutes(limitMinutes) * 60;
    accumulatedMs = 0;
    expired = false;

    if (wasRunning) {
      segmentStartMs = now();
      running = true;
      paused = false;
      startTicker();
    } else if (wasPaused) {
      segmentStartMs = 0;
      running = false;
      paused = true;
    } else {
      segmentStartMs = 0;
      running = false;
      paused = false;
    }

    const snap = buildSnapshot(0);
    emitIfChanged(snap);
    return snap;
  }

  function stop() {
    if (destroyed) return buildSnapshot();
    if (running) {
      accumulatedMs = computeRawElapsedMs();
      if (limitSeconds > 0 && accumulatedMs > limitSeconds * 1000) {
        accumulatedMs = limitSeconds * 1000;
      }
    }
    running = false;
    paused = false;
    clearTicker();
    const snap = buildSnapshot();
    emitIfChanged(snap);
    return snap;
  }

  function getSnapshot() {
    return buildSnapshot();
  }

  function destroy() {
    if (destroyed) return;
    clearTicker();
    running = false;
    paused = false;
    destroyed = true;
  }

  return {
    start,
    pause,
    resume,
    togglePause,
    setLimitMinutes,
    stop,
    getSnapshot,
    destroy
  };
}
