const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function createHealthToken(byteLength = 32, prefix = "ph_") {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("browser นี้ไม่รองรับ crypto.getRandomValues");
  }

  const length = Math.min(128, Math.max(16, Math.trunc(byteLength) || 32));
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);

  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const chunk =
      (bytes[index] << 16) |
      ((remaining > 1 ? bytes[index + 1] : 0) << 8) |
      (remaining > 2 ? bytes[index + 2] : 0);

    encoded += TOKEN_ALPHABET[(chunk >> 18) & 63];
    encoded += TOKEN_ALPHABET[(chunk >> 12) & 63];
    if (remaining > 1) encoded += TOKEN_ALPHABET[(chunk >> 6) & 63];
    if (remaining > 2) encoded += TOKEN_ALPHABET[chunk & 63];
  }

  return `${prefix}${encoded}`;
}

export function buildAgentCommands(
  token,
  bootstrapUrl = "https://pc-health-dashboard.apichat-p-1989.workers.dev/agent/bootstrap.ps1",
) {
  const prefix = `$bootstrap = irm ${bootstrapUrl}; & ([scriptblock]::Create($bootstrap))`;
  return {
    install: `${prefix} -Token ${token}`,
    reinstall: `${prefix} -Force -Token ${token}`,
  };
}
