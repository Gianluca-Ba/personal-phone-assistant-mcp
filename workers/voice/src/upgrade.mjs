// A handshake deadline must not remain armed for the upgraded socket's lifetime.
export async function fetchSocketUpgrade(
  fetcher,
  input,
  init,
  timeoutMs = 10000,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
