// Configuration from environment variables.

function intFromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid ${name} value: "${raw}" (must be a non-negative integer)`);
  }
  return n;
}

export function loadConfig(env = process.env) {
  return {
    host: env.HOST || '0.0.0.0',
    port: intFromEnv(env, 'PORT', 8080),
    socketPath: env.SOCKET_PATH || '/tmp/iina-socket',
    token: env.TOKEN || null,
    requestTimeoutMs: intFromEnv(env, 'REQUEST_TIMEOUT_MS', 3000),
    sleepCommand: env.SLEEP_COMMAND || 'pmset sleepnow',
  };
}
