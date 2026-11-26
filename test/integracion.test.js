// Pruebas de integración de punta a punta contra un PostgreSQL REAL y DESECHABLE.
// Aplica las migraciones y seeds de ../StatsHub-Database y recorre los flujos completos por HTTP.
// Requiere TEST_DATABASE_URL (el nombre de la base debe contener "test"); si no, se omite.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const url = process.env.TEST_DATABASE_URL;
const DB_REPO = path.resolve(__dirname, '..', '..', 'StatsHub-Database');
const dbName = url ? new URL(url).pathname.slice(1) : '';
const skip = !url
  ? 'TEST_DATABASE_URL no definida'
  : !/test/i.test(dbName)
    ? `la base "${dbName}" no parece de pruebas`
    : !fs.existsSync(path.join(DB_REPO, 'scripts', 'migrate.js'))
      ? 'no se encontró el repositorio StatsHub-Database junto a este'
      : false;

let server;
let pool;
let api;
const tokens = {};
const ctx = {};

function runDbScript(script, args = []) {
  const result = spawnSync(process.execPath, [path.join(DB_REPO, 'scripts', script), ...args], {
    cwd: DB_REPO,
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
    timeout: 600000, // margen amplio para equipos lentos
  });
  assert.equal(result.status, 0, `${script} falló:\n${result.stdout}\n${result.stderr}`);
}

before(async () => {
  if (skip) return;
  const u = new URL(url);
  Object.assign(process.env, {
    DB_HOST: u.hostname, DB_PORT: u.port || '5432', DB_NAME: dbName,
    DB_USER: decodeURIComponent(u.username), DB_PASSWORD: decodeURIComponent(u.password),
    JWT_SECRET: 'integracion-secreto-con-mas-de-32-caracteres!!', NODE_ENV: 'test',
    UPLOADS_DIR: path.join(require('node:os').tmpdir(), `statshub-uploads-${process.pid}`),
  });
  process.env.ML_SERVICE_URL = ''; // vacía (no borrada): dotenv no la sobrescribe con la del .env

  const { Client } = require('pg');
  const admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS analytics, auditoria, pagos, deportivo, seguridad CASCADE;
                     DROP TABLE IF EXISTS public.schema_migrations;`);
  await admin.end();
  runDbScript('migrate.js', ['up']);
  runDbScript('seed.js');

  pool = require('../src/config/database');
  const bcrypt = require('bcrypt');
  const hash = await bcrypt.hash('Clave-Admin-2026', 4);
  const userHash = await bcrypt.hash('Clave-Usuario-2026', 4);
  await pool.query(
    `INSERT INTO seguridad.usuarios (nombre, apellido, correo, password_hash, rol_id)
     SELECT 'Ana', 'Admin', 'admin@test.cl', $1, id FROM seguridad.roles WHERE nombre = 'ADMINISTRADOR'`,
    [hash]
  );
  await pool.query(
    `UPDATE seguridad.usuarios SET password_hash = $1 WHERE correo IN ('organizador@statshub.cl', 'estadigrafo@statshub.cl', 'arbitro@statshub.cl')`,
    [userHash]
  );

  const app = require('../src/app');
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  api = async (method, route, { body, token, form } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${route}`, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual' });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: response.status, body: data, headers: response.headers };
  };
  const login = async (correo, password) => (await api('POST', '/auth/login', { body: { correo, password } })).body.token;
  tokens.admin = await login('admin@test.cl', 'Clave-Admin-2026');
  tokens.organizador = await login('organizador@statshub.cl', 'Clave-Usuario-2026');
  tokens.estadigrafo = await login('estadigrafo@statshub.cl', 'Clave-Usuario-2026');
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
});

const opts = { skip };

test('login entrega tokens para cada rol', opts, () => {
  assert.ok(tokens.admin && tokens.organizador && tokens.estadigrafo);
});

test('gestión deportiva: categoría, torneo con cupos, equipos y validaciones', opts, async () => {
  const cat = await api('POST', '/categorias', { token: tokens.organizador, body: { nombre: 'Sub-20', edad_min: 15, edad_max: 20 } });
  assert.equal(cat.status, 201);
  assert.equal((await api('POST', '/categorias', { token: tokens.organizador, body: { nombre: 'Sub-20' } })).status, 409);

  const torneo = await api('POST', '/torneos', {
    token: tokens.organizador,
    body: { nombre: 'Copa Test', categoria: 'Sub-20', cupos: 2, estado: 'INSCRIPCIONES', fecha_inicio: '2026-03-01', fecha_fin: '2026-06-30', costo_inscripcion: 15000, deporte: 'FUTBOL' },
  });
  assert.equal(torneo.status, 201, JSON.stringify(torneo.body));
  ctx.torneo = torneo.body;
  assert.equal((await api('POST', '/torneos', { token: tokens.organizador, body: { nombre: 'copa test', categoria: 'Sub-20', fecha_inicio: '2026-01-01' } })).status, 409);

  const a = await api('POST', '/equipos', { token: tokens.organizador, body: { nombre: 'Halcones', torneo_id: ctx.torneo.id, entrenador: 'Pedro' } });
  const b = await api('POST', '/equipos', { token: tokens.organizador, body: { nombre: 'Leones', torneo_id: ctx.torneo.id } });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.body.torneo_id, ctx.torneo.id);
  ctx.home = a.body;
  ctx.away = b.body;
  const lleno = await api('POST', '/equipos', { token: tokens.organizador, body: { nombre: 'Pumas', torneo_id: ctx.torneo.id } });
  assert.equal(lleno.status, 409, 'el torneo no debe aceptar más equipos que sus cupos');

  const torneos = await api('GET', '/torneos');
  assert.equal(torneos.body.find((t) => t.id === ctx.torneo.id).cantidad_equipos, 2);
});

test('un espectador o un anónimo no pueden crear torneos', opts, async () => {
  assert.equal((await api('POST', '/torneos', { body: { nombre: 'X' } })).status, 401);
  const reg = await api('POST', '/auth/register', { body: { nombre: 'Eva', apellido: 'Test', correo: 'eva@test.cl', password: 'clave-segura-1', aceptaPrivacidad: true } });
  assert.equal(reg.status, 201);
  tokens.espectador = (await api('POST', '/auth/login', { body: { correo: 'eva@test.cl', password: 'clave-segura-1' } })).body.token;
  assert.equal((await api('POST', '/torneos', { token: tokens.espectador, body: { nombre: 'X' } })).status, 403);
});

test('jugadores: número único por equipo, edad según categoría y transferencias', opts, async () => {
  const add = (body) => api('POST', '/jugadores', { token: tokens.organizador, body });
  const ids = [];
  for (const [i, equipo] of [[1, ctx.home], [2, ctx.home], [3, ctx.home], [7, ctx.away], [8, ctx.away], [9, ctx.away]]) {
    const res = await add({ nombre: `Jugador ${i}-${equipo.nombre}`, numero: i, posicion: 'Delantero', equipo_id: equipo.id, fecha_nacimiento: '2008-01-01' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    ids.push(res.body.id);
  }
  ctx.h = ids.slice(0, 3);
  ctx.a = ids.slice(3);
  assert.equal((await add({ nombre: 'Duplicado', numero: 1, equipo_id: ctx.home.id })).status, 409);
  const viejo = await add({ nombre: 'Veterano', numero: 30, equipo_id: ctx.home.id, fecha_nacimiento: '1980-05-05' });
  assert.equal(viejo.status, 400);
  assert.match(viejo.body.error, /categoría Sub-20/);

  const libre = await add({ nombre: 'Libre', numero: 50 });
  const tr = await api('POST', `/jugadores/${libre.body.id}/transferencia`, { token: tokens.organizador, body: { equipo_id: ctx.away.id } });
  assert.equal(tr.status, 200);
  assert.equal(tr.body.equipo_id, ctx.away.id);
  const transfers = await api('GET', '/transferencias');
  assert.ok(transfers.body.some((t) => t.jugador_id === libre.body.id && t.desde_equipo_id === null && t.hacia_equipo_id === ctx.away.id));
});

test('programación: inscripción obligatoria, choque de horario y suspensión', opts, async () => {
  const oficiales = await api('GET', '/oficiales', { token: tokens.organizador });
  ctx.arbitro = oficiales.body.arbitros[0];
  ctx.estadigrafo = oficiales.body.estadigrafos[0];
  assert.ok(ctx.arbitro && ctx.estadigrafo);

  const base = { torneo_id: ctx.torneo.id, jornada: 1, equipo_local: ctx.home.id, equipo_visita: ctx.away.id, fecha: '2026-03-07', hora: '15:00', cancha: 'Cancha 1', arbitro_id: ctx.arbitro.id, estadigrafo_id: ctx.estadigrafo.id };
  const p = await api('POST', '/partidos', { token: tokens.organizador, body: base });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  ctx.partido = p.body;
  assert.equal(p.body.fecha_partido, '2026-03-07T15:00:00');
  assert.equal((await api('POST', '/partidos', { token: tokens.organizador, body: base })).status, 409);

  const otro = await api('POST', '/partidos', { token: tokens.organizador, body: { ...base, hora: '18:00', arbitro_id: null } });
  assert.equal((await api('POST', `/partidos/${otro.body.id}/suspender`, { token: tokens.organizador })).body.estado, 'SUSPENDIDO');
  assert.equal((await api('POST', '/partidos', { token: tokens.organizador, body: { ...base, equipo_visita: 999999, hora: '20:00' } })).status, 400);
});

test('acta digital: goles, doble amarilla, expulsión, cambios, deshacer y cierre', opts, async () => {
  const id = ctx.partido.id;
  const ev = (body, token = tokens.estadigrafo) => api('POST', `/partidos/${id}/eventos`, { token, body });

  assert.equal((await ev({ tipo: 'GOL', lado: 'LOCAL', jugador_id: ctx.h[0] })).status, 409, 'sin iniciar no se registran eventos');
  const start = await api('POST', `/partidos/${id}/iniciar`, { token: tokens.estadigrafo, body: { alineacion: { home: ctx.h.slice(0, 2), away: ctx.a.slice(0, 2) } } });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.equal(start.body.estado, 'EN_CURSO');

  await api('PUT', `/partidos/${id}/minuto`, { token: tokens.estadigrafo, body: { minuto: 12 } });
  const gol = await ev({ tipo: 'GOL', lado: 'LOCAL', jugador_id: ctx.h[0], asistencia_id: ctx.h[1] });
  assert.equal(gol.status, 201);
  assert.equal(gol.body[0].minuto, 12);
  assert.equal((await ev({ tipo: 'GOL', lado: 'LOCAL', jugador_id: ctx.h[2] })).status, 409, 'un suplente no puede anotar');

  assert.equal((await ev({ tipo: 'AMARILLA', lado: 'VISITA', jugador_id: ctx.a[0] })).body.length, 1);
  const segunda = await ev({ tipo: 'AMARILLA', lado: 'VISITA', jugador_id: ctx.a[0] });
  assert.deepEqual(segunda.body.map((e) => e.tipo_evento), ['AMARILLA', 'ROJA'], 'la doble amarilla genera roja');
  assert.equal((await ev({ tipo: 'GOL', lado: 'VISITA', jugador_id: ctx.a[0] })).status, 409, 'un expulsado no puede anotar');

  assert.equal((await api('DELETE', `/partidos/${id}/eventos/ultimo`, { token: tokens.estadigrafo })).status, 204);
  const eventos = await api('GET', `/eventos?partido_id=${id}`);
  assert.equal(eventos.body.filter((e) => e.jugador_id === ctx.a[0]).length, 1, 'deshacer quita la amarilla y su roja');

  const cambio = await ev({ tipo: 'SUSTITUCION', lado: 'VISITA', jugador_id: ctx.a[1], relacionado_id: ctx.a[2] });
  assert.equal(cambio.status, 201);
  assert.equal((await ev({ tipo: 'GOL', lado: 'VISITA', jugador_id: ctx.a[2] })).status, 201, 'el que entró puede anotar');
  assert.equal((await ev({ tipo: 'GOL', lado: 'VISITA', jugador_id: ctx.a[1] })).status, 409, 'el que salió ya no está en cancha');

  assert.equal((await ev({ tipo: 'GOL', lado: 'LOCAL', jugador_id: ctx.h[1] }, tokens.espectador)).status, 403);

  const fin = await api('POST', `/partidos/${id}/finalizar`, { token: tokens.estadigrafo });
  assert.equal(fin.status, 200);
  assert.equal(fin.body.estado, 'FINALIZADO');
  assert.equal(fin.body.goles_local, 1);
  assert.equal(fin.body.goles_visita, 1);
  assert.equal((await ev({ tipo: 'GOL', lado: 'LOCAL', jugador_id: ctx.h[0] })).status, 409, 'el acta cerrada no admite cambios');
});

test('estadísticas: posiciones, goleadores, asistencias, fair play y predicción', opts, async () => {
  const tabla = await api('GET', `/estadisticas/posiciones?torneo_id=${ctx.torneo.id}`);
  assert.equal(tabla.body.length, 2);
  assert.ok(tabla.body.every((r) => r.pj === 1 && r.pts === 1 && r.pe === 1));

  const goleadores = await api('GET', `/estadisticas/goleadores?torneo_id=${ctx.torneo.id}`, { token: tokens.organizador });
  assert.equal(goleadores.body.length, 2);
  const asistencias = await api('GET', `/estadisticas/asistencias?torneo_id=${ctx.torneo.id}`, { token: tokens.organizador });
  assert.equal(asistencias.body[0].jugador_id, ctx.h[1]);
  const fair = await api('GET', `/estadisticas/fair-play?torneo_id=${ctx.torneo.id}`, { token: tokens.organizador });
  assert.equal(fair.body.find((r) => r.equipo_id === ctx.away.id).amarillas, 1);

  await api('POST', '/partidos', {
    token: tokens.organizador,
    body: { torneo_id: ctx.torneo.id, jornada: 2, equipo_local: ctx.away.id, equipo_visita: ctx.home.id, fecha: '2026-03-14', hora: '15:00', cancha: 'Cancha 2' },
  });
  const pred = await api('GET', `/estadisticas/predicciones?torneo_id=${ctx.torneo.id}`, { token: tokens.organizador });
  assert.equal(pred.body.length, 1);
  const p = pred.body[0];
  assert.ok(Math.abs(p.local + p.empate + p.visita - 1) < 1e-6);
  assert.equal(p.modelo, 'poisson-node');
});

test('notificaciones: llegan a la liga, el árbitro recibe la del acta y se marcan leídas', opts, async () => {
  const list = await api('GET', '/notificaciones', { token: tokens.organizador });
  assert.ok(list.body.some((n) => n.tipo === 'resultado'));
  assert.ok(list.body.some((n) => n.tipo === 'programacion'));
  assert.equal((await api('POST', '/notificaciones/leidas', { token: tokens.organizador })).status, 204);
  const after = await api('GET', '/notificaciones', { token: tokens.organizador });
  assert.ok(after.body.every((n) => n.leida));

  const tokenArbitro = await (async () => {
    const bcrypt = require('bcrypt');
    await pool.query('UPDATE seguridad.usuarios SET password_hash = $1 WHERE id = $2', [await bcrypt.hash('Clave-Arbitro-2026', 4), ctx.arbitro.id]);
    return (await api('POST', '/auth/login', { body: { correo: 'arbitro@statshub.cl', password: 'Clave-Arbitro-2026' } })).body.token;
  })();
  const arbitro = await api('GET', '/notificaciones', { token: tokenArbitro });
  assert.ok(arbitro.body.some((n) => n.tipo === 'acta'), 'el árbitro debe recibir el aviso para validar el acta (RF-31)');
});

test('seguridad: cerrar sesión invalida el token', opts, async () => {
  const token = (await api('POST', '/auth/login', { body: { correo: 'eva@test.cl', password: 'clave-segura-1' } })).body.token;
  assert.equal((await api('GET', '/auth/me', { token })).status, 200);
  assert.equal((await api('POST', '/auth/logout', { token })).status, 204);
  assert.equal((await api('GET', '/auth/me', { token })).status, 401);
});

test('seguridad: el registro exige aceptar la política de privacidad (Ley 19.628)', opts, async () => {
  const res = await api('POST', '/auth/register', { body: { nombre: 'Sin', apellido: 'Consentimiento', correo: 'sin@test.cl', password: 'clave-segura-1' } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /privacidad/);
});

test('seguridad: cambiar la contraseña cierra las otras sesiones', opts, async () => {
  const login = () => api('POST', '/auth/login', { body: { correo: 'eva@test.cl', password: 'clave-segura-1' } });
  const otraSesion = (await login()).body.token;
  const actual = (await login()).body.token;
  const cambio = await api('PUT', '/auth/me/password', { token: actual, body: { actual: 'clave-segura-1', nueva: 'clave-segura-2' } });
  assert.equal(cambio.status, 200);
  assert.equal((await api('GET', '/auth/me', { token: otraSesion })).status, 401);
  assert.equal((await api('GET', '/auth/me', { token: cambio.body.token })).status, 200);
});

test('seguridad: recuperación de contraseña con enlace de un solo uso', opts, async () => {
  const generic = await api('POST', '/auth/forgot-password', { body: { correo: 'nadie@test.cl' } });
  const real = await api('POST', '/auth/forgot-password', { body: { correo: 'eva@test.cl' } });
  assert.deepEqual(generic.body, real.body, 'la respuesta no revela si el correo existe');

  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO seguridad.password_resets (usuario_id, token_hash, expira_en)
     SELECT id, $1, now() + interval '1 hour' FROM seguridad.usuarios WHERE correo = 'eva@test.cl'`,
    [crypto.createHash('sha256').update(token).digest('hex')]
  );
  assert.equal((await api('POST', '/auth/reset-password', { body: { token, password: 'clave-nueva-3' } })).status, 200);
  assert.equal((await api('POST', '/auth/reset-password', { body: { token, password: 'clave-nueva-4' } })).status, 400, 'el enlace no se reutiliza');
  assert.equal((await api('POST', '/auth/login', { body: { correo: 'eva@test.cl', password: 'clave-nueva-3' } })).status, 200);
});

test('seguridad: el enlace de recuperación nunca viaja en la respuesta y el nuevo anula al anterior', opts, async () => {
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'development'; // ni siquiera en desarrollo
    const res = await api('POST', '/auth/forgot-password', { body: { correo: 'eva@test.cl' } });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ['mensaje'], 'solo el mensaje genérico');
    assert.doesNotMatch(JSON.stringify(res.body), /[0-9a-f]{64}/);
  } finally {
    process.env.NODE_ENV = previous;
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE usado_en IS NULL)::int AS vigentes FROM seguridad.password_resets pr
     JOIN seguridad.usuarios u ON u.id = pr.usuario_id WHERE u.correo = 'eva@test.cl'`);
  assert.equal(rows[0].vigentes, 1, 'solo el último enlace sigue vigente');
});

test('seguridad: 5 intentos fallidos bloquean la cuenta aunque luego se use la contraseña correcta', opts, async () => {
  const reg = await api('POST', '/auth/register', { body: { nombre: 'Lola', apellido: 'Lock', correo: 'lola@test.cl', password: 'clave-segura-5', aceptaPrivacidad: true } });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const intento = (password) => api('POST', '/auth/login', { body: { correo: 'lola@test.cl', password } });
  for (let i = 0; i < 4; i += 1) assert.equal((await intento('mala-clave-1')).status, 401);
  const quinto = await intento('mala-clave-1');
  assert.equal(quinto.status, 429);
  assert.match(quinto.body.error, /bloqueada/);
  assert.equal((await intento('clave-segura-5')).status, 429, 'bloqueada incluso con la contraseña correcta');

  await pool.query(`UPDATE seguridad.usuarios SET bloqueado_hasta = now() - interval '1 minute' WHERE correo = 'lola@test.cl'`);
  assert.equal((await intento('clave-segura-5')).status, 200, 'al vencer el bloqueo vuelve a entrar');

  const debil = await api('POST', '/auth/register', { body: { nombre: 'Debi', apellido: 'L', correo: 'debil@test.cl', password: 'solamente-letras', aceptaPrivacidad: true } });
  assert.equal(debil.status, 400);
  assert.match(debil.body.error, /letras y números/);
});

test('administración: crear y editar usuarios con rol', opts, async () => {
  const nuevo = await api('POST', '/auth/users', { token: tokens.admin, body: { nombre: 'Sergio', apellido: 'Stats', correo: 'sergio@test.cl', password: 'clave-segura-9', rol: 'estadigrafo' } });
  assert.equal(nuevo.status, 201);
  assert.equal(nuevo.body.rol, 'ESTADIGRAFO');
  assert.equal((await api('POST', '/auth/users', { token: tokens.organizador, body: {} })).status, 403);
  const edit = await api('PUT', `/auth/users/${nuevo.body.id}`, { token: tokens.admin, body: { nombre: 'Sergio', apellido: 'Estadígrafo', correo: 'sergio@test.cl' } });
  assert.equal(edit.status, 200);
});

test('escudo: la imagen se convierte a WebP y se sirve desde /uploads', opts, async () => {
  const sharp = require('sharp');
  const png = await sharp({ create: { width: 900, height: 900, channels: 3, background: '#1E0A3C' } }).png().toBuffer();
  const form = new FormData();
  form.append('escudo', new Blob([png], { type: 'image/png' }), 'escudo.png');
  const res = await api('POST', `/equipos/${ctx.home.id}/escudo`, { token: tokens.organizador, form });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.escudo_url, /^\/uploads\/equipos\/.+\.webp$/);
  const file = await fetch(`http://127.0.0.1:${server.address().port}${res.body.escudo_url}`);
  assert.equal(file.status, 200);
  const meta = await sharp(Buffer.from(await file.arrayBuffer())).metadata();
  assert.equal(meta.format, 'webp');
  assert.ok(meta.width <= 512);

  const malo = new FormData();
  malo.append('escudo', new Blob([Buffer.from('no es imagen')], { type: 'image/png' }), 'x.png');
  assert.equal((await api('POST', `/equipos/${ctx.home.id}/escudo`, { token: tokens.organizador, form: malo })).status, 400);
});

test('pagos Flow: sin credenciales responde 503; con Flow confirma e inscribe', opts, async () => {
  const body = { equipo_id: ctx.home.id, torneo_id: ctx.torneo.id };
  assert.equal((await api('POST', '/pagos/inscripcion', { token: tokens.organizador, body })).status, 503);

  Object.assign(process.env, { FLOW_API_KEY: 'api-key-test', FLOW_SECRET_KEY: 'secret-test', FLOW_API_URL: 'https://flow.test/api' });
  const realFetch = global.fetch;
  const flowCalls = [];
  global.fetch = async (input, init) => {
    const target = String(input);
    if (!target.startsWith('https://flow.test/api')) return realFetch(input, init);
    flowCalls.push(target);
    const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (target.includes('/payment/create')) return json({ url: 'https://flow.test/pay', token: 'tok-123', flowOrder: 777 });
    return json({ status: 2, amount: 15000, flowOrder: 777, paymentData: { media: 'Webpay' } });
  };
  try {
    const cobro = await api('POST', '/pagos/inscripcion', { token: tokens.organizador, body });
    assert.equal(cobro.status, 201, JSON.stringify(cobro.body));
    assert.equal(cobro.body.url, 'https://flow.test/pay?token=tok-123');

    const params = new URLSearchParams({ token: 'tok-123' });
    const conf = await fetch(`http://127.0.0.1:${server.address().port}/api/pagos/flow/confirmacion`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params,
    });
    assert.equal(conf.status, 200);
    assert.ok(flowCalls.some((c) => c.includes('/payment/getStatus')), 'el estado se verifica consultando a Flow');

    const equipos = await api('GET', '/equipos');
    assert.equal(equipos.body.find((e) => e.id === ctx.home.id).estado_inscripcion, 'INSCRITO');
    const comprobante = await api('GET', `/pagos/${cobro.body.orden_comercio}`, { token: tokens.organizador });
    assert.equal(comprobante.body.estado, 'PAGADO');
    assert.equal(comprobante.body.medio_pago, 'Webpay');
    // Token nuevo: los anteriores de esta cuenta se invalidaron en los tests de cierre de sesión.
    const espectador = (await api('POST', '/auth/login', { body: { correo: 'eva@test.cl', password: 'clave-nueva-3' } })).body.token;
    assert.equal((await api('GET', `/pagos/${cobro.body.id}`, { token: espectador })).status, 403);
    assert.equal((await api('POST', '/pagos/inscripcion', { token: tokens.organizador, body })).status, 409, 'no se cobra dos veces');
  } finally {
    global.fetch = realFetch;
    delete process.env.FLOW_API_KEY;
    delete process.env.FLOW_SECRET_KEY;
  }
});

test('auditoría: registra las acciones críticas y solo la ve el administrador', opts, async () => {
  const res = await api('GET', '/auditoria?limite=200', { token: tokens.admin });
  assert.equal(res.status, 200);
  const acciones = new Set(res.body.registros.map((r) => r.accion));
  for (const accion of ['CREAR_TORNEO', 'CREAR_EQUIPO', 'ABRIR_ACTA', 'CERRAR_ACTA', 'CREAR_USUARIO', 'PAGO_CONFIRMADO']) {
    assert.ok(acciones.has(accion), `falta ${accion} en la bitácora`);
  }
  assert.equal((await api('GET', '/auditoria', { token: tokens.organizador })).status, 403);
});

test('un torneo con partidos no se elimina: se cancela', opts, async () => {
  const del = await api('DELETE', `/torneos/${ctx.torneo.id}`, { token: tokens.organizador });
  assert.equal(del.status, 409);
  const t = ctx.torneo;
  const cancel = await api('PUT', `/torneos/${t.id}`, {
    token: tokens.organizador,
    body: { nombre: t.nombre, categoria_id: t.categoria_id, cupos: t.cupos, estado: 'CANCELADO', fecha_inicio: t.fecha_inicio, fecha_fin: t.fecha_fin },
  });
  assert.equal(cancel.status, 200);
  assert.equal((await api('PUT', `/torneos/${t.id}`, { token: tokens.organizador, body: { nombre: 'Otro', categoria_id: t.categoria_id, fecha_inicio: '2026-01-01' } })).status, 409);
});


// ======================= PLANES, PROPIEDAD, COBROS Y OFICIALES =======================

// Simula Flow: guarda el monto de cada orden y responde "pagado" al consultar el estado.
let flowSeq = 0; // tokens únicos entre llamadas (como los de Flow)
async function withFlow(fn) {
  Object.assign(process.env, { FLOW_API_KEY: 'k', FLOW_SECRET_KEY: 's', FLOW_API_URL: 'https://flow.test/api' });
  const realFetch = global.fetch;
  const amounts = new Map();
  global.fetch = async (input, init) => {
    const target = String(input);
    if (!target.startsWith('https://flow.test/api')) return realFetch(input, init);
    const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (target.includes('/payment/create')) {
      const token = `tok-plan-${++flowSeq}`;
      amounts.set(token, Number(new URLSearchParams(String(init.body)).get('amount')));
      return json({ url: 'https://flow.test/pay', token, flowOrder: 900 + flowSeq });
    }
    const token = new URL(target).searchParams.get('token');
    return json({ status: 2, amount: amounts.get(token), flowOrder: 900, paymentData: { media: 'Webpay' } });
  };
  const pay = async (url) => {
    const token = new URL(url).searchParams.get('token');
    const res = await realFetch(`http://127.0.0.1:${server.address().port}/api/pagos/flow/confirmacion`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }),
    });
    assert.equal(res.status, 200);
  };
  try {
    await fn(pay);
  } finally {
    global.fetch = realFetch;
    delete process.env.FLOW_API_KEY;
    delete process.env.FLOW_SECRET_KEY;
  }
}

async function newUser(correo) {
  await api('POST', '/auth/register', { body: { nombre: 'Usuario', apellido: correo.split('@')[0], correo, password: 'clave-segura-1', aceptaPrivacidad: true } });
  return (await api('POST', '/auth/login', { body: { correo, password: 'clave-segura-1' } })).body.token;
}

test('planes: el espectador no ve estadísticas avanzadas; con el plan Ultra se vuelve organizador de sus torneos', opts, async () => {
  const planes = await api('GET', '/planes');
  assert.deepEqual(planes.body.map((p) => p.codigo), ['BASICO', 'PRO', 'ULTRA']);

  tokens.ultra = await newUser('ultra@test.cl');
  assert.equal((await api('GET', '/estadisticas/goleadores', { token: tokens.ultra })).status, 403);
  assert.equal((await api('GET', '/estadisticas/posiciones')).status, 200, 'la tabla de posiciones es pública');
  assert.equal((await api('POST', '/torneos', { token: tokens.ultra, body: { nombre: 'X' } })).status, 403);

  await withFlow(async (pay) => {
    const compra = await api('POST', '/suscripciones', { token: tokens.ultra, body: { plan: 'ultra', periodo: 'mes' } });
    assert.equal(compra.status, 201, JSON.stringify(compra.body));
    await pay(compra.body.url);
  });
  const me = await api('GET', '/auth/me', { token: tokens.ultra });
  assert.equal(me.body.plan, 'ULTRA');
  assert.ok(me.body.permisos.includes('torneos:gestionar'));
  assert.ok(!me.body.permisos.includes('usuarios:gestionar'), 'un plan nunca entrega administración');
  const mia = await api('GET', '/suscripciones/mia', { token: tokens.ultra });
  assert.equal(mia.body.plan.plan_codigo, 'ULTRA');
  assert.equal(mia.body.historial.length, 1);
});

test('propiedad: el organizador Ultra gestiona solo sus torneos', opts, async () => {
  const torneo = await api('POST', '/torneos', {
    token: tokens.ultra,
    body: { nombre: 'Liga Ultra', categoria: 'Adulto', cupos: 4, estado: 'ACTIVO', fecha_inicio: '2026-03-01', deporte: 'FUTBOL' },
  });
  assert.equal(torneo.status, 201, JSON.stringify(torneo.body));
  assert.ok(torneo.body.organizador_id);
  ctx.ultraTorneo = torneo.body;
  const ajeno = ctx.torneo;
  assert.equal((await api('PUT', `/torneos/${ajeno.id}`, { token: tokens.ultra, body: { nombre: 'Robado', categoria_id: ajeno.categoria_id, fecha_inicio: '2026-01-01' } })).status, 403);
  assert.equal((await api('POST', '/equipos', { token: tokens.ultra, body: { nombre: 'Intruso', torneo_id: ajeno.id } })).status, 403);
  assert.equal((await api('DELETE', `/equipos/${ctx.home.id}`, { token: tokens.ultra })).status, 403);
});

test('entrenador Pro vinculado por correo: gestiona solo su equipo', opts, async () => {
  tokens.coach = await newUser('coach@test.cl');
  await withFlow(async (pay) => {
    const compra = await api('POST', '/suscripciones', { token: tokens.coach, body: { plan: 'PRO', periodo: 'SEMANA' } });
    await pay(compra.body.url);
  });
  const a = await api('POST', '/equipos', { token: tokens.ultra, body: { nombre: 'Cóndores', torneo_id: ctx.ultraTorneo.id, entrenador_correo: 'coach@test.cl' } });
  const b = await api('POST', '/equipos', { token: tokens.ultra, body: { nombre: 'Pumas', torneo_id: ctx.ultraTorneo.id } });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.ok(a.body.entrenador_id);
  ctx.uHome = a.body;
  ctx.uAway = b.body;
  const propio = await api('POST', '/jugadores', { token: tokens.coach, body: { nombre: 'Delantero', numero: 9, equipo_id: ctx.uHome.id } });
  assert.equal(propio.status, 201, JSON.stringify(propio.body));
  assert.equal((await api('POST', '/jugadores', { token: tokens.coach, body: { nombre: 'X', numero: 9, equipo_id: ctx.uAway.id } })).status, 403);
  const rival = await api('POST', '/jugadores', { token: tokens.ultra, body: { nombre: 'Arquero', numero: 1, equipo_id: ctx.uAway.id } });
  ctx.uPlayers = { home: propio.body.id, away: rival.body.id };
});

test('cobros: planillas por partido y el entrenador paga la de su equipo con Flow', opts, async () => {
  const partido = await api('POST', '/partidos', {
    token: tokens.ultra,
    body: { torneo_id: ctx.ultraTorneo.id, equipo_local: ctx.uHome.id, equipo_visita: ctx.uAway.id, fecha: '2026-03-08', hora: '10:00', cancha: 'Cancha 2', arbitro_id: ctx.arbitro.id, estadigrafo_id: ctx.estadigrafo.id },
  });
  assert.equal(partido.status, 201, JSON.stringify(partido.body));
  ctx.uPartido = partido.body;
  const planillas = await api('POST', '/cobros/planillas', { token: tokens.ultra, body: { partido_id: ctx.uPartido.id, monto: 5000 } });
  assert.equal(planillas.body.creados, 2, JSON.stringify(planillas.body));
  assert.equal((await api('POST', '/cobros/planillas', { token: tokens.ultra, body: { partido_id: ctx.uPartido.id, monto: 5000 } })).status, 409);

  const cobros = await api('GET', '/cobros', { token: tokens.coach });
  assert.equal(cobros.body.length, 1, 'el entrenador solo ve los cobros de su equipo');
  const otro = (await api('GET', '/cobros', { token: tokens.ultra })).body.find((x) => x.equipo_id === ctx.uAway.id);
  assert.equal((await api('POST', `/cobros/${otro.id}/pagar`, { token: tokens.coach })).status, 403);

  await withFlow(async (pay) => {
    const pago = await api('POST', `/cobros/${cobros.body[0].id}/pagar`, { token: tokens.coach });
    assert.equal(pago.status, 201, JSON.stringify(pago.body));
    await pay(pago.body.url);
  });
  const despues = await api('GET', '/cobros', { token: tokens.coach });
  assert.equal(despues.body[0].estado, 'PAGADO');
});

test('oficiales: informe arbitral, liquidación sin doble pago, pago y confirmación', opts, async () => {
  const id = ctx.uPartido.id;
  await api('POST', `/partidos/${id}/iniciar`, { token: tokens.estadigrafo, body: { alineacion: { home: [ctx.uPlayers.home], away: [ctx.uPlayers.away] } } });
  await api('POST', `/partidos/${id}/eventos`, { token: tokens.estadigrafo, body: { tipo: 'GOL', lado: 'LOCAL', jugador_id: ctx.uPlayers.home } });
  assert.equal((await api('POST', `/partidos/${id}/finalizar`, { token: tokens.estadigrafo })).status, 200);

  const tokenArbitro = (await api('POST', '/auth/login', { body: { correo: 'arbitro@statshub.cl', password: 'Clave-Arbitro-2026' } })).body.token;
  assert.equal((await api('POST', `/partidos/${id}/informe`, { token: tokens.estadigrafo, body: { informe: 'x' } })).status, 403, 'solo el árbitro valida');
  const informe = await api('POST', `/partidos/${id}/informe`, { token: tokenArbitro, body: { informe: 'Partido sin incidentes.' } });
  assert.equal(informe.status, 200, JSON.stringify(informe.body));
  assert.equal((await api('GET', `/partidos/${id}/informe`, { token: tokens.ultra })).body.informe_arbitral, 'Partido sin incidentes.');
  assert.equal((await api('GET', `/partidos/${id}/informe`, { token: tokens.coach })).status, 403, 'el público no ve el informe');

  // Tarifas: acordada en el torneo para el árbitro; la del perfil para el estadígrafo.
  assert.equal((await api('PUT', `/torneos/${ctx.ultraTorneo.id}/oficiales/${ctx.arbitro.id}`, { token: tokens.ultra, body: { tarifa: 15000 } })).status, 200);
  await api('PUT', '/auth/me', { token: tokens.estadigrafo, body: { tarifaPartido: 8000 } });

  const pend = await api('GET', `/liquidaciones/pendientes?oficial_id=${ctx.arbitro.id}&torneo_id=${ctx.ultraTorneo.id}`, { token: tokens.ultra });
  assert.equal(pend.body.cantidad, 1, JSON.stringify(pend.body));
  assert.equal(pend.body.total, 15000);
  const stats = await api('GET', `/liquidaciones/pendientes?oficial_id=${ctx.estadigrafo.id}&torneo_id=${ctx.ultraTorneo.id}`, { token: tokens.ultra });
  assert.equal(stats.body.total, 8000);

  const liq = await api('POST', '/liquidaciones', { token: tokens.ultra, body: { oficial_id: ctx.arbitro.id, torneo_id: ctx.ultraTorneo.id } });
  assert.equal(liq.status, 201, JSON.stringify(liq.body));
  assert.equal(Number(liq.body.monto_total), 15000);
  assert.equal((await api('POST', '/liquidaciones', { token: tokens.ultra, body: { oficial_id: ctx.arbitro.id, torneo_id: ctx.ultraTorneo.id } })).status, 409, 'no se paga dos veces el mismo partido');

  const mis = await api('GET', '/liquidaciones', { token: tokenArbitro });
  assert.ok(mis.body.some((l) => l.id === liq.body.id));
  assert.equal((await api('POST', `/liquidaciones/${liq.body.id}/confirmar`, { token: tokenArbitro, body: { conforme: true } })).status, 409, 'aún no está pagada');
  const pagada = await api('POST', `/liquidaciones/${liq.body.id}/pagar`, { token: tokens.ultra, body: { medio_pago: 'Transferencia', referencia: 'OP-123' } });
  assert.equal(pagada.body.estado, 'PAGADA');
  const recibida = await api('POST', `/liquidaciones/${liq.body.id}/confirmar`, { token: tokenArbitro, body: { conforme: true } });
  assert.equal(recibida.body.estado, 'RECIBIDA');
});

test('básquetbol: acta con puntos, faltas, cambios y tiempos muertos; tabla FIBA y estadísticas', opts, async () => {
  const org = { token: tokens.organizador };
  const torneo = await api('POST', '/torneos', { ...org, body: { nombre: 'Liga Básquet Test', categoria: 'Adulto', cupos: 4, estado: 'ACTIVO', fecha_inicio: '2026-04-01' } });
  assert.equal(torneo.status, 201, JSON.stringify(torneo.body));
  assert.equal(torneo.body.deporte, 'BASQUETBOL', 'los torneos nuevos son de básquetbol por defecto');

  const team = async (nombre) => {
    const r = await api('POST', '/equipos', { ...org, body: { nombre, torneo_id: torneo.body.id } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const home = await team('Toros del Aro');
  const away = await team('Cóndores del Aro');
  const roster = async (equipo, base) => {
    const ids = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await api('POST', '/jugadores', { ...org, body: { nombre: `Basquetbolista ${base + i}`, numero: base + i, posicion: 'Base', equipo_id: equipo.id } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      ids.push(r.body.id);
    }
    return ids;
  };
  const h = await roster(home, 10);
  const a = await roster(away, 20);

  const partido = await api('POST', '/partidos', { ...org, body: { torneo_id: torneo.body.id, equipo_local: home.id, equipo_visita: away.id, fecha: '2026-04-04', hora: '19:00', cancha: 'Gimnasio' } });
  assert.equal(partido.status, 201, JSON.stringify(partido.body));
  const id = partido.body.id;
  const ev = (body) => api('POST', `/partidos/${id}/eventos`, { ...org, body });
  const score = async () => {
    const p = (await api('GET', '/partidos')).body.find((m) => m.id === id);
    return [p.goles_local, p.goles_visita];
  };

  const start = await api('POST', `/partidos/${id}/iniciar`, { ...org, body: { alineacion: { home: h.slice(0, 5), away: a.slice(0, 5) } } });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.equal(start.body.deporte, 'BASQUETBOL');
  assert.equal((await ev({ tipo: 'GOL', lado: 'LOCAL', jugador_id: h[0] })).status, 400, 'un gol no existe en básquetbol');

  assert.equal((await api('PUT', `/partidos/${id}/minuto`, { ...org, body: { periodo: 1, minuto: 11 } })).status, 400, 'un cuarto dura 10 minutos');
  assert.equal((await api('PUT', `/partidos/${id}/minuto`, { ...org, body: { periodo: 1, minuto: 4 } })).status, 200);

  const triple = await ev({ tipo: 'PUNTO_3', lado: 'LOCAL', jugador_id: h[0], asistencia_id: h[1] });
  assert.equal(triple.status, 201, JSON.stringify(triple.body));
  assert.equal(triple.body[0].periodo, 1);
  await ev({ tipo: 'PUNTO_2', lado: 'VISITA', jugador_id: a[0] });
  await ev({ tipo: 'PUNTO_1', lado: 'LOCAL', jugador_id: h[2] });
  assert.deepEqual(await score(), [4, 2], 'libre = 1, doble = 2, triple = 3');
  assert.equal((await ev({ tipo: 'PUNTO_2', lado: 'LOCAL', jugador_id: h[5] })).status, 409, 'un suplente no anota');

  // Quinta falta: el jugador queda eliminado.
  for (let i = 0; i < 5; i += 1) assert.equal((await ev({ tipo: 'FALTA', lado: 'VISITA', jugador_id: a[1] })).status, 201);
  assert.equal((await ev({ tipo: 'FALTA', lado: 'VISITA', jugador_id: a[1] })).status, 409, 'con 5 faltas queda eliminado');
  assert.equal((await ev({ tipo: 'SUSTITUCION', lado: 'VISITA', jugador_id: a[2], relacionado_id: a[1] })).status, 409, 'un eliminado no vuelve a entrar');

  // Cambios ilimitados y con reingreso.
  assert.equal((await ev({ tipo: 'SUSTITUCION', lado: 'VISITA', jugador_id: a[2], relacionado_id: a[5] })).status, 201);
  assert.equal((await ev({ tipo: 'SUSTITUCION', lado: 'VISITA', jugador_id: a[5], relacionado_id: a[2] })).status, 201, 'en básquetbol se puede volver a entrar');

  // Tiempos muertos: 2 en la primera mitad, 3 en la segunda.
  assert.equal((await ev({ tipo: 'TIEMPO_MUERTO', lado: 'LOCAL' })).status, 201);
  assert.equal((await ev({ tipo: 'TIEMPO_MUERTO', lado: 'LOCAL' })).status, 201);
  assert.equal((await ev({ tipo: 'TIEMPO_MUERTO', lado: 'LOCAL' })).status, 409);
  await api('PUT', `/partidos/${id}/minuto`, { ...org, body: { periodo: 3, minuto: 2 } });
  assert.equal((await ev({ tipo: 'TIEMPO_MUERTO', lado: 'LOCAL' })).status, 201, 'la segunda mitad trae tiempos nuevos');

  await ev({ tipo: 'REBOTE', lado: 'LOCAL', jugador_id: h[0] });
  await ev({ tipo: 'PUNTO_2', lado: 'VISITA', jugador_id: a[0] });
  assert.deepEqual(await score(), [4, 4]);
  assert.equal((await api('POST', `/partidos/${id}/finalizar`, org)).status, 409, 'no termina empatado');
  await ev({ tipo: 'PUNTO_3', lado: 'VISITA', jugador_id: a[3] });
  assert.equal((await api('DELETE', `/partidos/${id}/eventos/ultimo`, org)).status, 204);
  assert.deepEqual(await score(), [4, 4], 'deshacer un triple descuenta 3');
  await ev({ tipo: 'PUNTO_1', lado: 'LOCAL', jugador_id: h[3] });
  const fin = await api('POST', `/partidos/${id}/finalizar`, org);
  assert.equal(fin.status, 200, JSON.stringify(fin.body));

  const tabla = (await api('GET', `/estadisticas/posiciones?torneo_id=${torneo.body.id}`)).body;
  assert.deepEqual(tabla.map((r) => [r.equipo_id, r.pts, r.pe]), [[home.id, 2, 0], [away.id, 1, 0]], 'FIBA: 2 por victoria, 1 por derrota');

  const anotadores = (await api('GET', `/estadisticas/goleadores?torneo_id=${torneo.body.id}`, org)).body;
  assert.equal(anotadores[0].jugador_id, a[0]);
  assert.equal(anotadores[0].total, 4);
  assert.equal(anotadores[0].promedio, 4);
  assert.equal(anotadores.find((r) => r.jugador_id === h[0]).triples, 1);
  assert.equal((await api('GET', `/estadisticas/asistencias?torneo_id=${torneo.body.id}`, org)).body[0].jugador_id, h[1]);
  assert.equal((await api('GET', `/estadisticas/rebotes?torneo_id=${torneo.body.id}`, org)).body[0].jugador_id, h[0]);
  const fair = (await api('GET', `/estadisticas/fair-play?torneo_id=${torneo.body.id}`, org)).body;
  assert.equal(fair.find((r) => r.equipo_id === away.id).faltas, 5);

  await api('POST', '/partidos', { ...org, body: { torneo_id: torneo.body.id, equipo_local: away.id, equipo_visita: home.id, fecha: '2026-04-11', hora: '19:00', cancha: 'Gimnasio' } });
  const pred = (await api('GET', `/estadisticas/predicciones?torneo_id=${torneo.body.id}`, org)).body;
  assert.equal(pred.length, 1);
  assert.equal(pred[0].modelo, 'normal-basquetbol-node');
  assert.equal(pred[0].empate, 0, 'en básquetbol no hay empate');
  assert.ok(Math.abs(pred[0].local + pred[0].visita - 1) < 1e-9);
});
