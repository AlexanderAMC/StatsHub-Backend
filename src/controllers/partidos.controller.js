const pool = require('../config/database');
const { audit } = require('../utils/audit');
const { notify } = require('../services/notifications.service');
const { broadcast } = require('../realtime/hub');
const { badRequest, notFound, conflict, AppError } = require('../utils/errors');
const { positiveInt, text, date, time } = require('../utils/http');
const { ROLES } = require('../config/roles');
const { isUuid } = require('../utils/validators');

const MAX_SUBSTITUTIONS = 5;
const MAX_MINUTE = 130;
const EVENT_TYPES = ['GOL', 'AMARILLA', 'ROJA', 'SUSTITUCION', 'LESION'];
const SIDES = { LOCAL: 'home', VISITA: 'away' };
const DOUBLE_YELLOW = 'DOBLE_AMARILLA';

const MATCH_SQL = `
  SELECT p.id, p.torneo_id, p.jornada, p.equipo_local, p.equipo_visita, p.fecha_partido, p.cancha, p.estado,
         p.arbitro_id, p.estadigrafo_id, p.minuto, p.alineacion, p.iniciado_en, p.acta_cerrada_en,
         el.nombre AS equipo_local_nombre, ev.nombre AS equipo_visita_nombre,
         COALESCE(r.goles_local, 0) AS goles_local, COALESCE(r.goles_visita, 0) AS goles_visita
  FROM deportivo.partidos p
  JOIN deportivo.equipos el ON p.equipo_local = el.id
  JOIN deportivo.equipos ev ON p.equipo_visita = ev.id
  LEFT JOIN deportivo.resultados r ON p.id = r.partido_id`;

const EVENT_SQL = `
  SELECT id, partido_id, jugador_id, asistencia_jugador_id, relacionado_jugador_id, tipo_evento, lado, minuto,
         descripcion, creado_en
  FROM deportivo.eventos_partido`;

const listPartidos = async (req, res) => {
  const { rows } = await pool.query(`${MATCH_SQL} ORDER BY p.fecha_partido DESC NULLS LAST, p.id DESC`);
  res.json(rows);
};

async function getPartido(id, db = pool, { lock = false } = {}) {
  const { rows } = await db.query(
    lock ? 'SELECT * FROM deportivo.partidos WHERE id = $1 FOR UPDATE' : `${MATCH_SQL} WHERE p.id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

const listEventos = async (req, res) => {
  const partidoId = req.query.partido_id ? positiveInt(req.query.partido_id, 'El partido') : null;
  const { rows } = partidoId
    ? await pool.query(`${EVENT_SQL} WHERE partido_id = $1 ORDER BY minuto, id`, [partidoId])
    : await pool.query(`${EVENT_SQL} ORDER BY partido_id, minuto, id`);
  res.json(rows);
};

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const changed = (id) => broadcast('partido', { id });

// ===================== PROGRAMACIÓN (RF-18, RF-19, RF-20) =====================

function optionalUserId(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (!isUuid(String(value))) throw badRequest(`${field} inválido`);
  return String(value);
}

function parsePartido(body) {
  const torneoId = positiveInt(body.torneo_id, 'El torneo');
  const jornada = positiveInt(body.jornada ?? 1, 'La jornada');
  const local = positiveInt(body.equipo_local, 'El equipo local');
  const visita = positiveInt(body.equipo_visita, 'El equipo visita');
  if (local === visita) throw badRequest('Los equipos deben ser distintos');
  const fecha = date(body.fecha, 'La fecha del partido');
  const hora = time(body.hora, 'La hora del partido');
  const cancha = text(body.cancha, 'La cancha', { max: 200 });
  return {
    torneoId, jornada, local, visita, fechaHora: `${fecha} ${hora}:00`, cancha,
    arbitroId: optionalUserId(body.arbitro_id, 'El árbitro'),
    estadigrafoId: optionalUserId(body.estadigrafo_id, 'El estadígrafo'),
  };
}

async function validateSchedule(db, p, ignoreId = null) {
  const torneo = await db.query('SELECT estado FROM deportivo.torneos WHERE id = $1', [p.torneoId]);
  if (torneo.rows.length === 0) throw badRequest('El torneo no existe');
  if (['FINALIZADO', 'CANCELADO'].includes(torneo.rows[0].estado)) throw conflict('El torneo está finalizado o cancelado');

  const inscritos = await db.query(
    'SELECT equipo_id FROM deportivo.torneo_equipos WHERE torneo_id = $1 AND equipo_id = ANY($2::int[])',
    [p.torneoId, [p.local, p.visita]]
  );
  if (inscritos.rows.length !== 2) throw badRequest('Ambos equipos deben estar inscritos en el torneo');

  const choque = await db.query(
    `SELECT id FROM deportivo.partidos
     WHERE fecha_partido = $1 AND estado IN ('PROGRAMADO', 'EN_CURSO') AND id IS DISTINCT FROM $2
       AND (equipo_local = ANY($3::int[]) OR equipo_visita = ANY($3::int[])
            OR ($4::uuid IS NOT NULL AND arbitro_id = $4::uuid))
     LIMIT 1`,
    [p.fechaHora, ignoreId, [p.local, p.visita], p.arbitroId]
  );
  if (choque.rows.length > 0) throw conflict('Uno de los equipos o el árbitro ya tiene un partido a esa hora');

  for (const [userId, role, label] of [[p.arbitroId, ROLES.REFEREE, 'árbitro'], [p.estadigrafoId, ROLES.STATS, 'estadígrafo']]) {
    if (!userId) continue;
    const { rows } = await db.query(
      `SELECT 1 FROM seguridad.usuarios u JOIN seguridad.roles r ON r.id = u.rol_id
       WHERE u.id = $1 AND u.activo AND UPPER(r.nombre) = $2`,
      [userId, role]
    );
    if (rows.length === 0) throw badRequest(`El ${label} seleccionado no existe o no tiene ese rol`);
  }
}

async function insertPartido(db, p) {
  const { rows } = await db.query(
    `INSERT INTO deportivo.partidos (torneo_id, jornada, equipo_local, equipo_visita, fecha_partido, cancha, arbitro_id, estadigrafo_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [p.torneoId, p.jornada, p.local, p.visita, p.fechaHora, p.cancha, p.arbitroId, p.estadigrafoId]
  );
  return rows[0].id;
}

const matchLabel = (m) => `${m.equipo_local_nombre} vs ${m.equipo_visita_nombre}`;
const whenLabel = (m) => (m.fecha_partido ? m.fecha_partido.replace('T', ' ').slice(0, 16) : 'fecha por definir');

const createPartido = async (req, res) => {
  const p = parsePartido(req.body ?? {});
  const id = await withTransaction(async (db) => {
    await validateSchedule(db, p);
    return insertPartido(db, p);
  });
  const partido = await getPartido(id);
  notify({ tipo: 'programacion', titulo: 'Partido programado', mensaje: `${matchLabel(partido)} · ${whenLabel(partido)} · ${partido.cancha}`, partidoId: id });
  audit(req, { accion: 'PROGRAMAR_PARTIDO', tabla: 'deportivo.partidos', registroId: id });
  changed(id);
  res.status(201).json(partido);
};

// Fixture (RF-18): el frontend calcula el "todos contra todos" y el servidor lo valida y guarda en una transacción.
const createPartidosLote = async (req, res) => {
  const list = req.body?.partidos;
  if (!Array.isArray(list) || list.length === 0 || list.length > 500) throw badRequest('Envía entre 1 y 500 partidos');
  const parsed = list.map(parsePartido);
  const ids = await withTransaction(async (db) => {
    const created = [];
    for (const p of parsed) {
      await validateSchedule(db, p);
      created.push(await insertPartido(db, p));
    }
    return created;
  });
  notify({ tipo: 'programacion', titulo: 'Fixture generado', mensaje: `Se programaron ${ids.length} partidos. Revisa el calendario.` });
  audit(req, { accion: 'GENERAR_FIXTURE', tabla: 'deportivo.partidos', detalle: { cantidad: ids.length, torneoId: parsed[0].torneoId } });
  broadcast('partido', { ids });
  res.status(201).json({ creados: ids.length, ids });
};

const updatePartido = async (req, res) => {
  const id = positiveInt(req.params.id, 'El id');
  const actual = await getPartido(id);
  if (!actual) throw notFound('Partido no encontrado');
  if (actual.estado !== 'PROGRAMADO') throw conflict('Solo se pueden modificar partidos programados');
  // El torneo no cambia al editar.
  const p = parsePartido({ ...req.body, torneo_id: actual.torneo_id });
  await withTransaction(async (db) => {
    await validateSchedule(db, p, id);
    await db.query(
      `UPDATE deportivo.partidos
       SET jornada = $1, equipo_local = $2, equipo_visita = $3, fecha_partido = $4, cancha = $5,
           arbitro_id = $6, estadigrafo_id = $7, actualizado_en = now()
       WHERE id = $8`,
      [p.jornada, p.local, p.visita, p.fechaHora, p.cancha, p.arbitroId, p.estadigrafoId, id]
    );
  });
  const partido = await getPartido(id);
  notify({ tipo: 'cambio', titulo: 'Cambio de programación', mensaje: `${matchLabel(partido)} ahora es ${whenLabel(partido)} en ${partido.cancha}`, partidoId: id });
  audit(req, { accion: 'REPROGRAMAR_PARTIDO', tabla: 'deportivo.partidos', registroId: id });
  changed(id);
  res.json(partido);
};

const suspenderPartido = async (req, res) => {
  const id = positiveInt(req.params.id, 'El id');
  const actual = await getPartido(id);
  if (!actual) throw notFound('Partido no encontrado');
  if (actual.estado !== 'PROGRAMADO') throw conflict('Solo se pueden suspender partidos programados');
  await pool.query(`UPDATE deportivo.partidos SET estado = 'SUSPENDIDO', actualizado_en = now() WHERE id = $1`, [id]);
  notify({ tipo: 'cambio', titulo: 'Partido suspendido', mensaje: `${matchLabel(actual)} (${whenLabel(actual)}) fue suspendido`, partidoId: id });
  audit(req, { accion: 'SUSPENDER_PARTIDO', tabla: 'deportivo.partidos', registroId: id });
  changed(id);
  res.json(await getPartido(id));
};

const recordatorioPartido = async (req, res) => {
  const id = positiveInt(req.params.id, 'El id');
  const actual = await getPartido(id);
  if (!actual) throw notFound('Partido no encontrado');
  if (actual.estado !== 'PROGRAMADO') throw conflict('Solo se envían recordatorios de partidos programados');
  await notify({ tipo: 'recordatorio', titulo: 'Recordatorio de partido', mensaje: `${matchLabel(actual)} · ${whenLabel(actual)} · ${actual.cancha}`, partidoId: id });
  res.json({ mensaje: 'Recordatorio enviado' });
};

// ===================== ACTA DIGITAL (RF-21 a RF-31) =====================

// RF-21: estadígrafos y árbitros solo operan el acta del día y de los partidos que tienen asignados.
// Organizadores y administradores pueden hacerlo siempre (correcciones, partidos atrasados).
function assertActaAccess(req, partido) {
  const operator = [ROLES.STATS, ROLES.REFEREE].includes(req.user.rol);
  if (!operator) return;
  const assigned = [partido.arbitro_id, partido.estadigrafo_id].filter(Boolean);
  if (assigned.length > 0 && !assigned.includes(req.user.id)) {
    throw new AppError(403, 'Este partido está asignado a otro árbitro o estadígrafo');
  }
}

function assertMatchDay(req, partido) {
  if (![ROLES.STATS, ROLES.REFEREE].includes(req.user.rol) || !partido.fecha_partido) return;
  const day = String(partido.fecha_partido).slice(0, 10);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ_LIGA || 'America/Santiago' });
  if (day > today) throw conflict('El acta solo se puede abrir el día del partido');
}

function assertLive(partido) {
  if (partido.acta_cerrada_en) throw conflict('El acta está cerrada y no admite cambios');
  if (partido.estado !== 'EN_CURSO') throw conflict('El partido no está en curso');
}

async function rosterIds(db, equipoId) {
  const { rows } = await db.query('SELECT jugador_id FROM deportivo.equipo_jugador WHERE equipo_id = $1 AND activo', [equipoId]);
  return rows.map((r) => r.jugador_id);
}

function parseIdList(value, field) {
  if (!Array.isArray(value)) throw badRequest(`${field} debe ser una lista`);
  const ids = [...new Set(value.map((v) => Number(v)))];
  if (ids.some((n) => !Number.isInteger(n) || n < 1)) throw badRequest(`${field} contiene ids inválidos`);
  return ids;
}

const iniciarPartido = async (req, res) => {
  const id = positiveInt(req.params.id, 'El id');
  const home = parseIdList(req.body?.alineacion?.home ?? [], 'La alineación local');
  const away = parseIdList(req.body?.alineacion?.away ?? [], 'La alineación visita');
  if (home.length === 0 || away.length === 0) throw badRequest('Cada equipo necesita al menos un jugador convocado');

  await withTransaction(async (db) => {
    const partido = await getPartido(id, db, { lock: true });
    if (!partido) throw notFound('Partido no encontrado');
    if (partido.estado !== 'PROGRAMADO') throw conflict('Solo se pueden iniciar partidos programados');
    assertActaAccess(req, partido);
    assertMatchDay(req, partido);
    const [rosterHome, rosterAway] = await Promise.all([rosterIds(db, partido.equipo_local), rosterIds(db, partido.equipo_visita)]);
    if (!home.every((j) => rosterHome.includes(j)) || !away.every((j) => rosterAway.includes(j))) {
      throw badRequest('La convocatoria incluye jugadores que no pertenecen al equipo');
    }
    await db.query(
      `UPDATE deportivo.partidos
       SET estado = 'EN_CURSO', minuto = 0, alineacion = $1, iniciado_en = now(), actualizado_en = now()
       WHERE id = $2`,
      [JSON.stringify({ home, away }), id]
    );
    await db.query(
      `INSERT INTO deportivo.resultados (partido_id, goles_local, goles_visita, registrado_por)
       VALUES ($1, 0, 0, $2)
       ON CONFLICT (partido_id) DO UPDATE SET goles_local = 0, goles_visita = 0, registrado_por = EXCLUDED.registrado_por`,
      [id, req.user.id]
    );
  });
  audit(req, { accion: 'ABRIR_ACTA', tabla: 'deportivo.partidos', registroId: id });
  changed(id);
  res.json(await getPartido(id));
};

const setMinuto = async (req, res) => {
  const id = positiveInt(req.params.id, 'El id');
  const minuto = Number(req.body?.minuto);
  if (!Number.isInteger(minuto) || minuto < 0 || minuto > MAX_MINUTE) throw badRequest(`El minuto debe estar entre 0 y ${MAX_MINUTE}`);
  const partido = await getPartido(id);
  if (!partido) throw notFound('Partido no encontrado');
  assertLive(partido);
  assertActaAccess(req, partido);
  await pool.query('UPDATE deportivo.partidos SET minuto = $1, actualizado_en = now() WHERE id = $2', [minuto, id]);
  changed(id);
  res.json({ id, minuto });
};

// Estado del partido según los eventos ya registrados: quién está en cancha, expulsados, amarillas y cambios.
async function matchState(db, partido) {
  const { rows: events } = await db.query(`${EVENT_SQL} WHERE partido_id = $1 ORDER BY minuto, id`, [partido.id]);
  const lineup = partido.alineacion ?? { home: [], away: [] };
  const state = {
    onField: { home: new Set(lineup.home), away: new Set(lineup.away) },
    used: { home: new Set(lineup.home), away: new Set(lineup.away) },
    subs: { home: 0, away: 0 },
    yellows: new Map(),
    sentOff: new Set(),
  };
  for (const e of events) {
    const side = SIDES[e.lado];
    if (!side) continue;
    if (e.tipo_evento === 'SUSTITUCION') {
      state.onField[side].delete(e.jugador_id);
      if (e.relacionado_jugador_id) {
        state.onField[side].add(e.relacionado_jugador_id);
        state.used[side].add(e.relacionado_jugador_id);
      }
      state.subs[side] += 1;
    } else if (e.tipo_evento === 'AMARILLA') {
      state.yellows.set(e.jugador_id, (state.yellows.get(e.jugador_id) ?? 0) + 1);
    } else if (e.tipo_evento === 'ROJA') {
      state.sentOff.add(e.jugador_id);
      state.onField[side].delete(e.jugador_id);
    }
  }
  return state;
}

const addEvento = async (req, res) => {
  const id = positiveInt(req.params.id, 'El id');
  const tipo = String(req.body?.tipo ?? '').toUpperCase();
  if (!EVENT_TYPES.includes(tipo)) throw badRequest('Tipo de evento inválido');
  const lado = String(req.body?.lado ?? '').toUpperCase();
  if (!SIDES[lado]) throw badRequest("El lado debe ser 'LOCAL' o 'VISITA'");
  const jugadorId = positiveInt(req.body?.jugador_id, 'El jugador');
  const asistenciaId = tipo === 'GOL' && req.body?.asistencia_id ? positiveInt(req.body.asistencia_id, 'El asistente') : null;
  const relacionadoId = tipo === 'SUSTITUCION' ? positiveInt(req.body?.relacionado_id, 'El jugador que entra') : null;

  const created = await withTransaction(async (db) => {
    const partido = await getPartido(id, db, { lock: true });
    if (!partido) throw notFound('Partido no encontrado');
    assertLive(partido);
    assertActaAccess(req, partido);
    const side = SIDES[lado];
    const equipoId = side === 'home' ? partido.equipo_local : partido.equipo_visita;
    const roster = await rosterIds(db, equipoId);
    const state = await matchState(db, partido);

    if (!roster.includes(jugadorId)) throw badRequest('El jugador no pertenece a ese equipo');
    if (state.sentOff.has(jugadorId)) throw conflict('El jugador fue expulsado y no puede registrar más eventos');
    if (tipo === 'SUSTITUCION') {
      if (!state.onField[side].has(jugadorId)) throw conflict('El jugador que sale no está en cancha');
      if (!roster.includes(relacionadoId)) throw badRequest('El jugador que entra no pertenece al equipo');
      if (state.used[side].has(relacionadoId)) throw conflict('El jugador que entra ya participó en el partido');
      if (state.subs[side] >= MAX_SUBSTITUTIONS) throw conflict(`Se alcanzó el máximo de ${MAX_SUBSTITUTIONS} sustituciones`);
    } else if (['GOL', 'AMARILLA', 'ROJA'].includes(tipo) && !state.onField[side].has(jugadorId)) {
      throw conflict('El jugador no está en cancha');
    }
    if (asistenciaId !== null) {
      if (asistenciaId === jugadorId) throw badRequest('El asistente debe ser otro jugador');
      if (!state.onField[side].has(asistenciaId)) throw conflict('El asistente no está en cancha');
    }

    const insert = async (tipoEvento, descripcion = null) => {
      const { rows } = await db.query(
        `INSERT INTO deportivo.eventos_partido
           (partido_id, jugador_id, asistencia_jugador_id, relacionado_jugador_id, tipo_evento, lado, minuto, descripcion, registrado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [id, jugadorId, tipoEvento === 'GOL' ? asistenciaId : null, tipoEvento === 'SUSTITUCION' ? relacionadoId : null,
          tipoEvento, lado, partido.minuto, descripcion, req.user.id]
      );
      return rows[0].id;
    };

    const ids = [await insert(tipo)];
    // RF-26: la segunda amarilla genera automáticamente la roja.
    if (tipo === 'AMARILLA' && (state.yellows.get(jugadorId) ?? 0) >= 1) ids.push(await insert('ROJA', DOUBLE_YELLOW));
    // RF-29: el marcador se actualiza con cada gol.
    if (tipo === 'GOL') {
      await db.query(
        `UPDATE deportivo.resultados SET ${side === 'home' ? 'goles_local = goles_local + 1' : 'goles_visita = goles_visita + 1'}
         WHERE partido_id = $1`,
        [id]
      );
    }
    await db.query('UPDATE deportivo.partidos SET actualizado_en = now() WHERE id = $1', [id]);
    return ids;
  });

  changed(id);
  const { rows } = await pool.query(`${EVENT_SQL} WHERE id = ANY($1::int[]) ORDER BY id`, [created]);
  res.status(201).json(rows);
};

const undoUltimoEvento = async (req, res) => {
  const id = positiveInt(req.params.id, 'El id');
  await withTransaction(async (db) => {
    const partido = await getPartido(id, db, { lock: true });
    if (!partido) throw notFound('Partido no encontrado');
    assertLive(partido);
    assertActaAccess(req, partido);
    const { rows } = await db.query(`${EVENT_SQL} WHERE partido_id = $1 ORDER BY id DESC LIMIT 2`, [id]);
    if (rows.length === 0) throw conflict('No hay eventos para deshacer');
    // Una roja por doble amarilla se deshace junto con la amarilla que la provocó.
    const toDelete = rows[0].descripcion === DOUBLE_YELLOW && rows[1] ? [rows[0], rows[1]] : [rows[0]];
    for (const e of toDelete) {
      await db.query('DELETE FROM deportivo.eventos_partido WHERE id = $1', [e.id]);
      if (e.tipo_evento === 'GOL') {
        const column = SIDES[e.lado] === 'home' ? 'goles_local' : 'goles_visita';
        await db.query(`UPDATE deportivo.resultados SET ${column} = GREATEST(${column} - 1, 0) WHERE partido_id = $1`, [id]);
      }
    }
  });
  changed(id);
  res.status(204).end();
};

// RF-30 / HU-08: cierre oficial e irreversible del acta.
const finalizarPartido = async (req, res) => {
  const id = positiveInt(req.params.id, 'El id');
  await withTransaction(async (db) => {
    const partido = await getPartido(id, db, { lock: true });
    if (!partido) throw notFound('Partido no encontrado');
    assertLive(partido);
    assertActaAccess(req, partido);
    await db.query(
      `UPDATE deportivo.partidos
       SET estado = 'FINALIZADO', acta_cerrada_en = now(), acta_cerrada_por = $1, actualizado_en = now()
       WHERE id = $2`,
      [req.user.id, id]
    );
  });
  const partido = await getPartido(id);
  const resultado = `${partido.equipo_local_nombre} ${partido.goles_local} - ${partido.goles_visita} ${partido.equipo_visita_nombre}`;
  notify({ tipo: 'resultado', titulo: 'Resultado final', mensaje: resultado, partidoId: id });
  // RF-31: se avisa al árbitro para que revise y valide el acta.
  if (partido.arbitro_id && partido.arbitro_id !== req.user.id) {
    notify({ tipo: 'acta', titulo: 'Acta cerrada: revisa y valida', mensaje: resultado, usuarioId: partido.arbitro_id, partidoId: id });
  }
  audit(req, { accion: 'CERRAR_ACTA', tabla: 'deportivo.partidos', registroId: id, detalle: { resultado } });
  changed(id);
  res.json(partido);
};

module.exports = {
  listPartidos, getPartido, listEventos,
  createPartido, createPartidosLote, updatePartido, suspenderPartido, recordatorioPartido,
  iniciarPartido, setMinuto, addEvento, undoUltimoEvento, finalizarPartido,
};
