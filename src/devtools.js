/**
 * Optional Chrome DevTools network debugging.
 *
 * `node-network-devtools` patches this process's `fetch` + http/https so every
 * outgoing request (e.g. the streaming `/chat/completions` call in llm.js) shows
 * up in a real Chrome DevTools "Network" tab, which it opens for us. It is off
 * by default: the patching adds a little overhead and is a dev-only concern.
 *
 * Enabled by either of:
 *   NETWORK_DEBUG=1         what `pnpm inspect` sets
 *   NODE_ENV=development
 *
 * It is imported dynamically so production installs without devDependencies
 * don't crash on the missing package.
 */
export function networkDebugEnabled() {
  return process.env.NETWORK_DEBUG === "1" || process.env.NODE_ENV === "development";
}

export async function registerNetworkDevtools() {
  if (!networkDebugEnabled()) return false;

  try {
    const { register } = await import("node-network-devtools");
    register();
    return true;
  } catch (err) {
    console.warn(`[devtools] network debugging disabled: ${err.message}`);
    return false;
  }
}
