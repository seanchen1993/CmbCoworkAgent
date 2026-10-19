// Drain-local coordination only. Durable scheduler snapshots remain the authority.
function notifyDispatcherChange(dispatcherState) {
  dispatcherState.revision += 1;
  for (const wake of Array.from(dispatcherState.waiters)) wake("progress");
}

function waitForDispatcherChange(dispatcherState, observedRevision) {
  if (dispatcherState.closed) return Promise.resolve("closed");
  if (dispatcherState.revision !== observedRevision) return Promise.resolve("progress");
  return new Promise(resolve => {
    const wake = (reason) => {
      dispatcherState.waiters.delete(wake);
      clearTimeout(timer);
      resolve(dispatcherState.closed ? "closed" : reason);
    };
    const timer = setTimeout(() => wake("fallback"), DISPATCH_POLL_INTERVAL_MS);
    dispatcherState.waiters.add(wake);
  });
}

