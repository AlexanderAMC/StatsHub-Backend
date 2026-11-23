const pool = require('../config/database');

// RF-06: registra una acción crítica en auditoria.logs. Un fallo al auditar nunca debe
// romper la operación principal: se informa por consola y se continúa.
async function audit(req, { accion, tabla, registroId = null, detalle = null, usuarioId }, db = pool) {
  try {
    await db.query(
      `INSERT INTO auditoria.logs (usuario_id, accion, tabla_afectada, registro_id, detalle, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        usuarioId ?? req?.user?.id ?? null,
        accion,
        tabla,
        registroId === null ? null : String(registroId),
        detalle ? JSON.stringify(detalle) : null,
        req?.ip ?? null,
      ]
    );
  } catch (error) {
    console.error('No se pudo registrar la auditoría:', error.message);
  }
}

module.exports = { audit };
