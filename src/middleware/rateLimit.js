// Rate limiter en memoria con ventana fija. Suficiente para una sola instancia del servidor;
// con varias instancias haría falta un almacén compartido (p. ej. Redis).
function createRateLimiter({ windowMs, max, keyGenerator = (req) => req.ip, message }) {
  const hits = new Map();

  const limiter = (req, res, next) => {
    const now = Date.now();
    const key = keyGenerator(req);
    let entry = hits.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;

    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: message });
    }

    return next();
  };

  // Limpieza periódica de entradas vencidas; unref() para no impedir que el proceso termine.
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now >= entry.resetAt) hits.delete(key);
    }
  }, windowMs);
  cleanup.unref();

  return limiter;
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

// Login: por IP + correo, para frenar fuerza bruta sobre una cuenta concreta.
const loginLimiter = createRateLimiter({
  windowMs: FIFTEEN_MINUTES,
  max: 10,
  keyGenerator: (req) => {
    const correo = typeof req.body?.correo === 'string' ? req.body.correo.trim().toLowerCase() : '';
    return `${req.ip}|${correo}`;
  },
  message: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en unos minutos.',
});

const registerLimiter = createRateLimiter({
  windowMs: ONE_HOUR,
  max: 10,
  message: 'Demasiados registros desde esta conexión. Intenta más tarde.',
});

module.exports = { createRateLimiter, loginLimiter, registerLimiter };
