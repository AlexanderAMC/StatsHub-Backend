const crypto = require('node:crypto');
const pool = require('../config/database');
const flow = require('../services/flow');
const { audit } = require('../utils/audit');
const { notify } = require('../services/notifications.service');
const { AppError, badRequest, notFound, conflict } = require('../utils/errors');
const { positiveInt } = require('../utils/http');
const { PERMISSIONS, hasPermission } = require('../config/permissions');

const STATUS_BY_FLOW = { 1: 'PENDIENTE', 2: 'PAGADO', 3: 'RECHAZADO', 4: 'ANULADO' };

const publicApiUrl = () => (process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const frontendUrl = () =>
  (process.env.FRONTEND_PUBLIC_URL || (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0]).replace(/\/$/, '');

const PAYMENT_SQL = `
  SELECT tr.id, tr.orden_comercio, tr.monto, tr.estado, tr.flow_id AS flow_orden, tr.medio_pago, tr.correo_pagador,
         tr.fecha, tr.fecha_pago, tr.equipo_id, e.nombre AS equipo, tr.torneo_id, t.nombre AS torneo, tr.usuario_id,
         u.nombre || ' ' || u.apellido AS solicitado_por
  FROM pagos.transacciones tr
  LEFT JOIN deportivo.equipos e ON e.id = tr.equipo_id
  LEFT JOIN deportivo.torneos t ON t.id = tr.torneo_id
  LEFT JOIN seguridad.usuarios u ON u.id = tr.usuario_id`;

// RF-38 / RF-39: genera el cobro de inscripción y devuelve la URL de pago de Flow.
const crearCobroInscripcion = async (req, res) => {
  if (!flow.isConfigured()) {
    throw new AppError(503, 'Los pagos con Flow no están configurados (faltan FLOW_API_KEY y FLOW_SECRET_KEY)');
  }
  const equipoId = positiveInt(req.body?.equipo_id, 'El equipo');
  const torneoId = positiveInt(req.body?.torneo_id, 'El torneo');

  const { rows } = await pool.query(
    `SELECT te.estado_inscripcion, e.nombre AS equipo, t.nombre AS torneo,
            COALESCE(t.costo_inscripcion, l.costo_inscripcion) AS monto, u.correo
     FROM deportivo.torneo_equipos te
     JOIN deportivo.equipos e ON e.id = te.equipo_id
     JOIN deportivo.torneos t ON t.id = te.torneo_id
     CROSS JOIN deportivo.liga l
     JOIN seguridad.usuarios u ON u.id = $3
     WHERE te.equipo_id = $1 AND te.torneo_id = $2`,
    [equipoId, torneoId, req.user.id]
  );
  if (rows.length === 0) throw badRequest('El equipo no está inscrito en ese torneo');
  const data = rows[0];
  if (data.estado_inscripcion === 'INSCRITO') throw conflict('La inscripción de este equipo ya está pagada');
  const monto = Number(data.monto);
  if (!Number.isInteger(monto) || monto < 350) throw conflict('El costo de inscripción no está definido o es menor al mínimo de Flow ($350)');

  const ordenComercio = `SH-${torneoId}-${equipoId}-${crypto.randomBytes(4).toString('hex')}`;
  const insert = await pool.query(
    `INSERT INTO pagos.transacciones (usuario_id, equipo_id, torneo_id, monto, estado, orden_comercio, correo_pagador)
     VALUES ($1, $2, $3, $4, 'PENDIENTE', $5, $6) RETURNING id`,
    [req.user.id, equipoId, torneoId, monto, ordenComercio, data.correo]
  );

  let payment;
  try {
    payment = await flow.createPayment({
      commerceOrder: ordenComercio,
      subject: `Inscripción ${data.equipo} - ${data.torneo}`.slice(0, 100),
      currency: 'CLP',
      amount: monto,
      email: data.correo,
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
  audit(req, { accion: 'GENERAR_COBRO', tabla: 'pagos.transacciones', registroId: insert.rows[0].id, detalle: { equipoId, torneoId, monto } });
  res.status(201).json({ id: insert.rows[0].id, orden_comercio: ordenComercio, url: `${payment.url}?token=${payment.token}` });
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
     RETURNING id, equipo_id, torneo_id, orden_comercio, monto, (xmax <> 0) AS existia`,
    [estado, status.flowOrder ? String(status.flowOrder) : null, status.paymentData?.media ?? null, token]
  );
  const tx = rows[0];
  if (!tx) return null;
  // Flow informa el monto pagado: si no coincide, no se marca la inscripción.
  if (estado === 'PAGADO' && Number(status.amount) === Number(tx.monto)) {
    const updated = await pool.query(
      `UPDATE deportivo.torneo_equipos SET estado_inscripcion = 'INSCRITO'
       WHERE equipo_id = $1 AND torneo_id = $2 AND estado_inscripcion <> 'INSCRITO'
       RETURNING (SELECT nombre FROM deportivo.equipos WHERE id = $1) AS equipo`,
      [tx.equipo_id, tx.torneo_id]
    );
    if (updated.rows.length > 0) {
      notify({ tipo: 'pago', titulo: 'Inscripción confirmada', mensaje: `${updated.rows[0].equipo} quedó inscrito tras el pago con Flow` });
      audit(null, { accion: 'PAGO_CONFIRMADO', tabla: 'pagos.transacciones', registroId: tx.id, detalle: { orden: tx.orden_comercio } });
    }
  }
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
    // 500 hace que Flow reintente la confirmación más tarde.
    return res.status(500).send('ERROR');
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

const listPagos = async (req, res) => {
  const { rows } = await pool.query(`${PAYMENT_SQL} ORDER BY tr.fecha DESC LIMIT 200`);
  res.json(rows.map(({ usuario_id: _omit, ...r }) => r));
};

// RF-41: datos del comprobante (el frontend lo muestra en formato imprimible).
const getPago = async (req, res) => {
  const { rows } = req.params.id.startsWith('SH-')
    ? await pool.query(`${PAYMENT_SQL} WHERE tr.orden_comercio = $1`, [req.params.id])
    : await pool.query(`${PAYMENT_SQL} WHERE tr.id = $1`, [positiveInt(req.params.id, 'El id')]);
  if (rows.length === 0) throw notFound('Pago no encontrado');
  // Contiene el correo del pagador: solo lo ve quien gestiona equipos o quien hizo el pago.
  if (!hasPermission(req.user.rol, PERMISSIONS.MANAGE_TEAMS) && rows[0].usuario_id !== req.user.id) {
    throw new AppError(403, 'No tienes permisos para ver este comprobante');
  }
  const liga = await pool.query('SELECT nombre, correo_contacto, telefono FROM deportivo.liga WHERE id = 1');
  const { usuario_id: _omit, ...pago } = rows[0];
  res.json({ ...pago, liga: liga.rows[0] ?? null });
};

module.exports = { crearCobroInscripcion, confirmacionFlow, retornoFlow, listPagos, getPago, syncPayment };
