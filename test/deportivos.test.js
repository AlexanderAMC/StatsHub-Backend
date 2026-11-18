const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
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

beforeEach(() => {
  pool.reset();
  pool
    .when(/FROM deportivo\.partidos/, {
      rows: [{ id: 1, torneo_id: 2, equipo_local: 3, equipo_visita: 4, estado: 'FINALIZADO', goles_local: 2, goles_visita: 1 }],
    })
    .when(/FROM deportivo\.equipos/, { rows: [{ id: 3, nombre: 'Halcones', torneo_id: 2, torneo_ids: [2] }] })
    .when(/FROM deportivo\.torneos/, { rows: [{ id: 2, nombre: 'Apertura', cantidad_equipos: 6 }] });
});

test('GET /api/partidos selecciona los ids de torneo y equipos que usa el frontend', async () => {
  const res = await request(server.url, 'GET', '/api/partidos');
  assert.equal(res.status, 200);
  const { sql } = pool.calls[0];
  for (const column of ['p.torneo_id', 'p.equipo_local', 'p.equipo_visita']) {
    assert.ok(sql.includes(column), `falta ${column} en la consulta`);
  }
  assert.equal(res.body[0].equipo_local, 3);
});

test('GET /api/equipos devuelve torneo_id y columnas explícitas (sin SELECT *)', async () => {
  const res = await request(server.url, 'GET', '/api/equipos');
  assert.equal(res.status, 200);
  const { sql } = pool.calls[0];
  assert.ok(sql.includes('torneo_id'));
  assert.ok(!/SELECT \*/i.test(sql));
});

test('GET /api/torneos incluye la cantidad de equipos inscritos', async () => {
  const res = await request(server.url, 'GET', '/api/torneos');
  assert.equal(res.status, 200);
  assert.ok(pool.calls[0].sql.includes('cantidad_equipos'));
});
