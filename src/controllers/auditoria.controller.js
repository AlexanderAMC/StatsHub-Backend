const pool = require('../config/database');

// RF-06: bitácora de acciones críticas (solo administradores), con filtros y paginación.
const listAuditoria = async (req, res) => {
  const limite = Math.min(Math.max(Number(req.query.limite) || 50, 1), 200);
  const pagina = Math.max(Number(req.query.pagina) || 1, 1);
  const accion = typeof req.query.accion === 'string' && req.query.accion ? req.query.accion.toUpperCase() : null;

  const { rows } = await pool.query(
    `SELECT l.id, l.fecha, l.accion, l.tabla_afectada, l.registro_id, l.detalle, l.ip,
            u.correo AS usuario_correo, u.nombre || ' ' || u.apellido AS usuario_nombre,
            COUNT(*) OVER()::int AS total
     FROM auditoria.logs l
     LEFT JOIN seguridad.usuarios u ON u.id = l.usuario_id
     WHERE $1::text IS NULL OR l.accion = $1
     ORDER BY l.fecha DESC, l.id DESC
     LIMIT $2 OFFSET $3`,
    [accion, limite, (pagina - 1) * limite]
  );
  res.json({
    total: rows[0]?.total ?? 0,
    pagina,
    limite,
    registros: rows.map(({ total, ...r }) => r),
  });
};

module.exports = { listAuditoria };
