const pool = require('../config/database');
const { audit } = require('../utils/audit');
const { badRequest, notFound, conflict, PG_ERRORS } = require('../utils/errors');
const { positiveInt, text, date, oneOf } = require('../utils/http');
const { ROLES } = require('../config/roles');
const { isLeagueManager, assertTournamentAccess, forbidden } = require('../utils/scope');

const TOURNAMENT_STATES = ['PLANIFICADO', 'INSCRIPCIONES', 'ACTIVO', 'FINALIZADO', 'CANCELADO'];
const FORMATS = ['LIGA', 'COPA', 'LIGA_Y_PLAYOFF'];

// ===================== LIGA (RF-07) =====================

const getLiga = async (req, res) => {
  const { rows } = await pool.query(
    'SELECT nombre, descripcion, correo_contacto, telefono, recintos, costo_inscripcion, actualizado_en FROM deportivo.liga WHERE id = 1'
  );
  res.json(rows[0] ?? null);
};

const updateLiga = async (req, res) => {
  if (!isLeagueManager(req.user)) throw forbidden('Solo la administración de la liga puede editar sus datos');
  const b = req.body ?? {};
  const nombre = text(b.nombre, 'El nombre de la liga', { max: 200 });
  const descripcion = text(b.descripcion, 'La descripción', { max: 2000, required: false });
  const correo = text(b.correo_contacto, 'El correo de contacto', { max: 255, required: false });
  const telefono = text(b.telefono, 'El teléfono', { max: 30, required: false });
  if (!Array.isArray(b.recintos) || b.recintos.length === 0 || b.recintos.length > 50) {
    throw badRequest('Indica entre 1 y 50 recintos deportivos');
  }
  const recintos = [...new Set(b.recintos.map((r) => text(r, 'Cada recinto', { max: 150 })))];
  const costo = Number(b.costo_inscripcion);
  if (!Number.isInteger(costo) || costo < 0) throw badRequest('El costo de inscripción debe ser un entero mayor o igual a 0');

  const { rows } = await pool.query(
    `UPDATE deportivo.liga
     SET nombre = $1, descripcion = $2, correo_contacto = $3, telefono = $4, recintos = $5,
         costo_inscripcion = $6, actualizado_en = now()
     WHERE id = 1
     RETURNING nombre, descripcion, correo_contacto, telefono, recintos, costo_inscripcion, actualizado_en`,
    [nombre, descripcion, correo, telefono, recintos, costo]
  );
  audit(req, { accion: 'ACTUALIZAR_LIGA', tabla: 'deportivo.liga', registroId: 1 });
  res.json(rows[0]);
};

// ===================== CATEGORÍAS (RF-10) =====================

const listCategorias = async (req, res) => {
  const { rows } = await pool.query('SELECT id, nombre, edad_min, edad_max FROM deportivo.categorias ORDER BY nombre');
  res.json(rows);
};

const optionalAge = (value, field) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100) throw badRequest(`${field} debe ser un entero entre 0 y 100`);
  return n;
};

const createCategoria = async (req, res) => {
  const nombre = text(req.body?.nombre, 'El nombre de la categoría', { max: 100 });
  const edadMin = optionalAge(req.body?.edad_min, 'La edad mínima');
  const edadMax = optionalAge(req.body?.edad_max, 'La edad máxima');
  if (edadMin !== null && edadMax !== null && edadMax < edadMin) throw badRequest('La edad máxima debe ser mayor o igual a la mínima');
  try {
    const { rows } = await pool.query(
      'INSERT INTO deportivo.categorias (nombre, edad_min, edad_max) VALUES ($1, $2, $3) RETURNING id, nombre, edad_min, edad_max',
      [nombre, edadMin, edadMax]
    );
    audit(req, { accion: 'CREAR_CATEGORIA', tabla: 'deportivo.categorias', registroId: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (error) {
    if (error.code === PG_ERRORS.UNIQUE_VIOLATION) throw conflict('Ya existe esa categoría');
    throw error;
  }
};

const deleteCategoria = async (req, res) => {
  if (!isLeagueManager(req.user)) throw forbidden('Solo la administración de la liga puede eliminar categorías');
  const id = positiveInt(req.params.id, 'El id');
  try {
    const { rowCount } = await pool.query('DELETE FROM deportivo.categorias WHERE id = $1', [id]);
    if (rowCount === 0) throw notFound('Categoría no encontrada');
    audit(req, { accion: 'ELIMINAR_CATEGORIA', tabla: 'deportivo.categorias', registroId: id });
    res.status(204).end();
  } catch (error) {
    if (error.code === PG_ERRORS.FOREIGN_KEY_VIOLATION) throw conflict('La categoría está asignada a torneos y no se puede eliminar');
    throw error;
  }
};

// ===================== TORNEOS (RF-09, RF-11) =====================

const TOURNAMENT_SQL = `
  SELECT t.id, t.nombre, t.fecha_inicio, t.fecha_fin, t.estado, t.cupos, t.formato, t.costo_inscripcion, t.organizador_id,
         t.categoria_id, c.nombre AS categoria,
         COUNT(te.equipo_id)::int AS cantidad_equipos
  FROM deportivo.torneos t
  JOIN deportivo.categorias c ON t.categoria_id = c.id
  LEFT JOIN deportivo.torneo_equipos te ON te.torneo_id = t.id`;

const listTorneos = async (req, res) => {
  const { rows } = await pool.query(`${TOURNAMENT_SQL} GROUP BY t.id, c.nombre ORDER BY t.fecha_inicio DESC`);
  res.json(rows);
};

async function getTorneo(id, db = pool) {
  const { rows } = await db.query(`${TOURNAMENT_SQL} WHERE t.id = $1 GROUP BY t.id, c.nombre`, [id]);
  return rows[0] ?? null;
}

async function resolveCategoria(body) {
  if (body.categoria_id) return positiveInt(body.categoria_id, 'La categoría');
  const nombre = text(body.categoria, 'La categoría', { max: 100 });
  const { rows } = await pool.query('SELECT id FROM deportivo.categorias WHERE LOWER(nombre) = LOWER($1)', [nombre]);
  if (rows.length === 0) throw badRequest('La categoría no existe');
  return rows[0].id;
}

function parseTorneo(body) {
  const nombre = text(body.nombre, 'El nombre del torneo', { max: 200 });
  const fechaInicio = date(body.fecha_inicio, 'La fecha de inicio');
  const fechaFin = date(body.fecha_fin, 'La fecha de término', { required: false });
  if (fechaFin && fechaFin < fechaInicio) throw badRequest('La fecha de término debe ser posterior al inicio');
  const cupos = Number(body.cupos ?? 10);
  if (!Number.isInteger(cupos) || cupos < 2 || cupos > 64) throw badRequest('Los cupos deben estar entre 2 y 64');
  const estado = oneOf(body.estado ?? 'PLANIFICADO', TOURNAMENT_STATES, 'El estado');
  const formato = oneOf(body.formato ?? 'LIGA', FORMATS, 'El formato');
  let costo = null;
  if (body.costo_inscripcion !== undefined && body.costo_inscripcion !== null && body.costo_inscripcion !== '') {
    costo = Number(body.costo_inscripcion);
    if (!Number.isInteger(costo) || costo < 0) throw badRequest('El costo de inscripción debe ser un entero mayor o igual a 0');
  }
  return { nombre, fechaInicio, fechaFin, cupos, estado, formato, costo };
}

const createTorneo = async (req, res) => {
  const t = parseTorneo(req.body ?? {});
  const categoriaId = await resolveCategoria(req.body ?? {});
  try {
    const { rows } = await pool.query(
      `INSERT INTO deportivo.torneos (nombre, categoria_id, fecha_inicio, fecha_fin, estado, cupos, formato, costo_inscripcion, organizador_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      // Torneo de la liga (NULL) si lo crea la administración; si no, queda a nombre del organizador del plan Ultra.
      [t.nombre, categoriaId, t.fechaInicio, t.fechaFin, t.estado, t.cupos, t.formato, t.costo, isLeagueManager(req.user) ? null : req.user.id]
    );
    audit(req, { accion: 'CREAR_TORNEO', tabla: 'deportivo.torneos', registroId: rows[0].id, detalle: { nombre: t.nombre } });
    res.status(201).json(await getTorneo(rows[0].id));
  } catch (error) {
    if (error.code === PG_ERRORS.UNIQUE_VIOLATION) throw conflict('Ya existe un torneo con ese nombre');
    throw error;
  }
};

const updateTorneo = async (req, res) => {
  const id = positiveInt(req.params.id, 'El id');
  await assertTournamentAccess(req, id);
  const actual = await getTorneo(id);
  if (!actual) throw notFound('Torneo no encontrado');
  // RF-11: un torneo finalizado o cancelado ya no se modifica.
  if (['FINALIZADO', 'CANCELADO'].includes(actual.estado)) throw conflict(`El torneo está ${actual.estado.toLowerCase()} y no se puede editar`);

  const t = parseTorneo(req.body ?? {});
  const categoriaId = await resolveCategoria(req.body ?? {});
  if (t.cupos < actual.cantidad_equipos) throw conflict(`El torneo ya tiene ${actual.cantidad_equipos} equipos inscritos`);
  try {
    await pool.query(
      `UPDATE deportivo.torneos
       SET nombre = $1, categoria_id = $2, fecha_inicio = $3, fecha_fin = $4, estado = $5, cupos = $6, formato = $7, costo_inscripcion = $8
       WHERE id = $9`,
      [t.nombre, categoriaId, t.fechaInicio, t.fechaFin, t.estado, t.cupos, t.formato, t.costo, id]
    );
    audit(req, { accion: t.estado === 'CANCELADO' ? 'CANCELAR_TORNEO' : 'EDITAR_TORNEO', tabla: 'deportivo.torneos', registroId: id });
    res.json(await getTorneo(id));
  } catch (error) {
    if (error.code === PG_ERRORS.UNIQUE_VIOLATION) throw conflict('Ya existe un torneo con ese nombre');
    throw error;
  }
};

const deleteTorneo = async (req, res) => {
  const id = positiveInt(req.params.id, 'El id');
  await assertTournamentAccess(req, id);
  try {
    const { rowCount } = await pool.query('DELETE FROM deportivo.torneos WHERE id = $1', [id]);
    if (rowCount === 0) throw notFound('Torneo no encontrado');
    audit(req, { accion: 'ELIMINAR_TORNEO', tabla: 'deportivo.torneos', registroId: id });
    res.status(204).end();
  } catch (error) {
    if (error.code === PG_ERRORS.FOREIGN_KEY_VIOLATION) {
      throw conflict('El torneo tiene partidos registrados: cámbialo a "Cancelado" en vez de eliminarlo');
    }
    throw error;
  }
};

// ===================== OFICIALES (RF-20) =====================

// Árbitros y estadígrafos activos, para asignarlos a los partidos.
const listOficiales = async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.nombre || ' ' || u.apellido AS nombre, r.nombre AS rol
     FROM seguridad.usuarios u JOIN seguridad.roles r ON r.id = u.rol_id
     WHERE u.activo AND UPPER(r.nombre) IN ($1, $2)
     ORDER BY u.nombre, u.apellido`,
    [ROLES.REFEREE, ROLES.STATS]
  );
  res.json({
    arbitros: rows.filter((r) => r.rol.toUpperCase() === ROLES.REFEREE).map(({ id, nombre }) => ({ id, nombre })),
    estadigrafos: rows.filter((r) => r.rol.toUpperCase() === ROLES.STATS).map(({ id, nombre }) => ({ id, nombre })),
  });
};

module.exports = {
  getLiga, updateLiga,
  listCategorias, createCategoria, deleteCategoria,
  listTorneos, getTorneo, createTorneo, updateTorneo, deleteTorneo,
  listOficiales,
};
