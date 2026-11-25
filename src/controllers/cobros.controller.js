const pool = require('../config/database');
const { audit } = require('../utils/audit');
const { notify } = require('../services/notifications.service');
const { badRequest, notFound, conflict } = require('../utils/errors');
const { positiveInt, optionalPositiveInt, text, oneOf } = require('../utils/http');
const { isLeagueManager, assertTournamentAccess, assertTeamAccess, assertMatchAccess } = require('../utils/scope');
const { startFlowPayment } = require('./pagos.controller');

const COBRO_SQL = `
  SELECT c.id, c.torneo_id, t.nombre AS torneo, c.equipo_id, e.nombre AS equipo, c.partido_id, c.tipo, c.concepto,
         c.monto, c.estado, c.creado_en, c.pagado_en
  FROM pagos.cobros c
  JOIN deportivo.torneos t ON t.id = c.torneo_id
  JOIN deportivo.equipos e ON e.id = c.equipo_id`;

const parseMonto = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 350) throw badRequest('El monto debe ser un entero de al menos $350 (mínimo de Flow)');
  return n;
};

// Organizador: cobros de sus torneos. Entrenador: los de su equipo. Administración: todos.
const listCobros = async (req, res) => {
  const torneoId = optionalPositiveInt(req.query.torneo_id, 'El torneo');
  const equipoId = optionalPositiveInt(req.query.equipo_id, 'El equipo');
  const params = [torneoId, equipoId];
  let scope = '';
  if (!isLeagueManager(req.user)) {
    params.push(req.user.id);
    scope = 'AND (t.organizador_id = $3 OR e.entrenador_id = $3)';
  }
  const { rows } = await pool.query(
    `${COBRO_SQL} WHERE ($1::int IS NULL OR c.torneo_id = $1) AND ($2::int IS NULL OR c.equipo_id = $2) ${scope}
     ORDER BY c.creado_en DESC LIMIT 300`,
    params
  );
  res.json(rows);
};

async function assertTeamInTournament(equipoId, torneoId) {
  const { rows } = await pool.query('SELECT 1 FROM deportivo.torneo_equipos WHERE equipo_id = $1 AND torneo_id = $2', [equipoId, torneoId]);
  if (rows.length === 0) throw badRequest('El equipo no está inscrito en ese torneo');
}

async function insertCobro(req, { torneoId, equipoId, partidoId = null, tipo, concepto, monto }) {
  const { rows } = await pool.query(
    `INSERT INTO pagos.cobros (torneo_id, equipo_id, partido_id, tipo, concepto, monto, creado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [torneoId, equipoId, partidoId, tipo, concepto, monto, req.user.id]
  );
  const coach = await pool.query('SELECT entrenador_id FROM deportivo.equipos WHERE id = $1', [equipoId]);
  if (coach.rows[0]?.entrenador_id) {
    notify({ tipo: 'cobro', titulo: 'Nuevo cobro para tu equipo', mensaje: `${concepto}: $${monto.toLocaleString('es-CL')}`, usuarioId: coach.rows[0].entrenador_id });
  }
  return rows[0].id;
}

// Cobro manual (inscripción o planilla) a un equipo de un torneo propio.
const createCobro = async (req, res) => {
  const torneoId = positiveInt(req.body?.torneo_id, 'El torneo');
  const equipoId = positiveInt(req.body?.equipo_id, 'El equipo');
  const tipo = oneOf(String(req.body?.tipo ?? '').toUpperCase(), ['INSCRIPCION', 'PLANILLA'], 'El tipo de cobro');
  const concepto = text(req.body?.concepto, 'El concepto', { max: 200 });
  const monto = parseMonto(req.body?.monto);
  await assertTournamentAccess(req, torneoId);
  await assertTeamInTournament(equipoId, torneoId);
  if (tipo === 'INSCRIPCION') {
    const dup = await pool.query(
      `SELECT 1 FROM pagos.cobros WHERE equipo_id = $1 AND torneo_id = $2 AND tipo = 'INSCRIPCION' AND estado <> 'ANULADO'`,
      [equipoId, torneoId]
    );
    if (dup.rows.length > 0) throw conflict('Ese equipo ya tiene un cobro de inscripción en el torneo');
  }
  const id = await insertCobro(req, { torneoId, equipoId, tipo, concepto, monto });
  audit(req, { accion: 'CREAR_COBRO', tabla: 'pagos.cobros', registroId: id, detalle: { tipo, monto } });
  const { rows } = await pool.query(`${COBRO_SQL} WHERE c.id = $1`, [id]);
  res.status(201).json(rows[0]);
};

// Planillas de un partido: un cobro para cada equipo.
const createPlanillasPartido = async (req, res) => {
  const partidoId = positiveInt(req.body?.partido_id, 'El partido');
  const monto = parseMonto(req.body?.monto);
  await assertMatchAccess(req, partidoId);
  const { rows } = await pool.query(
    `SELECT p.torneo_id, p.equipo_local, p.equipo_visita, p.jornada, el.nombre AS local, ev.nombre AS visita
     FROM deportivo.partidos p JOIN deportivo.equipos el ON el.id = p.equipo_local JOIN deportivo.equipos ev ON ev.id = p.equipo_visita
     WHERE p.id = $1`,
    [partidoId]
  );
  const p = rows[0];
  const existing = await pool.query(`SELECT 1 FROM pagos.cobros WHERE partido_id = $1 AND tipo = 'PLANILLA' AND estado <> 'ANULADO'`, [partidoId]);
  if (existing.rows.length > 0) throw conflict('Ese partido ya tiene planillas generadas');
  const concepto = text(req.body?.concepto, 'El concepto', { max: 150, required: false }) ?? `Planilla fecha ${p.jornada}: ${p.local} vs ${p.visita}`;
  const ids = [];
  for (const equipoId of [p.equipo_local, p.equipo_visita]) {
    ids.push(await insertCobro(req, { torneoId: p.torneo_id, equipoId, partidoId, tipo: 'PLANILLA', concepto, monto }));
  }
  audit(req, { accion: 'CREAR_PLANILLAS', tabla: 'pagos.cobros', registroId: partidoId, detalle: { monto } });
  res.status(201).json({ creados: ids.length, ids });
};

// Pago de un cobro: lo hace el dueño del torneo o el entrenador del equipo (plan Pro).
const pagarCobro = async (req, res) => {
  const id = positiveInt(req.params.id, 'El id');
  const { rows } = await pool.query(`${COBRO_SQL} WHERE c.id = $1`, [id]);
  const cobro = rows[0];
  if (!cobro) throw notFound('Cobro no encontrado');
  if (cobro.estado !== 'PENDIENTE') throw conflict('Este cobro ya no está pendiente');
  await assertTeamAccess(req, cobro.equipo_id, pool, { allowCoach: true });
  const pago = await startFlowPayment(req, {
    tipo: cobro.tipo, monto: Number(cobro.monto), concepto: cobro.concepto,
    equipoId: cobro.equipo_id, torneoId: cobro.torneo_id, cobroId: cobro.id,
  });
  res.status(201).json(pago);
};

const anularCobro = async (req, res) => {
  const id = positiveInt(req.params.id, 'El id');
  const { rows } = await pool.query('SELECT torneo_id, estado FROM pagos.cobros WHERE id = $1', [id]);
  if (rows.length === 0) throw notFound('Cobro no encontrado');
  await assertTournamentAccess(req, rows[0].torneo_id);
  if (rows[0].estado !== 'PENDIENTE') throw conflict('Solo se pueden anular cobros pendientes');
  await pool.query(`UPDATE pagos.cobros SET estado = 'ANULADO' WHERE id = $1`, [id]);
  audit(req, { accion: 'ANULAR_COBRO', tabla: 'pagos.cobros', registroId: id });
  res.status(204).end();
};

module.exports = { listCobros, createCobro, createPlanillasPartido, pagarCobro, anularCobro };
