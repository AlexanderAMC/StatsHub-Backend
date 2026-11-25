const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const pool = require('../config/database');
const { audit } = require('../utils/audit');
const { notify } = require('../services/notifications.service');
const { badRequest, notFound, conflict, PG_ERRORS } = require('../utils/errors');
const { positiveInt, optionalPositiveInt, text, date } = require('../utils/http');
const { isLeagueManager, assertTournamentAccess, assertTeamAccess, forbidden } = require('../utils/scope');

const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads'));
const POSITIONS_MAX = 50;

// ===================== EQUIPOS (RF-12, RF-13, RF-14) =====================

const TEAM_SQL = `
  SELECT e.id, e.nombre, e.escudo_url, e.entrenador, e.entrenador_id, e.fecha_creacion,
         ins.torneo_id, ins.estado_inscripcion,
         COALESCE(ARRAY_AGG(te.torneo_id ORDER BY t.fecha_inicio DESC) FILTER (WHERE te.torneo_id IS NOT NULL), '{}') AS torneo_ids
  FROM deportivo.equipos e
  LEFT JOIN deportivo.torneo_equipos te ON te.equipo_id = e.id
  LEFT JOIN deportivo.torneos t ON t.id = te.torneo_id
  LEFT JOIN LATERAL (
      SELECT te2.torneo_id, te2.estado_inscripcion
      FROM deportivo.torneo_equipos te2 JOIN deportivo.torneos t2 ON t2.id = te2.torneo_id
      WHERE te2.equipo_id = e.id ORDER BY t2.fecha_inicio DESC LIMIT 1
  ) ins ON true`;

const listEquipos = async (req, res) => {
  const { rows } = await pool.query(`${TEAM_SQL} GROUP BY e.id, ins.torneo_id, ins.estado_inscripcion ORDER BY e.nombre`);
  res.json(rows);
};

async function getEquipo(id, db = pool) {
  const { rows } = await db.query(`${TEAM_SQL} WHERE e.id = $1 GROUP BY e.id, ins.torneo_id, ins.estado_inscripcion`, [id]);
  return rows[0] ?? null;
}

async function assertCupo(db, torneoId, equipoId = null) {
  const { rows } = await db.query(
    `SELECT t.estado, t.cupos,
            (SELECT COUNT(*)::int FROM deportivo.torneo_equipos te WHERE te.torneo_id = t.id AND te.equipo_id IS DISTINCT FROM $2) AS inscritos
     FROM deportivo.torneos t WHERE t.id = $1`,
    [torneoId, equipoId]
  );
  if (rows.length === 0) throw badRequest('El torneo no existe');
  const t = rows[0];
  if (['FINALIZADO', 'CANCELADO'].includes(t.estado)) throw conflict('No se pueden inscribir equipos en un torneo finalizado o cancelado');
  if (t.inscritos >= t.cupos) throw conflict(`El torneo no tiene cupos disponibles (${t.cupos})`);
}

// Vincula la cuenta del entrenador por su correo: undefined = no cambia, '' = quitar.
async function resolveCoach(value, db = pool) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const { rows } = await db.query('SELECT id FROM seguridad.usuarios WHERE LOWER(correo) = LOWER($1) AND activo', [String(value).trim()]);
  if (rows.length === 0) throw badRequest('No existe una cuenta activa con el correo del entrenador');
  return rows[0].id;
}

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

const createEquipo = async (req, res) => {
  const nombre = text(req.body?.nombre, 'El nombre del equipo', { max: 150 });
  const torneoId = positiveInt(req.body?.torneo_id, 'El torneo');
  const entrenador = text(req.body?.entrenador, 'El entrenador', { max: 150, required: false });
  await assertTournamentAccess(req, torneoId);
  const entrenadorId = await resolveCoach(req.body?.entrenador_correo);

  try {
    const id = await withTransaction(async (db) => {
      await assertCupo(db, torneoId);
      const { rows } = await db.query(
        'INSERT INTO deportivo.equipos (nombre, entrenador, entrenador_id) VALUES ($1, $2, $3) RETURNING id',
        [nombre, entrenador, entrenadorId ?? null]
      );
      await db.query('INSERT INTO deportivo.torneo_equipos (torneo_id, equipo_id) VALUES ($1, $2)', [torneoId, rows[0].id]);
      return rows[0].id;
    });
    audit(req, { accion: 'CREAR_EQUIPO', tabla: 'deportivo.equipos', registroId: id, detalle: { nombre, torneoId } });
    res.status(201).json(await getEquipo(id));
  } catch (error) {
    if (error.code === PG_ERRORS.UNIQUE_VIOLATION) throw conflict('Ya existe un equipo con ese nombre');
    throw error;
  }
};

const updateEquipo = async (req, res) => {
  const id = positiveInt(req.params.id, 'El id');
  const nombre = text(req.body?.nombre, 'El nombre del equipo', { max: 150 });
  const torneoId = positiveInt(req.body?.torneo_id, 'El torneo');
  const entrenador = text(req.body?.entrenador, 'El entrenador', { max: 150, required: false });

  const actual = await getEquipo(id);
  if (!actual) throw notFound('Equipo no encontrado');
  await assertTeamAccess(req, id);
  if (actual.torneo_id !== torneoId) await assertTournamentAccess(req, torneoId);
  const entrenadorId = await resolveCoach(req.body?.entrenador_correo);

  try {
    await withTransaction(async (db) => {
      await db.query(
        'UPDATE deportivo.equipos SET nombre = $1, entrenador = $2, entrenador_id = COALESCE($4, entrenador_id) WHERE id = $3',
        [nombre, entrenador, id, entrenadorId === undefined ? null : entrenadorId]
      );
      if (entrenadorId === null) await db.query('UPDATE deportivo.equipos SET entrenador_id = NULL WHERE id = $1', [id]);
      if (actual.torneo_id !== torneoId) {
        await assertCupo(db, torneoId, id);
        await db.query(
          `INSERT INTO deportivo.torneo_equipos (torneo_id, equipo_id) VALUES ($1, $2) ON CONFLICT (torneo_id, equipo_id) DO NOTHING`,
          [torneoId, id]
        );
        // Se desvincula del torneo anterior solo si todavía no jugó ni tiene partidos programados en él.
        if (actual.torneo_id) {
          await db.query(
            `DELETE FROM deportivo.torneo_equipos te
             WHERE te.torneo_id = $1 AND te.equipo_id = $2
               AND NOT EXISTS (SELECT 1 FROM deportivo.partidos p WHERE p.torneo_id = $1 AND $2 IN (p.equipo_local, p.equipo_visita))`,
            [actual.torneo_id, id]
          );
        }
      }
    });
    audit(req, { accion: 'EDITAR_EQUIPO', tabla: 'deportivo.equipos', registroId: id });
    res.json(await getEquipo(id));
  } catch (error) {
    if (error.code === PG_ERRORS.UNIQUE_VIOLATION) throw conflict('Ya existe un equipo con ese nombre');
    throw error;
  }
};

const deleteEquipo = async (req, res) => {
  const id = positiveInt(req.params.id, 'El id');
  await assertTeamAccess(req, id);
  try {
    const { rows } = await pool.query('DELETE FROM deportivo.equipos WHERE id = $1 RETURNING escudo_url', [id]);
    if (rows.length === 0) throw notFound('Equipo no encontrado');
    await removeLogoFile(rows[0].escudo_url);
    audit(req, { accion: 'ELIMINAR_EQUIPO', tabla: 'deportivo.equipos', registroId: id });
    res.status(204).end();
  } catch (error) {
    if (error.code === PG_ERRORS.FOREIGN_KEY_VIOLATION) throw conflict('El equipo tiene partidos registrados y no se puede eliminar');
    throw error;
  }
};

async function removeLogoFile(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  const file = path.join(UPLOADS_DIR, url.replace('/uploads/', ''));
  if (!file.startsWith(UPLOADS_DIR)) return;
  await fs.unlink(file).catch(() => {});
}

// RF-13 / RNF-05: el escudo se recorta a 512x512 y se convierte a WebP (menor peso para redes móviles).
const uploadEscudo = async (req, res) => {
  const id = positiveInt(req.params.id, 'El id');
  if (!req.file) throw badRequest('Adjunta una imagen en el campo "escudo"');
  await assertTeamAccess(req, id);
  const actual = await getEquipo(id);
  if (!actual) throw notFound('Equipo no encontrado');

  let webp;
  try {
    webp = await sharp(req.file.buffer, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw badRequest('El archivo no es una imagen válida');
  }

  const dir = path.join(UPLOADS_DIR, 'equipos');
  await fs.mkdir(dir, { recursive: true });
  const fileName = `${id}-${Date.now()}.webp`;
  await fs.writeFile(path.join(dir, fileName), webp);
  const url = `/uploads/equipos/${fileName}`;
  await pool.query('UPDATE deportivo.equipos SET escudo_url = $1 WHERE id = $2', [url, id]);
  await removeLogoFile(actual.escudo_url);
  audit(req, { accion: 'SUBIR_ESCUDO', tabla: 'deportivo.equipos', registroId: id, detalle: { bytes: webp.length } });
  res.json(await getEquipo(id));
};

// ===================== JUGADORES (RF-15, RF-16) =====================

const PLAYER_SQL = `
  SELECT j.id, j.nombre, j.numero, j.posicion, j.fecha_nacimiento, j.rut, ej.equipo_id
  FROM deportivo.jugadores j
  LEFT JOIN deportivo.equipo_jugador ej ON ej.jugador_id = j.id AND ej.activo`;

const listJugadores = async (req, res) => {
  const { rows } = await pool.query(`${PLAYER_SQL} ORDER BY j.nombre`);
  res.json(rows);
};

async function getJugador(id, db = pool) {
  const { rows } = await db.query(`${PLAYER_SQL} WHERE j.id = $1`, [id]);
  return rows[0] ?? null;
}

// Un entrenador solo puede gestionar el plantel de su propio equipo.
async function assertCanManageTeam(req, equipoId, db = pool) {
  // Jugadores sin equipo: solo la administración de la liga.
  if (equipoId === null) {
    if (!isLeagueManager(req.user)) throw forbidden('Indica el equipo del jugador');
    return;
  }
  // Dueño del torneo del equipo o su entrenador (rol entrenador o plan Pro).
  await assertTeamAccess(req, equipoId, db, { allowCoach: true });
}

async function assertNumeroLibre(db, equipoId, numero, jugadorId = null) {
  if (equipoId === null || numero === null) return;
  const { rows } = await db.query(
    `SELECT j.nombre FROM deportivo.jugadores j
     JOIN deportivo.equipo_jugador ej ON ej.jugador_id = j.id AND ej.activo
     WHERE ej.equipo_id = $1 AND j.numero = $2 AND j.id IS DISTINCT FROM $3`,
    [equipoId, numero, jugadorId]
  );
  if (rows.length > 0) throw conflict(`El número ${numero} ya lo usa ${rows[0].nombre} en este equipo`);
}

// RF-16: la edad del jugador al inicio del torneo debe estar dentro del rango de la categoría.
async function assertEdadCategoria(db, equipoId, fechaNacimiento) {
  if (equipoId === null || !fechaNacimiento) return;
  const { rows } = await db.query(
    `SELECT c.nombre, c.edad_min, c.edad_max,
            DATE_PART('year', AGE(t.fecha_inicio, $2::date))::int AS edad
     FROM deportivo.torneo_equipos te
     JOIN deportivo.torneos t ON t.id = te.torneo_id
     JOIN deportivo.categorias c ON c.id = t.categoria_id
     WHERE te.equipo_id = $1 AND t.estado NOT IN ('FINALIZADO', 'CANCELADO')`,
    [equipoId, fechaNacimiento]
  );
  for (const r of rows) {
    if ((r.edad_min !== null && r.edad < r.edad_min) || (r.edad_max !== null && r.edad > r.edad_max)) {
      const rango = [r.edad_min !== null ? `desde ${r.edad_min}` : null, r.edad_max !== null ? `hasta ${r.edad_max}` : null].filter(Boolean).join(' ');
      throw badRequest(`El jugador tendría ${r.edad} años y la categoría ${r.nombre} admite ${rango} años`);
    }
  }
}

function parseJugador(body) {
  const nombre = text(body.nombre, 'El nombre del jugador', { max: 150 });
  let numero = null;
  if (body.numero !== undefined && body.numero !== null && body.numero !== '') {
    numero = Number(body.numero);
    if (!Number.isInteger(numero) || numero < 1 || numero > 99) throw badRequest('El número debe estar entre 1 y 99');
  }
  const posicion = text(body.posicion, 'La posición', { max: POSITIONS_MAX, required: false });
  const fechaNacimiento = date(body.fecha_nacimiento, 'La fecha de nacimiento', { required: false });
  if (fechaNacimiento && fechaNacimiento > new Date().toISOString().slice(0, 10)) throw badRequest('La fecha de nacimiento no puede ser futura');
  const rut = text(body.rut, 'El RUT', { max: 20, required: false });
  return { nombre, numero, posicion, fechaNacimiento, rut };
}

const createJugador = async (req, res) => {
  const j = parseJugador(req.body ?? {});
  const equipoId = optionalPositiveInt(req.body?.equipo_id, 'El equipo');
  try {
    const id = await withTransaction(async (db) => {
      await assertCanManageTeam(req, equipoId, db);
      await assertNumeroLibre(db, equipoId, j.numero);
      await assertEdadCategoria(db, equipoId, j.fechaNacimiento);
      const { rows } = await db.query(
        `INSERT INTO deportivo.jugadores (nombre, numero, posicion, fecha_nacimiento, rut)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [j.nombre, j.numero, j.posicion, j.fechaNacimiento, j.rut]
      );
      if (equipoId !== null) {
        await db.query(
          'INSERT INTO deportivo.equipo_jugador (equipo_id, jugador_id, fecha_desde) VALUES ($1, $2, CURRENT_DATE)',
          [equipoId, rows[0].id]
        );
      }
      return rows[0].id;
    });
    audit(req, { accion: 'CREAR_JUGADOR', tabla: 'deportivo.jugadores', registroId: id, detalle: { equipoId } });
    res.status(201).json(await getJugador(id));
  } catch (error) {
    if (error.code === PG_ERRORS.UNIQUE_VIOLATION) throw conflict('Ya existe un jugador con ese RUT');
    if (error.code === PG_ERRORS.FOREIGN_KEY_VIOLATION) throw badRequest('El equipo no existe');
    throw error;
  }
};

const updateJugador = async (req, res) => {
  const id = positiveInt(req.params.id, 'El id');
  const actual = await getJugador(id);
  if (!actual) throw notFound('Jugador no encontrado');
  const j = parseJugador(req.body ?? {});
  try {
    await withTransaction(async (db) => {
      await assertCanManageTeam(req, actual.equipo_id, db);
      await assertNumeroLibre(db, actual.equipo_id, j.numero, id);
      await assertEdadCategoria(db, actual.equipo_id, j.fechaNacimiento);
      await db.query(
        'UPDATE deportivo.jugadores SET nombre = $1, numero = $2, posicion = $3, fecha_nacimiento = $4, rut = $5 WHERE id = $6',
        [j.nombre, j.numero, j.posicion, j.fechaNacimiento, j.rut, id]
      );
    });
    audit(req, { accion: 'EDITAR_JUGADOR', tabla: 'deportivo.jugadores', registroId: id });
    res.json(await getJugador(id));
  } catch (error) {
    if (error.code === PG_ERRORS.UNIQUE_VIOLATION) throw conflict('Ya existe un jugador con ese RUT');
    throw error;
  }
};

const deleteJugador = async (req, res) => {
  const id = positiveInt(req.params.id, 'El id');
  const actual = await getJugador(id);
  if (!actual) throw notFound('Jugador no encontrado');
  await assertCanManageTeam(req, actual.equipo_id);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM deportivo.eventos_partido
     WHERE $1 IN (jugador_id, asistencia_jugador_id, relacionado_jugador_id)`,
    [id]
  );
  if (rows[0].n > 0) throw conflict('El jugador tiene eventos registrados en actas: transfiérelo a "Sin equipo" en vez de eliminarlo');
  await pool.query('DELETE FROM deportivo.jugadores WHERE id = $1', [id]);
  audit(req, { accion: 'ELIMINAR_JUGADOR', tabla: 'deportivo.jugadores', registroId: id });
  res.status(204).end();
};

// ===================== TRANSFERENCIAS (RF-17) =====================

const listTransferencias = async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, jugador_id, desde_equipo_id, hacia_equipo_id, fecha FROM deportivo.transferencias ORDER BY fecha DESC, id DESC'
  );
  res.json(rows);
};

const transferJugador = async (req, res) => {
  const id = positiveInt(req.params.id, 'El id');
  const destino = optionalPositiveInt(req.body?.equipo_id, 'El equipo de destino');
  const jugador = await getJugador(id);
  if (!jugador) throw notFound('Jugador no encontrado');
  if (jugador.equipo_id === destino) throw badRequest('El jugador ya pertenece a ese equipo');
  if (jugador.equipo_id !== null) await assertTeamAccess(req, jugador.equipo_id);
  if (destino !== null) await assertTeamAccess(req, destino);
  if (jugador.equipo_id === null && destino === null) throw badRequest('Indica el equipo de destino');

  await withTransaction(async (db) => {
    await assertNumeroLibre(db, destino, jugador.numero, id);
    await assertEdadCategoria(db, destino, jugador.fecha_nacimiento?.toISOString?.().slice(0, 10) ?? jugador.fecha_nacimiento);
    await db.query(
      `UPDATE deportivo.equipo_jugador SET activo = false, fecha_hasta = GREATEST(CURRENT_DATE, fecha_desde)
       WHERE jugador_id = $1 AND activo`,
      [id]
    );
    if (destino !== null) {
      await db.query(
        'INSERT INTO deportivo.equipo_jugador (equipo_id, jugador_id, fecha_desde) VALUES ($1, $2, CURRENT_DATE)',
        [destino, id]
      );
    }
    await db.query(
      `INSERT INTO deportivo.transferencias (jugador_id, desde_equipo_id, hacia_equipo_id, registrado_por)
       VALUES ($1, $2, $3, $4)`,
      [id, jugador.equipo_id, destino, req.user.id]
    );
  });

  const names = await pool.query(
    'SELECT id, nombre FROM deportivo.equipos WHERE id = ANY($1::int[])',
    [[jugador.equipo_id, destino].filter(Boolean)]
  );
  const nameOf = (equipoId) => names.rows.find((r) => r.id === equipoId)?.nombre ?? 'Sin equipo';
  notify({
    tipo: 'transferencia',
    titulo: 'Transferencia de jugador',
    mensaje: `${jugador.nombre}: ${nameOf(jugador.equipo_id)} → ${nameOf(destino)}`,
  });
  audit(req, { accion: 'TRANSFERIR_JUGADOR', tabla: 'deportivo.jugadores', registroId: id, detalle: { desde: jugador.equipo_id, hacia: destino } });
  res.json(await getJugador(id));
};

module.exports = {
  UPLOADS_DIR,
  listEquipos, createEquipo, updateEquipo, deleteEquipo, uploadEscudo,
  listJugadores, createJugador, updateJugador, deleteJugador,
  listTransferencias, transferJugador,
};
