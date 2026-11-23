const pool = require('../config/database');
const { broadcast } = require('../realtime/hub');

// Crea una notificación. usuarioId null = para toda la liga. Avisa por SSE para que los
// clientes conectados actualicen el menú de notificaciones al instante.
async function notify({ tipo, titulo, mensaje, usuarioId = null, partidoId = null }, db = pool) {
  try {
    await db.query(
      `INSERT INTO deportivo.notificaciones (usuario_id, titulo, mensaje, tipo, partido_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [usuarioId, titulo, mensaje, tipo, partidoId]
    );
    broadcast('notificacion', { tipo, usuarioId });
  } catch (error) {
    console.error('No se pudo crear la notificación:', error.message);
  }
}

module.exports = { notify };
