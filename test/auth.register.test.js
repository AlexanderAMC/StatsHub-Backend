const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { installFakePool, startServer, request } = require('./helpers');

const pool = installFakePool();
const app = require('../src/app');

let server;

before(async () => {
  server = await startServer(app);
});
after(async () => {
  await server.close();
});

const VALID = { nombre: 'Carla', apellido: 'Rojas', correo: 'Carla@StatsHub.cl', password: 'una-clave-segura', aceptaPrivacidad: true };

beforeEach(() => {
  pool.reset();
  pool
    .when(/FROM seguridad\.roles/, ([name]) => ({ rows: name === 'ESPECTADOR' ? [{ id: 7 }] : [] }))
    .when(/INSERT INTO seguridad\.usuarios/, ([nombre, apellido, correo]) => ({
      rows: [{ id: 'nuevo-id', nombre, apellido, correo }],
    }));
});

const register = (body) => request(server.url, 'POST', '/api/auth/register', { body });
const insertCall = () => pool.calls.find((c) => /INSERT INTO/.test(c.sql));

test('registro con datos inválidos responde 400 sin tocar la BD', async () => {
  const cases = [
    { ...VALID, correo: 'no-es-correo' },
    { ...VALID, password: 'corta' },
    { ...VALID, password: 'x'.repeat(73) },
    { ...VALID, apellido: '   ' },
  ];
  for (const body of cases) {
    const res = await register(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(pool.calls.length, 0);
});

test('si no existe el rol ESPECTADOR, el registro falla y NO crea un administrador', async () => {
  pool.reset();
  pool.when(/FROM seguridad\.roles/, { rows: [] });
  const res = await register(VALID);
  assert.equal(res.status, 500);
  assert.equal(insertCall(), undefined);
});

test('correo duplicado responde 409', async () => {
  pool.reset();
  pool
    .when(/FROM seguridad\.roles/, { rows: [{ id: 7 }] })
    .when(/INSERT INTO seguridad\.usuarios/, () => {
      const error = new Error('duplicate key');
      error.code = '23505';
      throw error;
    });
  const res = await register(VALID);
  assert.equal(res.status, 409);
});

test('registro correcto: rol ESPECTADOR, correo normalizado y contraseña hasheada', async () => {
  const res = await register(VALID);
  assert.equal(res.status, 201);

  const roleCall = pool.calls.find((c) => /FROM seguridad\.roles/.test(c.sql));
  assert.deepEqual(roleCall.params, ['ESPECTADOR']);

  const [nombre, apellido, correo, hash, rolId] = insertCall().params;
  assert.equal(nombre, 'Carla');
  assert.equal(apellido, 'Rojas');
  assert.equal(correo, 'carla@statshub.cl');
  assert.notEqual(hash, VALID.password);
  assert.ok(bcrypt.compareSync(VALID.password, hash));
  assert.equal(rolId, 7);
});

test('el cliente no puede elegir su rol al registrarse', async () => {
  const res = await register({ ...VALID, correo: 'otro@statshub.cl', rol: 'ADMINISTRADOR', rol_id: 1 });
  assert.equal(res.status, 201);
  const roleCall = pool.calls.find((c) => /FROM seguridad\.roles/.test(c.sql));
  assert.deepEqual(roleCall.params, ['ESPECTADOR']);
  assert.equal(insertCall().params[4], 7);
});
