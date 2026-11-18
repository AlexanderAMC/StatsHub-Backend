const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { installFakePool, startServer, request, signToken, IDS, TEST_SECRET } = require('./helpers');

const pool = installFakePool();
const app = require('../src/app');

let server;
let users;

before(async () => {
  server = await startServer(app);
});
after(async () => {
  await server.close();
});

beforeEach(() => {
  pool.reset();
  users = {
    [IDS.admin]: { id: IDS.admin, activo: true, rol: 'ADMINISTRADOR' },
    [IDS.admin2]: { id: IDS.admin2, activo: true, rol: 'ADMINISTRADOR' },
    [IDS.espectador]: { id: IDS.espectador, activo: true, rol: 'ESPECTADOR' },
  };
  pool
    .when(/WHERE u\.id = \$1/, ([id]) => ({ rows: users[id] ? [users[id]] : [] }))
    .when(/COUNT\(\*\)/, () => ({
      rows: [{ total: Object.values(users).filter((u) => u.activo && u.rol === 'ADMINISTRADOR').length }],
    }))
    .when(/SELECT u\.id, u\.nombre/, {
      rows: [{ id: IDS.admin, nombre: 'Ana', apellido: 'Admin', correo: 'ana@statshub.cl', activo: true, rol: 'ADMINISTRADOR' }],
    })
    .when(/SELECT id FROM seguridad\.roles/, ([name]) => ({
      rows: ['ADMINISTRADOR', 'ESPECTADOR', 'JUGADOR'].includes(name) ? [{ id: 7 }] : [],
    }))
    .when(/UPDATE seguridad\.usuarios/, { rows: [] })
    .when(/DELETE FROM seguridad\.usuarios/, { rows: [] });
});

const adminToken = () => signToken({ id: IDS.admin, rol: 'ADMINISTRADOR' });
const writes = () => pool.calls.filter((c) => /UPDATE|DELETE/.test(c.sql));

// --- Autenticación ---

test('GET /users sin token responde 401', async () => {
  const res = await request(server.url, 'GET', '/api/auth/users');
  assert.equal(res.status, 401);
});

test('GET /users con token basura responde 401', async () => {
  const res = await request(server.url, 'GET', '/api/auth/users', { token: 'no-es-un-jwt' });
  assert.equal(res.status, 401);
});

test('GET /users con token firmado con otro secreto responde 401', async () => {
  const forged = signToken({ id: IDS.admin, rol: 'ADMINISTRADOR' }, {}, 'secreto_super_seguro_statshub');
  const res = await request(server.url, 'GET', '/api/auth/users', { token: forged });
  assert.equal(res.status, 401);
});

test('GET /users con token expirado responde 401', async () => {
  const expired = jwt.sign(
    { id: IDS.admin, rol: 'ADMINISTRADOR', exp: Math.floor(Date.now() / 1000) - 60 },
    TEST_SECRET,
    { algorithm: 'HS256' }
  );
  const res = await request(server.url, 'GET', '/api/auth/users', { token: expired });
  assert.equal(res.status, 401);
});

test('GET /users con token sin firma (alg none) responde 401', async () => {
  const unsigned = jwt.sign({ id: IDS.admin, rol: 'ADMINISTRADOR' }, null, { algorithm: 'none' });
  const res = await request(server.url, 'GET', '/api/auth/users', { token: unsigned });
  assert.equal(res.status, 401);
});

test('un usuario bloqueado pierde el acceso aunque su token siga vigente', async () => {
  users[IDS.admin].activo = false;
  const res = await request(server.url, 'GET', '/api/auth/users', { token: adminToken() });
  assert.equal(res.status, 401);
});

// --- Autorización ---

test('GET /users con rol ESPECTADOR responde 403', async () => {
  const token = signToken({ id: IDS.espectador, rol: 'ESPECTADOR' });
  const res = await request(server.url, 'GET', '/api/auth/users', { token });
  assert.equal(res.status, 403);
});

test('el rol se toma de la BD, no del token: un token que dice ADMINISTRADOR no basta', async () => {
  const token = signToken({ id: IDS.espectador, rol: 'ADMINISTRADOR' });
  const res = await request(server.url, 'GET', '/api/auth/users', { token });
  assert.equal(res.status, 403);
});

test('GET /users como admin responde 200 sin password_hash', async () => {
  const res = await request(server.url, 'GET', '/api/auth/users', { token: adminToken() });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body[0].password_hash, undefined);
});

// --- Cambio de rol ---

test('PUT /users/:id/role sin token responde 401 y no modifica nada (escalada bloqueada)', async () => {
  const res = await request(server.url, 'PUT', `/api/auth/users/${IDS.espectador}/role`, {
    body: { role: 'administrador' },
  });
  assert.equal(res.status, 401);
  assert.equal(writes().length, 0);
});

test('PUT role con id que no es UUID responde 400', async () => {
  const res = await request(server.url, 'PUT', '/api/auth/users/123/role', {
    token: adminToken(),
    body: { role: 'jugador' },
  });
  assert.equal(res.status, 400);
});

test('PUT role con rol fuera de la lista blanca responde 400', async () => {
  const res = await request(server.url, 'PUT', `/api/auth/users/${IDS.espectador}/role`, {
    token: adminToken(),
    body: { role: 'superusuario' },
  });
  assert.equal(res.status, 400);
  assert.equal(writes().length, 0);
});

test('PUT role de un usuario inexistente responde 404', async () => {
  const res = await request(server.url, 'PUT', `/api/auth/users/${IDS.inexistente}/role`, {
    token: adminToken(),
    body: { role: 'jugador' },
  });
  assert.equal(res.status, 404);
});

test('un admin no puede quitarse su propio rol de administrador', async () => {
  const res = await request(server.url, 'PUT', `/api/auth/users/${IDS.admin}/role`, {
    token: adminToken(),
    body: { role: 'espectador' },
  });
  assert.equal(res.status, 400);
  assert.equal(writes().length, 0);
});

test('admin cambia el rol de otro usuario (acepta minúsculas)', async () => {
  const res = await request(server.url, 'PUT', `/api/auth/users/${IDS.espectador}/role`, {
    token: adminToken(),
    body: { role: 'jugador' },
  });
  assert.equal(res.status, 200);
  const update = writes()[0];
  assert.match(update.sql, /SET rol_id/);
  assert.deepEqual(update.params, [7, IDS.espectador]);
});

// --- Estado ---

test('PUT status con valor desconocido responde 400', async () => {
  const res = await request(server.url, 'PUT', `/api/auth/users/${IDS.espectador}/status`, {
    token: adminToken(),
    body: { status: 'eliminado' },
  });
  assert.equal(res.status, 400);
});

test('un admin no puede bloquearse a sí mismo', async () => {
  const res = await request(server.url, 'PUT', `/api/auth/users/${IDS.admin}/status`, {
    token: adminToken(),
    body: { status: 'bloqueado' },
  });
  assert.equal(res.status, 400);
});

test('admin bloquea a otro usuario', async () => {
  const res = await request(server.url, 'PUT', `/api/auth/users/${IDS.espectador}/status`, {
    token: adminToken(),
    body: { status: 'bloqueado' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(writes()[0].params, [false, IDS.espectador]);
});

// --- Eliminación ---

test('un admin no puede eliminar su propia cuenta', async () => {
  const res = await request(server.url, 'DELETE', `/api/auth/users/${IDS.admin}`, { token: adminToken() });
  assert.equal(res.status, 400);
  assert.equal(writes().length, 0);
});

test('DELETE de un usuario inexistente responde 404', async () => {
  const res = await request(server.url, 'DELETE', `/api/auth/users/${IDS.inexistente}`, { token: adminToken() });
  assert.equal(res.status, 404);
});

test('DELETE de un usuario con datos asociados responde 409 en vez de 500', async () => {
  pool.reset();
  pool
    .when(/WHERE u\.id = \$1/, ([id]) => ({ rows: users[id] ? [users[id]] : [] }))
    .when(/DELETE FROM seguridad\.usuarios/, () => {
      const error = new Error('violates foreign key constraint');
      error.code = '23503';
      throw error;
    });
  const res = await request(server.url, 'DELETE', `/api/auth/users/${IDS.espectador}`, { token: adminToken() });
  assert.equal(res.status, 409);
});

test('admin elimina a otro usuario', async () => {
  const res = await request(server.url, 'DELETE', `/api/auth/users/${IDS.espectador}`, { token: adminToken() });
  assert.equal(res.status, 200);
  assert.deepEqual(writes()[0].params, [IDS.espectador]);
});
