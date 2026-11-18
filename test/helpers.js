// Utilidades de test: sustituyen el pool de PostgreSQL por uno falso (sin BD real)
// y levantan la app en un puerto libre para hacer peticiones HTTP con fetch.
const path = require('node:path');
const jwt = require('jsonwebtoken');

const TEST_SECRET = 'test-secret-que-tiene-mas-de-32-caracteres-ok';
process.env.JWT_SECRET = TEST_SECRET;
process.env.NODE_ENV = 'test';

// Pool falso: cada consulta se resuelve con el primer handler cuyo patrón coincida con el SQL.
function createFakePool() {
  const handlers = [];
  const calls = [];

  return {
    calls,
    when(pattern, handler) {
      handlers.push({ pattern, handler });
      return this;
    },
    reset() {
      handlers.length = 0;
      calls.length = 0;
    },
    async query(sql, params = []) {
      calls.push({ sql, params });
      const match = handlers.find(({ pattern }) => pattern.test(sql));
      if (!match) throw new Error(`Consulta no esperada en el test: ${sql}`);
      const result = typeof match.handler === 'function' ? await match.handler(params, sql) : match.handler;
      return { rowCount: result.rows ? result.rows.length : 0, ...result };
    },
    on() {},
    end: async () => {},
  };
}

// Debe llamarse ANTES de requerir la app, para que todos los módulos reciban el pool falso.
function installFakePool() {
  const fakePool = createFakePool();
  const dbModulePath = path.resolve(__dirname, '../src/config/database.js');
  require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: fakePool };
  return fakePool;
}

async function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

async function request(baseUrl, method, urlPath, { body, token, rawBody, origin } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

const signToken = (payload, options = {}, secret = TEST_SECRET) =>
  jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: '1h', ...options });

// UUIDs fijos para los tests
const IDS = {
  admin: '11111111-1111-4111-8111-111111111111',
  admin2: '22222222-2222-4222-8222-222222222222',
  espectador: '33333333-3333-4333-8333-333333333333',
  inexistente: '44444444-4444-4444-8444-444444444444',
};

module.exports = { TEST_SECRET, installFakePool, startServer, request, signToken, IDS };
