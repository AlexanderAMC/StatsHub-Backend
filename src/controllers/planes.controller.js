const pool = require('../config/database');
const { audit } = require('../utils/audit');
const { badRequest, notFound, conflict } = require('../utils/errors');
const { oneOf, text } = require('../utils/http');
const { startFlowPayment } = require('./pagos.controller');
const { effectivePermissions } = require('../config/permissions');

const PERIODS = { SEMANA: 'precio_semana', MES: 'precio_mes', ANIO: 'precio_anio' };
const PERIOD_LABEL = { SEMANA: 'semanal', MES: 'mensual', ANIO: 'anual' };

const ACTIVE_SQL = `
  SELECT s.plan_codigo, p.nombre, p.nivel, s.periodo, s.inicio, s.fin
  FROM pagos.suscripciones s JOIN pagos.planes p ON p.codigo = s.plan_codigo
  WHERE s.usuario_id = $1 AND s.estado = 'ACTIVA' AND s.inicio <= now() AND s.fin > now()
  ORDER BY p.nivel DESC, s.fin DESC LIMIT 1`;

// Planes disponibles (público).
const listPlanes = async (req, res) => {
  const { rows } = await pool.query(
    `SELECT codigo, nombre, descripcion, nivel, precio_semana, precio_mes, precio_anio, activo
     FROM pagos.planes ${req.user?.permissions?.includes('usuarios:gestionar') ? '' : 'WHERE activo'} ORDER BY nivel`
  );
  res.json(rows);
};

// Plan vigente del usuario, permisos efectivos e historial.
const miSuscripcion = async (req, res) => {
  const [active, history] = await Promise.all([
    pool.query(ACTIVE_SQL, [req.user.id]),
    pool.query(
      `SELECT s.id, s.plan_codigo, p.nombre, s.periodo, s.monto, s.estado, s.inicio, s.fin, s.creada_en
       FROM pagos.suscripciones s JOIN pagos.planes p ON p.codigo = s.plan_codigo
       WHERE s.usuario_id = $1 AND s.estado <> 'PENDIENTE' ORDER BY s.creada_en DESC LIMIT 20`,
      [req.user.id]
    ),
  ]);
  const plan = active.rows[0] ?? null;
  res.json({ plan, permisos: effectivePermissions(req.user.rol, plan?.plan_codigo), historial: history.rows });
};

// Compra o renovación de un plan: crea la suscripción pendiente y la orden de pago en Flow.
const comprarPlan = async (req, res) => {
  const codigo = String(req.body?.plan ?? '').toUpperCase();
  const periodo = oneOf(String(req.body?.periodo ?? '').toUpperCase(), Object.keys(PERIODS), 'El periodo');
  const { rows } = await pool.query('SELECT * FROM pagos.planes WHERE codigo = $1 AND activo', [codigo]);
  if (rows.length === 0) throw badRequest('El plan no existe o no está disponible');
  const plan = rows[0];
  const monto = Number(plan[PERIODS[periodo]]);

  const active = await pool.query(ACTIVE_SQL, [req.user.id]);
  if (active.rows[0] && active.rows[0].nivel > plan.nivel) {
    throw conflict(`Ya tienes el ${active.rows[0].nombre} vigente, que incluye todo lo de este plan`);
  }

  const sub = await pool.query(
    `INSERT INTO pagos.suscripciones (usuario_id, plan_codigo, periodo, monto) VALUES ($1, $2, $3, $4) RETURNING id`,
    [req.user.id, codigo, periodo, monto]
  );
  const pago = await startFlowPayment(req, {
    tipo: 'SUSCRIPCION', monto, concepto: `StatsHub ${plan.nombre} (${PERIOD_LABEL[periodo]})`, suscripcionId: sub.rows[0].id,
  });
  res.status(201).json(pago);
};

// Administración: precios, descripción y disponibilidad de cada plan.
const updatePlan = async (req, res) => {
  const codigo = String(req.params.codigo).toUpperCase();
  const b = req.body ?? {};
  const prices = ['precio_semana', 'precio_mes', 'precio_anio'].map((k) => {
    const n = Number(b[k]);
    if (!Number.isInteger(n) || n < 0) throw badRequest(`${k.replace('precio_', 'El precio ').replace('anio', 'anual')} debe ser un entero mayor o igual a 0`);
    return n;
  });
  const descripcion = text(b.descripcion, 'La descripción', { max: 1000, required: false });
  const { rows } = await pool.query(
    `UPDATE pagos.planes SET precio_semana = $1, precio_mes = $2, precio_anio = $3,
            descripcion = COALESCE($4, descripcion), activo = COALESCE($5, activo), actualizado_en = now()
     WHERE codigo = $6 RETURNING *`,
    [...prices, descripcion, typeof b.activo === 'boolean' ? b.activo : null, codigo]
  );
  if (rows.length === 0) throw notFound('Plan no encontrado');
  audit(req, { accion: 'EDITAR_PLAN', tabla: 'pagos.planes', registroId: codigo, detalle: { precios: prices } });
  res.json(rows[0]);
};

// Administración: suscripciones vigentes e ingresos por plan.
const resumenSuscripciones = async (req, res) => {
  const [porPlan, recientes] = await Promise.all([
    pool.query(
      `SELECT p.codigo, p.nombre,
              (SELECT COUNT(DISTINCT s.usuario_id)::int FROM pagos.suscripciones s
               WHERE s.plan_codigo = p.codigo AND s.estado = 'ACTIVA' AND s.inicio <= now() AND s.fin > now()) AS activas,
              COALESCE((SELECT SUM(t.monto) FROM pagos.transacciones t JOIN pagos.suscripciones s ON s.id = t.suscripcion_id
                        WHERE s.plan_codigo = p.codigo AND t.estado = 'PAGADO'), 0)::int AS ingresos
       FROM pagos.planes p ORDER BY p.nivel`
    ),
    pool.query(
      `SELECT s.id, u.nombre || ' ' || u.apellido AS usuario, u.correo, p.nombre AS plan, s.periodo, s.monto, s.inicio, s.fin
       FROM pagos.suscripciones s JOIN seguridad.usuarios u ON u.id = s.usuario_id JOIN pagos.planes p ON p.codigo = s.plan_codigo
       WHERE s.estado = 'ACTIVA' ORDER BY s.inicio DESC LIMIT 100`
    ),
  ]);
  res.json({ planes: porPlan.rows, suscripciones: recientes.rows });
};

module.exports = { listPlanes, miSuscripcion, comprarPlan, updatePlan, resumenSuscripciones };
