const pool = require('../config/database');

// RF-45: notificaciones de la liga (usuario_id NULL) y personales. Quien desactivó las
// notificaciones en su perfil solo recibe las personales (p. ej. "valida el acta").
const listNotificaciones = async (req, res) => {
  const { rows } = await pool.query(
    `SELECT n.id, n.tipo, n.titulo, n.mensaje, n.fecha, n.partido_id,
            (n.usuario_id IS NOT NULL AND n.leida)
              OR (n.usuario_id IS NULL AND u.notificaciones_leidas_hasta IS NOT NULL AND n.fecha <= u.notificaciones_leidas_hasta) AS leida
     FROM deportivo.notificaciones n
     JOIN seguridad.usuarios u ON u.id = $1
     WHERE n.usuario_id = $1 OR (n.usuario_id IS NULL AND u.recibe_notificaciones)
     ORDER BY n.fecha DESC, n.id DESC
     LIMIT 50`,
    [req.user.id]
  );
  res.json(rows);
};

const marcarLeidas = async (req, res) => {
  await pool.query('UPDATE seguridad.usuarios SET notificaciones_leidas_hasta = now() WHERE id = $1', [req.user.id]);
  await pool.query('UPDATE deportivo.notificaciones SET leida = true WHERE usuario_id = $1 AND NOT leida', [req.user.id]);
  res.status(204).end();
};

module.exports = { listNotificaciones, marcarLeidas };
