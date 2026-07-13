// Pure state transition used by GridTile. The ended transcript stays mounted
// while a tmux session is absent; exactly one new terminal/socket generation is
// created for each false -> true return, never for repeated poll samples.
export function nextTerminalGeneration(previousAlive, alive, generation) {
  return !previousAlive && alive ? generation + 1 : generation;
}
