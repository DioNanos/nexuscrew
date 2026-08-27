// Pure state transition used by GridTile. The ended transcript stays mounted
// while a tmux session is absent; exactly one new terminal/socket generation is
// created for each false -> true return, never for repeated poll samples.
export function nextTerminalGeneration(previousAlive, alive, generation) {
  return !previousAlive && alive ? generation + 1 : generation;
}

// A missing session list while the owning node is unhealthy is not evidence
// that the session ended: keep the current Terminal/socket mounted and let its
// own reconnect path handle the transport gap. A missing session on a healthy
// node remains authoritative and can trigger a fresh generation when it
// reappears.
export function sessionPresenceForTile({ tileKey, node, nodeGroups, sessionsAlive } = {}) {
  const group = node && Array.isArray(nodeGroups)
    ? nodeGroups.find((candidate) => Array.isArray(candidate?.route) && candidate.route.join('/') === node)
    : null;
  if (group && group.status !== 'up') return true;
  return !sessionsAlive || sessionsAlive.has(tileKey);
}
