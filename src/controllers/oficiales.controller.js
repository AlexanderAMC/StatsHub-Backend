const pool = require('../config/database');
const { audit } = require('../utils/audit');
const { notify } = require('../services/notifications.service');
const { badRequest, notFound, conflict } = require('../utils/errors');
const { positiveInt, optionalPositiveInt, text, date } = require('../utils/http');
const { isUuid } = require('../utils/validators');
const { isLeagueManager, assertTournamentAccess, ownerFilter, forbidden } = require('../utils/scope');

// Partidos con acta cerrada donde la persona fue árbitro o estadígrafo y que aún no se le pagan.
// Si arbitró y además fue estadígrafo, la segunda función solo se paga con "doble función".
// Tarifa: la acordada para el torneo; si no hay, la del perfil del oficial.
const PENDING_SQL = `
  WITH funciones AS (
    SELECT p.id AS partido_id, p.torneo_id, 'ARBITRO' AS funcion, p.arbitro_id AS oficial_id
    FROM deportivo.partidos p WHERE p.arbitro_id IS NOT NULL
    UNION ALL
    SELECT p.id, p.torneo_id, 'ESTADIGRAFO', p.estadigrafo_id
    FROM deportivo.partidos p
    WHERE p.estadigrafo_id IS NOT NULL AND (p.estadigrafo_id IS DISTINCT FROM p.arbitro_id OR p.doble_funcion)
  )
  SELECT f.partido_id, f.funcion, f.torneo_id, t.nombre AS torneo, p.fecha_partido, p.jornada,
         el.nombre AS local, ev.nombre AS visita,
         COALESCE(tof.tarifa, u.tarifa_partido, 0)::int AS tarifa
  FROM funciones f
  JOIN deportivo.partidos p ON p.id = f.partido_id AND p.estado = 'FINALIZADO' AND p.acta_cerrada_en IS NOT NULL
  JOIN deportivo.torneos t ON t.id = f.torneo_id
  JOIN deportivo.equipos el ON el.id = p.equipo_local
  JOIN deportivo.equipos ev ON ev.id = p.equipo_visita
  JOIN seguridad.usuarios u ON u.id = f.oficial_id
  LEFT JOIN deportivo.torneo_oficiales tof ON tof.torneo_id = f.torneo_id AND tof.usuario_id = f.oficial_id
  LEFT JOIN pagos.partidos_liquidados pl ON pl.partido_id = f.partido_id AND pl.funcion = f.funcion
  WHERE pl.partido_id IS NULL AND f.oficial_id = $1
    AND ($2::int IS NULL OR f.torneo_id = $2)
    AND ($3::uuid IS NULL OR t.organizador_id = $3)
    AND ($4::date IS NULL OR p.fecha_partido::date >= $4)
    AND ($5::date IS NULL OR p.fecha_partido::date <= $5)
  ORDER BY p.fecha_partido, f.partido_id`;

function parseFilters(source) {
  const oficialId = String(source.oficial_id ?? '');
  if (!isUuid(oficialId)) throw badRequest('Indica el árbitro o estadígrafo');
  return {
    oficialId,
    torneoId: optionalPositiveInt(source.torneo_id, 'El torneo'),
    desde: date(source.desde, 'La fecha desde', { required: false }),
    hasta: date(source.hasta, 'La fecha hasta', { required: false }),
  };
}

const summarize = (items) => ({ partidos: items, cantidad: items.length, total: items.reduce((s, i) => s + i.tarifa, 0) });

// Tarifa acordada con un oficial para un torneo (prioridad sobre la de su perfil).
const setTarifaTorneo = async (req, res) => {
  const torneoId = positiveInt(req.params.id, 'El torneo');
  const usuarioId = String(req.params.usuarioId);
  if (!isUuid(usuarioId)) throw badRequest('Oficial inválido');
  const tarifa = Number(req.body?.tarifa);
  if (!Number.isInteger(tarifa) || tarifa < 0) throw badRequest('La tarifa debe ser un entero mayor o igual a 0');
  await assertTournamentAccess(req, torneoId);
  await pool.query(
    `INSERT INTO deportivo.torneo_oficiales (torneo_id, usuario_id, tarifa) VALUES ($1, $2, $3)
     ON CONFLICT (torneo_id, usuario_id) DO UPDATE SET tarifa = EXCLUDED.tarifa`,
    [torneoId, usuarioId, tarifa]
  );
  audit(req, { accion: 'TARIFA_OFICIAL', tabla: 'deportivo.torneo_oficiales', registroId: `${torneoId}:${usuarioId}`, detalle: { tarifa } });
  res.json({ torneo_id: torneoId, usuario_id: usuarioId, tarifa });
};

// Cálculo de lo que se le debe a un oficial (para el organizador).
const pendientes = async (req, res) => {
  const f = parseFilters(req.query);
  if (f.torneoId) await assertTournamentAccess(req, f.torneoId);
  const { rows } = await pool.query(PENDING_SQL, [f.oficialId, f.torneoId, ownerFilter(req.user), f.desde, f.hasta]);
  res.json(summarize(rows));
};

// Lo que el propio oficial tiene por cobrar (todas las ligas).
const misPendientes = async (req, res) => {
  const { rows } = await pool.query(PENDING_SQL, [req.user.id, null, null, null, null]);
  res.json(summarize(rows));
};

const crearLiquidacion = async (req, res) => {
  const f = parseFilters(req.body ?? {});
  if (f.torneoId) await assertTournamentAccess(req, f.torneoId);
  const client = await pool.connect();
  let liquidacionId;
  let resumen;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(PENDING_SQL, [f.oficialId, f.torneoId, ownerFilter(req.user), f.desde, f.hasta]);
    if (rows.length === 0) throw conflict('No hay partidos pendientes de pago para ese oficial en el periodo');
    resumen = summarize(rows);
    const created = await client.query(
      `INSERT INTO pagos.liquidaciones (oficial_id, creada_por, torneo_id, cantidad_partidos, monto_total)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [f.oficialId, req.user.id, f.torneoId, resumen.cantidad, resumen.total]
    );
    liquidacionId = created.rows[0].id;
    for (const item of rows) {
      await client.query(
        'INSERT INTO pagos.liquidacion_partidos (liquidacion_id, partido_id, funcion, tarifa) VALUES ($1, $2, $3, $4)',
        [liquidacionId, item.partido_id, item.funcion, item.tarifa]
      );
      // La clave primaria impide liquidar dos veces el mismo partido y función.
      await client.query(
        'INSERT INTO pagos.partidos_liquidados (partido_id, funcion, liquidacion_id) VALUES ($1, $2, $3)',
        [item.partido_id, item.funcion, liquidacionId]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') throw conflict('Algunos partidos ya fueron liquidados; vuelve a calcular');
    throw error;
  } finally {
    client.release();
  }
  notify({
    tipo: 'liquidacion',
    titulo: 'Nueva liquidación de partidos',
    mensaje: `${resumen.cantidad} partido(s) por $${resumen.total.toLocaleString('es-CL')}. Pendiente de pago.`,
    usuarioId: f.oficialId,
  });
  audit(req, { accion: 'CREAR_LIQUIDACION', tabla: 'pagos.liquidaciones', registroId: liquidacionId, detalle: { cantidad: resumen.cantidad, total: resumen.total } });
  res.status(201).json(await getLiquidacionData(liquidacionId));
};

const LIQ_SQL = `
  SELECT l.id, l.oficial_id, o.nombre || ' ' || o.apellido AS oficial, l.creada_por, c.nombre || ' ' || c.apellido AS organizador,
         l.torneo_id, t.nombre AS torneo, l.cantidad_partidos, l.monto_total, l.estado, l.medio_pago, l.referencia,
         l.pagada_en, l.observacion, l.creada_en
  FROM pagos.liquidaciones l
  JOIN seguridad.usuarios o ON o.id = l.oficial_id
  LEFT JOIN seguridad.usuarios c ON c.id = l.creada_por
  LEFT JOIN deportivo.torneos t ON t.id = l.torneo_id`;

async function getLiquidacionData(id) {
  const { rows } = await pool.query(`${LIQ_SQL} WHERE l.id = $1`, [id]);
  if (rows.length === 0) return null;
  const partidos = await pool.query(
    `SELECT lp.partido_id, lp.funcion, lp.tarifa, p.fecha_partido, p.jornada, el.nombre AS local, ev.nombre AS visita
     FROM pagos.liquidacion_partidos lp JOIN deportivo.partidos p ON p.id = lp.partido_id
     JOIN deportivo.equipos el ON el.id = p.equipo_local JOIN deportivo.equipos ev ON ev.id = p.equipo_visita
     WHERE lp.liquidacion_id = $1 ORDER BY p.fecha_partido`,
    [id]
  );
  return { ...rows[0], partidos: partidos.rows };
}

const canSee = (user, l) => isLeagueManager(user) || l.creada_por === user.id || l.oficial_id === user.id;
const canManage = (user, l) => isLeagueManager(user) || l.creada_por === user.id;

const listLiquidaciones = async (req, res) => {
  const { rows } = isLeagueManager(req.user)
    ? await pool.query(`${LIQ_SQL} ORDER BY l.creada_en DESC LIMIT 300`)
    : await pool.query(`${LIQ_SQL} WHERE l.creada_por = $1 OR l.oficial_id = $1 ORDER BY l.creada_en DESC LIMIT 300`, [req.user.id]);
  res.json(rows);
};

const getLiquidacion = async (req, res) => {
  const data = await getLiquidacionData(positiveInt(req.params.id, 'El id'));
  if (!data) throw notFound('Liquidación no encontrada');
  if (!canSee(req.user, data)) throw forbidden('No tienes acceso a esta liquidación');
  res.json(data);
};

async function loadForAction(req) {
  const id = positiveInt(req.params.id, 'El id');
  const { rows } = await pool.query('SELECT * FROM pagos.liquidaciones WHERE id = $1', [id]);
  if (rows.length === 0) throw notFound('Liquidación no encontrada');
  return rows[0];
}

// El organizador registra que pagó (transferencia o efectivo): Flow no hace pagos a terceros.
const pagarLiquidacion = async (req, res) => {
  const l = await loadForAction(req);
  if (!canManage(req.user, l)) throw forbidden('Solo quien generó la liquidación puede registrar su pago');
  if (!['PENDIENTE', 'OBSERVADA'].includes(l.estado)) throw conflict('La liquidación no está pendiente de pago');
  const medio = text(req.body?.medio_pago, 'El medio de pago', { max: 40 });
  const referencia = text(req.body?.referencia, 'El n.º de operación', { max: 100, required: false });
  const fecha = date(req.body?.fecha, 'La fecha de pago', { required: false });
  await pool.query(
    `UPDATE pagos.liquidaciones SET estado = 'PAGADA', medio_pago = $1, referencia = $2, pagada_en = COALESCE($3::date, now()), observacion = NULL
     WHERE id = $4`,
    [medio, referencia, fecha, l.id]
  );
  notify({ tipo: 'liquidacion', titulo: 'Liquidación pagada', mensaje: `$${Number(l.monto_total).toLocaleString('es-CL')} por ${l.cantidad_partidos} partido(s) (${medio}). Confirma la recepción.`, usuarioId: l.oficial_id });
  audit(req, { accion: 'PAGAR_LIQUIDACION', tabla: 'pagos.liquidaciones', registroId: l.id, detalle: { medio, referencia } });
  res.json(await getLiquidacionData(l.id));
};

// El oficial confirma la recepción o deja una observación si el monto no cuadra.
const confirmarLiquidacion = async (req, res) => {
  const l = await loadForAction(req);
  if (l.oficial_id !== req.user.id) throw forbidden('Solo el oficial puede confirmar su liquidación');
  if (l.estado !== 'PAGADA') throw conflict('La liquidación aún no figura como pagada');
  const conforme = req.body?.conforme === true;
  const observacion = conforme ? null : text(req.body?.observacion, 'La observación', { max: 1000 });
  await pool.query('UPDATE pagos.liquidaciones SET estado = $1, observacion = $2 WHERE id = $3', [conforme ? 'RECIBIDA' : 'OBSERVADA', observacion, l.id]);
  if (l.creada_por) {
    notify({
      tipo: 'liquidacion',
      titulo: conforme ? 'Pago recibido por el oficial' : 'El oficial dejó una observación',
      mensaje: conforme ? `Liquidación #${l.id} confirmada.` : `Liquidación #${l.id}: ${observacion}`,
      usuarioId: l.creada_por,
    });
  }
  audit(req, { accion: conforme ? 'CONFIRMAR_LIQUIDACION' : 'OBSERVAR_LIQUIDACION', tabla: 'pagos.liquidaciones', registroId: l.id });
  res.json(await getLiquidacionData(l.id));
};

// Anular libera los partidos para volver a liquidarlos.
const anularLiquidacion = async (req, res) => {
  const l = await loadForAction(req);
  if (!canManage(req.user, l)) throw forbidden('Solo quien generó la liquidación puede anularla');
  if (l.estado !== 'PENDIENTE') throw conflict('Solo se pueden anular liquidaciones pendientes');
  await pool.query('DELETE FROM pagos.partidos_liquidados WHERE liquidacion_id = $1', [l.id]);
  await pool.query(`UPDATE pagos.liquidaciones SET estado = 'ANULADA' WHERE id = $1`, [l.id]);
  audit(req, { accion: 'ANULAR_LIQUIDACION', tabla: 'pagos.liquidaciones', registroId: l.id });
  res.status(204).end();
};

module.exports = {
  setTarifaTorneo, pendientes, misPendientes, crearLiquidacion, listLiquidaciones, getLiquidacion,
  pagarLiquidacion, confirmarLiquidacion, anularLiquidacion,
};
