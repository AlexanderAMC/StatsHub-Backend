const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { installFakePool, startServer, request, IDS, TEST_SECRET } = require('./helpers');

const pool = installFakePool();
const app = require('../src/app');

const PASSWORD = 'clave-correcta-123';
const HASH = bcrypt.hashSync(PASSWORD, 4);

let server;
let accounts;

before(async () => {
  server = await startServer(app);
});
after(async () => {
  await server.close();
});

beforeEach(() => {
  pool.reset();
  accounts = {
    'ana@statshub.cl': {
      id: IDS.admin, nombre: 'Ana', apellido: 'Admin', correo: 'ana@statshub.cl',
      password_hash: HASH, activo: true, rol: 'ADMINISTRADOR',
    },
    'bloqueado@statshub.cl': {
      id: IDS.espectador, nombre: 'Beto', apellido: 'Bloq', correo: 'bloqueado@statshub.cl',
      password_hash: HASH, activo: false, rol: 'ESPECTADOR',
    },
  };
  pool.when(/WHERE LOWER\(u\.correo\) = \$1/, ([correo]) => ({ rows: accounts[correo] ? [accounts[correo]] : [] }));
  // Contador de intentos fallidos y bloqueo temporal de la cuenta.
  pool.when(/SET intentos_fallidos = \$1/, ([fallidos, bloquear, , id]) => {
    const cuenta = Object.values(accounts).find((a) => a.id === id);
    cuenta.intentos_fallidos = fallidos;
    cuenta.bloqueado_hasta = bloquear ? new Date(Date.now() + 15 * 60 * 1000) : null;
    return { rows: [] };
  });
  pool.when(/SET intentos_fallidos = 0, bloqueado_hasta = NULL/, () => ({ rows: [] }));
});

test('la cuenta se bloquea al 5.º intento fallido, incluso para la contraseña correcta', async () => {
  for (let i = 0; i < 4; i += 1) assert.equal((await login({ correo: 'ana@statshub.cl', password: 'otra-clave-999' })).status, 401);
  assert.equal((await login({ correo: 'ana@statshub.cl', password: 'otra-clave-999' })).status, 429);
  const correcta = await login({ correo: 'ana@statshub.cl', password: PASSWORD });
  assert.equal(correcta.status, 429);
  assert.match(correcta.body.error, /bloqueada/);
});

const login = (body) => request(server.url, 'POST', '/api/auth/login', { body });

test('login sin contraseña responde 400', async () => {
  const res = await login({ correo: 'ana@statshub.cl' });
  assert.equal(res.status, 400);
});

test('login con JSON mal formado responde 400 en JSON', async () => {
  const res = await request(server.url, 'POST', '/api/auth/login', { rawBody: '{"correo": ' });
  assert.equal(res.status, 400);
  assert.ok(res.body.error);
});

test('correo inexistente y contraseña incorrecta dan la misma respuesta 401', async () => {
  const unknown = await login({ correo: 'nadie@statshub.cl', password: PASSWORD });
  const wrong = await login({ correo: 'ana@statshub.cl', password: 'otra-clave-999' });
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(unknown.body, wrong.body);
});

test('usuario bloqueado con contraseña incorrecta recibe 401 (no se revela el bloqueo)', async () => {
  const res = await login({ correo: 'bloqueado@statshub.cl', password: 'otra-clave-999' });
  assert.equal(res.status, 401);
});

test('usuario bloqueado con contraseña correcta recibe 403', async () => {
  const res = await login({ correo: 'bloqueado@statshub.cl', password: PASSWORD });
  assert.equal(res.status, 403);
});

test('login correcto devuelve un JWT válido y no expone el hash', async () => {
  const res = await login({ correo: '  ANA@StatsHub.cl ', password: PASSWORD });
  assert.equal(res.status, 200);
  assert.equal(pool.calls[0].params[0], 'ana@statshub.cl');

  const payload = jwt.verify(res.body.token, TEST_SECRET, { algorithms: ['HS256'] });
  assert.equal(payload.id, IDS.admin);
  assert.equal(payload.rol, 'ADMINISTRADOR');
  assert.ok(payload.exp > payload.iat);

  assert.equal(res.body.usuario.password_hash, undefined);
  assert.equal(res.body.usuario.correo, 'ana@statshub.cl');
});

test('tras 10 intentos fallidos, el siguiente responde 429', async () => {
  const body = { correo: 'fuerza-bruta@statshub.cl', password: 'intento' };
  for (let i = 0; i < 10; i += 1) {
    const res = await login(body);
    assert.equal(res.status, 401);
  }
  const blocked = await login(body);
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get('retry-after'));
});
