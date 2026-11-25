const pool = require('../config/database');
const { notify } = require('./notifications.service');

const INTERVALS = { SEMANA: '7 days', MES: '1 month', ANIO: '1 year' };
const REMINDER_DAYS = 3;

// Activa una suscripción pagada. Si el usuario ya tiene el mismo plan vigente, el nuevo periodo
// se suma al final del actual (renovación anticipada); si no, comienza ahora.
async function activarSuscripcion(suscripcionId, db = pool) {
  const { rows } = await db.query(
    `UPDATE pagos.suscripciones s
     SET estado = 'ACTIVA',
         inicio = GREATEST(now(), COALESCE((
             SELECT MAX(o.fin) FROM pagos.suscripciones o
             WHERE o.usuario_id = s.usuario_id AND o.plan_codigo = s.plan_codigo AND o.estado = 'ACTIVA' AND o.fin > now()
         ), now())),
         fin = GREATEST(now(), COALESCE((
             SELECT MAX(o.fin) FROM pagos.suscripciones o
             WHERE o.usuario_id = s.usuario_id AND o.plan_codigo = s.plan_codigo AND o.estado = 'ACTIVA' AND o.fin > now()
         ), now())) + (CASE s.periodo WHEN 'SEMANA' THEN interval '${INTERVALS.SEMANA}'
                                      WHEN 'MES' THEN interval '${INTERVALS.MES}'
                                      ELSE interval '${INTERVALS.ANIO}' END)
     WHERE s.id = $1 AND s.estado = 'PENDIENTE'
     RETURNING s.usuario_id, s.plan_codigo, s.fin`,
    [suscripcionId]
  );
  const s = rows[0];
  if (!s) return null;
  const plan = await db.query('SELECT nombre FROM pagos.planes WHERE codigo = $1', [s.plan_codigo]);
  notify({
    tipo: 'plan',
    titulo: `${plan.rows[0]?.nombre ?? 'Plan'} activado`,
    mensaje: `Tus funciones quedaron desbloqueadas hasta el ${new Date(s.fin).toLocaleDateString('es-CL')}.`,
    usuarioId: s.usuario_id,
  });
  return s;
}

// Aviso de vencimiento (una vez por suscripción) cuando faltan 3 días o menos.
async function sendExpiryReminders(db = pool) {
  const { rows } = await db.query(
    `UPDATE pagos.suscripciones s SET aviso_vencimiento_en = now()
     FROM pagos.planes p
     WHERE p.codigo = s.plan_codigo AND s.estado = 'ACTIVA' AND s.aviso_vencimiento_en IS NULL
       AND s.fin > now() AND s.fin <= now() + interval '${REMINDER_DAYS} days'
       AND NOT EXISTS (SELECT 1 FROM pagos.suscripciones r
                       WHERE r.usuario_id = s.usuario_id AND r.plan_codigo = s.plan_codigo AND r.estado = 'ACTIVA' AND r.fin > s.fin)
     RETURNING s.usuario_id, s.fin, p.nombre`
  );
  for (const r of rows) {
    notify({
      tipo: 'plan',
      titulo: `Tu ${r.nombre} vence pronto`,
      mensaje: `Vence el ${new Date(r.fin).toLocaleDateString('es-CL')}. Renuévalo en Planes para no perder tus funciones.`,
      usuarioId: r.usuario_id,
    });
  }
  return rows.length;
}

function startExpiryReminders(intervalMs = 60 * 60 * 1000) {
  const run = () => sendExpiryReminders().catch((error) => console.error('Avisos de vencimiento:', error.message));
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}

module.exports = { INTERVALS, activarSuscripcion, sendExpiryReminders, startExpiryReminders };
