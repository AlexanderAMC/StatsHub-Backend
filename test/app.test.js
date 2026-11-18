const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool, startServer, request } = require('./helpers');

installFakePool();
const app = require('../src/app');
const { requirePermission } = require('../src/middleware/auth');
const { PERMISSIONS, ROLE_PERMISSIONS, hasPermission } = require('../src/config/permissions');
const { ASSIGNABLE_ROLES } = require('../src/config/roles');

let server;
before(async () => {
  server = await startServer(app);
});
after(async () => {
  await server.close();
});

test('una ruta inexistente responde 404 en JSON', async () => {
  const res = await request(server.url, 'GET', '/api/no-existe');
  assert.equal(res.status, 404);
  assert.match(res.body.error, /No existe la ruta/);
});

test('helmet añade cabeceras de seguridad', async () => {
  const res = await request(server.url, 'GET', '/api/no-existe');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('content-security-policy'));
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('CORS permite el origen del frontend en desarrollo', async () => {
  const res = await request(server.url, 'GET', '/api/no-existe', { origin: 'http://localhost:5173' });
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
});

test('CORS no autoriza orígenes desconocidos', async () => {
  const res = await request(server.url, 'GET', '/api/no-existe', { origin: 'https://sitio-malicioso.example' });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('todos los roles asignables tienen permisos definidos y solo el admin gestiona usuarios', () => {
  for (const role of ASSIGNABLE_ROLES) {
    assert.ok(Array.isArray(ROLE_PERMISSIONS[role]), `faltan permisos para ${role}`);
  }
  const managers = ASSIGNABLE_ROLES.filter((r) => hasPermission(r, PERMISSIONS.MANAGE_USERS));
  assert.deepEqual(managers, ['ADMINISTRADOR']);
});

test('requirePermission: 401 sin usuario, 403 sin permiso, pasa con permiso', async () => {
  const mini = express();
  mini.use((req, res, next) => {
    const rol = req.headers['x-rol'];
    if (rol) req.user = { id: 'x', rol };
    next();
  });
  mini.get('/torneos', requirePermission(PERMISSIONS.MANAGE_TOURNAMENTS), (req, res) => res.json({ ok: true }));
  const srv = await startServer(mini);
  try {
    const call = (rol) => fetch(`${srv.url}/torneos`, { headers: rol ? { 'x-rol': rol } : {} }).then((r) => r.status);
    assert.equal(await call(), 401);
    assert.equal(await call('ESPECTADOR'), 403);
    assert.equal(await call('ARBITRO'), 403);
    assert.equal(await call('ORGANIZADOR'), 200);
    assert.equal(await call('ADMINISTRADOR'), 200);
  } finally {
    await srv.close();
  }
});

test('el mapa de permisos coincide con el del frontend', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const frontendFile = path.resolve(__dirname, '../../StatsHub-Frontend/src/data/users.js');
  if (!fs.existsSync(frontendFile)) return; // repos clonados por separado: no se puede comparar
  const source = fs.readFileSync(frontendFile, 'utf8');
  for (const value of Object.values(PERMISSIONS)) {
    assert.ok(source.includes(`'${value}'`), `el frontend no define el permiso ${value}`);
  }
});
