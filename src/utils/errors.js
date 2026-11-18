// Error de aplicación con código HTTP. Los controladores pueden lanzarlo (o pasarlo a next)
// y el manejador global de app.js responde { error, detalles? } con ese status.
class AppError extends Error {
  constructor(status, message, detalles) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    if (detalles) this.detalles = detalles;
  }
}

const badRequest = (message, detalles) => new AppError(400, message, detalles);
const notFound = (message = 'Recurso no encontrado') => new AppError(404, message);
const conflict = (message) => new AppError(409, message);

// Códigos de PostgreSQL que corresponden a errores del cliente, no del servidor.
const PG_ERRORS = Object.freeze({
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  INVALID_TEXT_REPRESENTATION: '22P02',
});

module.exports = { AppError, badRequest, notFound, conflict, PG_ERRORS };
