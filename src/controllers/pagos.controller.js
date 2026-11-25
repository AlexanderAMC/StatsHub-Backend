const crypto = require('node:crypto');
const pool = require('../config/database');
const flow = require('../services/flow');
const { audit } = require('../utils/audit');
const { notify } = require('../services/notifications.service');
const { activarSuscripcion } = require('../services/subscriptions');
const { AppError, badRequest, notFound, conflict } = require('../utils/errors');
const { positiveInt } = require('../utils/http');
const { isLeagueManager, assertTeamAccess } = require('../utils/scope');

const STATUS_BY_FLOW = { 1: 'PENDIENTE', 2: 'PAGADO', 3: 'RECHAZADO', 4: 'ANULADO' };
const FLOW_MIN_AMOUNT = 350;

const publicApiUrl = () => (process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const frontendUrl = () =>
  (process.env.FRONTEND_PUBLIC_URL || (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0]).replace(/\/$/, '');

const PAYMENT_SQL = `
  SELECT tr.id, tr.orden_comercio, tr.monto, tr.estado, tr.tipo, tr.concepto, tr.flow_id AS flow_orden, tr.medio_pago,
         tr.correo_pagador, tr.fecha, tr.fecha_pago, tr.equipo_id, e.nombre AS equipo, tr.torneo_id, t.nombre AS torneo,
         tr.usuario_id, t.organizador_id, u.nombre || ' ' || u.apellido AS solicitado_por
  FROM pagos.transacciones tr
  LEFT JOIN deportivo.equipos e ON e.id = tr.equipo_id
  LEFT JOIN deportivo.torneos t ON t.id = tr.torneo_id
  LEFT JOIN seguridad.usuarios u ON u.id = tr.usuario_id`;

// Crea la transacción y la orden en Flow (RNF-10: el pago ocurre en Flow, nunca se reciben tarjetas).
// Devuelve { id, orden_comercio, url } para redirigir al usuario a la pasarela.
async function startFlowPayment(req, { tipo, monto, concepto, equipoId = null, torneoId = null, cobroId = null, suscripcionId = null }) {
  if (!flow.isConfigured()) {
    throw new AppError(503, 'Los pagos con Flow no están configurados (faltan FLOW_API_KEY y FLOW_SECRET_KEY)');
  }
  if (!Number.isInteger(Number(monto)) || Number(monto) < FLOW_MIN_AMOUNT) {
    throw conflict(`El monto debe ser de al menos $${FLOW_MIN_AMOUNT} (mínimo de Flow)`);
  }
  const { rows: users } = await pool.query('SELECT correo FROM seguridad.usuarios WHERE id = $1', [req.user.id]);
  const correo = users[0].correo;
  const ordenComercio = `SH-${tipo.slice(0, 3)}-${crypto.randomBytes(5).toString('hex')}`;
  const insert = await pool.query(
    `INSERT INTO pagos.transacciones (usuario_id, equipo_id, torneo_id, monto, estado, orden_comercio, correo_pagador, tipo, concepto, cobro_id, suscripcion_id)
     VALUES ($1, $2, $3, $4, 'PENDIENTE', $5, $6, $7, $8, $9, $10) RETURNING id`,
    [req.user.id, equipoId, torneoId, monto, ordenComercio, correo, tipo, concepto, cobroId, suscripcionId]
  );

  let payment;
  try {
    payment = await flow.createPayment({
      commerceOrder: ordenComercio,
      subject: concepto.slice(0, 100),
      currency: 'CLP',
      amount: Number(monto),
      email: correo,
      urlConfirmation: `${publicApiUrl()}/api/pagos/flow/confirmacion`,
      urlReturn: `${publicApiUrl()}/api/pagos/flow/retorno`,
    });
  } catch (error) {
    await pool.query(`UPDATE pagos.transacciones SET estado = 'ANULADO', actualizado_en = now() WHERE id = $1`, [insert.rows[0].id]);
    console.error('Error creando el pago en Flow:', error.message, error.flow ?? '');
    throw new AppError(502, 'No se pudo crear el cobro en Flow. Intenta nuevamente.');
  }

  await pool.query(
    'UPDATE pagos.transacciones SET flow_token = $1, flow_id = $2, actualizado_en = now() WHERE id = $3',
    [payment.token, String(payment.flowOrder ?? ''), insert.rows[0].id]
  );
  audit(req, { accion: tipo === 'SUSCRIPCION' ? 'COMPRAR_PLAN' : 'GENERAR_COBRO', tabla: 'pagos.transacciones', registroId: insert.rows[0].id, detalle: { tipo, monto } });
  return { id: insert.rows[0].id, orden_comercio: ordenComercio, url: `${payment.url}?token=${payment.token}` };
}

// Obtiene (o crea) el cobro de inscripción pendiente del equipo en el torneo.
async function ensureInscripcionCobro(req, equipoId, torneoId) {
  const { rows } = await pool.query(
    `SELECT te.estado_inscripcion, e.nombre AS equipo, t.nombre AS torneo,
            COALESCE(t.costo_inscripcion, l.costo_inscripcion) AS monto
     FROM deportivo.torneo_equipos te
     JOIN deportivo.equipos e ON e.id = te.equipo_id
     JOIN deportivo.torneos t ON t.id = te.torneo_id
     CROSS JOIN deportivo.liga l
     WHERE te.equipo_id = $1 AND te.torneo_id = $2`,
    [equipoId, torneoId]
  );
  if (rows.length === 0) throw badRequest('El equipo no está inscrito en ese torneo');
  const data = rows[0];
  if (data.estado_inscripcion === 'INSCRITO') throw conflict('La inscripción de este equipo ya está pagada');
  const existing = await pool.query(
    `SELECT id, monto, concepto FROM pagos.cobros WHERE equipo_id = $1 AND torneo_id = $2 AND tipo = 'INSCRIPCION' AND estado = 'PENDIENTE' LIMIT 1`,
    [equipoId, torneoId]
  );
  if (existing.rows[0]) return existing.rows[0];
  const monto = Number(data.monto);
  if (!Number.isInteger(monto) || monto < FLOW_MIN_AMOUNT) {
    throw conflict(`El costo de inscripción no está definido o es menor al mínimo de Flow ($${FLOW_MIN_AMOUNT})`);
  }
  const created = await pool.query(
    `INSERT INTO pagos.cobros (torneo_id, equipo_id, tipo, concepto, monto, creado_por)
     VALUES ($1, $2, 'INSCRIPCION', $3, $4, $5) RETURNING id, monto, concepto`,
    [torneoId, equipoId, `Inscripción ${data.equipo} - ${data.torneo}`.slice(0, 200), monto, req.user.id]
  );
  return created.rows[0];
}

// RF-38 / RF-39 / HU-05: cobro de inscripción. Lo genera el dueño del torneo o el entrenador del equipo.
const crearCobroInscripcion = async (req, res) => {
  const equipoId = positiveInt(req.body?.equipo_id, 'El equipo');
  const torneoId = positiveInt(req.body?.torneo_id, 'El torneo');
  await assertTeamAccess(req, equipoId, pool, { allowCoach: true });
  const cobro = await ensureInscripcionCobro(req, equipoId, torneoId);
  const pago = await startFlowPayment(req, {
    tipo: 'INSCRIPCION', monto: cobro.monto, concepto: cobro.concepto, equipoId, torneoId, cobroId: cobro.id,
  });
  res.status(201).json(pago);
};

// Consulta a Flow el estado real del pago y lo aplica. Idempotente: Flow puede reintentar.
async function syncPayment(token) {
  const status = await flow.getStatus(token);
  const estado = STATUS_BY_FLOW[status.status] ?? 'PENDIENTE';
  const { rows } = await pool.query(
    `UPDATE pagos.transacciones
     SET estado = $1::varchar, flow_id = COALESCE($2::varchar, flow_id), medio_pago = $3::varchar,
         fecha_pago = CASE WHEN $1::varchar = 'PAGADO' THEN COALESCE(fecha_pago, now()) ELSE fecha_pago END,
         actualizado_en = now()
     WHERE flow_token = $4
     RETURNING id, tipo, equipo_id, torneo_id, cobro_id, suscripcion_id, orden_comercio, monto, usuario_id`,
    [estado, status.flowOrder ? String(status.flowOrder) : null, status.paymentData?.media ?? null, token]
  );
  const tx = rows[0];
  if (!tx) return null;
  // Flow informa el monto pagado: si no coincide, no se aplica el beneficio.
  if (estado !== 'PAGADO' || Number(status.amount) !== Number(tx.monto)) return { ...tx, estado };

  if (tx.tipo === 'SUSCRIPCION' && tx.suscripcion_id) {
    const activated = await activarSuscripcion(tx.suscripcion_id);
    if (activated) audit(null, { accion: 'PLAN_ACTIVADO', tabla: 'pagos.suscripciones', registroId: tx.suscripcion_id, usuarioId: tx.usuario_id });
  }

  if (tx.cobro_id) {
    const cobro = await pool.query(
      `UPDATE pagos.cobros SET estado = 'PAGADO', pagado_en = now() WHERE id = $1 AND estado <> 'PAGADO'
       RETURNING tipo, concepto, (SELECT organizador_id FROM deportivo.torneos WHERE id = torneo_id) AS organizador_id`,
      [tx.cobro_id]
    );
    if (cobro.rows[0]?.organizador_id) {
      notify({ tipo: 'cobro', titulo: 'Cobro pagado', mensaje: cobro.rows[0].concepto, usuarioId: cobro.rows[0].organizador_id });
    }
  }

  if (tx.tipo === 'INSCRIPCION' && tx.equipo_id && tx.torneo_id) {
    const updated = await pool.query(
      `UPDATE deportivo.torneo_equipos SET estado_inscripcion = 'INSCRITO'
       WHERE equipo_id = $1 AND torneo_id = $2 AND estado_inscripcion <> 'INSCRITO'
       RETURNING (SELECT nombre FROM deportivo.equipos WHERE id = $1) AS equipo`,
      [tx.equipo_id, tx.torneo_id]
    );
    if (updated.rows.length > 0) {
      notify({ tipo: 'pago', titulo: 'Inscripción confirmada', mensaje: `${updated.rows[0].equipo} quedó inscrito tras el pago con Flow` });
    }
  }
  audit(null, { accion: 'PAGO_CONFIRMADO', tabla: 'pagos.transacciones', registroId: tx.id, detalle: { orden: tx.orden_comercio, tipo: tx.tipo } });
  return { ...tx, estado };
}

// RF-40: Flow notifica aquí (POST application/x-www-form-urlencoded con "token").
const confirmacionFlow = async (req, res) => {
  const token = req.body?.token;
  if (typeof token !== 'string' || !token || token.length > 255) return res.status(400).send('token requerido');
  try {
    await syncPayment(token);
    return res.status(200).send('OK');
  } catch (error) {
    console.error('Error confirmando pago de Flow:', error.message);
    return res.status(500).send('ERROR'); // Flow reintenta la confirmación más tarde
  }
};

// El navegador vuelve aquí después de pagar; se sincroniza y se redirige al frontend.
const retornoFlow = async (req, res) => {
  const token = req.body?.token ?? req.query?.token;
  let orden = '';
  if (typeof token === 'string' && token) {
    try {
      const tx = await syncPayment(token);
      orden = tx?.orden_comercio ?? '';
    } catch (error) {
      console.error('Error consultando el pago al volver de Flow:', error.message);
    }
  }
  res.redirect(303, `${frontendUrl()}/pagos/resultado?orden=${encodeURIComponent(orden)}`);
};

const strip = ({ usuario_id: _u, organizador_id: _o, ...r }) => r;

// Administración de la liga: todo. Organizador: pagos de sus torneos. Resto: sus propios pagos.
const listPagos = async (req, res) => {
  const { rows } = isLeagueManager(req.user)
    ? await pool.query(`${PAYMENT_SQL} ORDER BY tr.fecha DESC LIMIT 300`)
    : await pool.query(`${PAYMENT_SQL} WHERE tr.usuario_id = $1 OR t.organizador_id = $1 ORDER BY tr.fecha DESC LIMIT 300`, [req.user.id]);
  res.json(rows.map(strip));
};

// RF-41: datos del comprobante (el frontend lo muestra en formato imprimible).
const getPago = async (req, res) => {
  const { rows } = req.params.id.startsWith('SH-')
    ? await pool.query(`${PAYMENT_SQL} WHERE tr.orden_comercio = $1`, [req.params.id])
    : await pool.query(`${PAYMENT_SQL} WHERE tr.id = $1`, [positiveInt(req.params.id, 'El id')]);
  if (rows.length === 0) throw notFound('Pago no encontrado');
  const pago = rows[0];
  // Contiene el correo del pagador: lo ven la administración, quien pagó y el dueño del torneo.
  if (!isLeagueManager(req.user) && pago.usuario_id !== req.user.id && pago.organizador_id !== req.user.id) {
    throw new AppError(403, 'No tienes permisos para ver este comprobante');
  }
  const liga = await pool.query('SELECT nombre, correo_contacto, telefono FROM deportivo.liga WHERE id = 1');
  res.json({ ...strip(pago), liga: liga.rows[0] ?? null });
};

module.exports = { crearCobroInscripcion, confirmacionFlow, retornoFlow, listPagos, getPago, syncPayment, startFlowPayment };
