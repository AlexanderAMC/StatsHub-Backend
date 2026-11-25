const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const pool = require('./config/database');
const deportivosRoutes = require('./routes/deportivos.routes');
const authRoutes = require('./routes/auth.routes');
const { UPLOADS_DIR } = require('./controllers/equipos.controller');
const { AppError, PG_ERRORS } = require('./utils/errors');

const app = express();

// Detrás de Nginx / balanceador: req.ip toma la IP real del cliente (rate limiting y auditoría).
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

// Orígenes permitidos para CORS: FRONTEND_URL (separados por coma). Fuera de producción también se
// acepta cualquier puerto de localhost, porque Vite cambia de puerto (5173, 5174…) si el suyo está ocupado.
const isProduction = process.env.NODE_ENV === 'production';
const configuredOrigins = (process.env.FRONTEND_URL || '').split(',').map((o) => o.trim()).filter(Boolean);
const LOCAL_DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/;
const isAllowedOrigin = (origin) => configuredOrigins.includes(origin) || (!isProduction && LOCAL_DEV_ORIGIN.test(origin));

// Middlewares
app.use(helmet({
  // Los escudos (/uploads) se muestran desde el dominio del frontend.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(
  cors({
    // Sin cabecera Origin (curl, servidor a servidor) no aplica CORS. Un origen no listado
    // no recibe cabeceras CORS y el navegador bloquea la respuesta.
    origin: (origin, callback) => callback(null, !origin || isAllowedOrigin(origin)),
  })
);
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}
// Límite de tamaño: evita payloads enormes (por ejemplo contraseñas gigantes para bcrypt).
app.use(express.json({ limit: '10kb' }));
// Flow envía la confirmación y el retorno como formulario (application/x-www-form-urlencoded).
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// Escudos de equipos (WebP generados por el backend). En producción conviene servirlos con Nginx o S3/CloudFront.
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '30d', immutable: true, index: false, dotfiles: 'deny' }));

// Estado del servicio (para el balanceador / monitoreo). No expone datos internos.
app.get(['/', '/api/salud'], async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ estado: 'ok', servicio: 'StatsHub API' });
  } catch (error) {
    console.error('Salud: sin conexión a la base de datos:', error.message);
    res.status(503).json({ estado: 'error', detalle: 'Sin conexión a la base de datos' });
  }
});

// Rutas
app.use('/api/auth', authRoutes);
app.use('/api', deportivosRoutes);

// Ruta inexistente: JSON en vez de la página HTML por defecto de Express.
app.use((req, res) => {
  res.status(404).json({ error: `No existe la ruta ${req.method} ${req.path}` });
});

// Manejador global de errores. Los controladores pueden lanzar AppError (utils/errors.js);
// Express 5 también envía aquí los rechazos de funciones async.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'El cuerpo de la petición no es JSON válido' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'El cuerpo de la petición es demasiado grande' });
  }
  if (err.name === 'MulterError') {
    return err.code === 'LIMIT_FILE_SIZE'
      ? res.status(413).json({ error: 'La imagen no puede superar 2 MB' })
      : res.status(400).json({ error: 'Archivo inválido' });
  }
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message, ...(err.detalles && { detalles: err.detalles }) });
  }

  switch (err.code) {
    case PG_ERRORS.INVALID_TEXT_REPRESENTATION:
      return res.status(400).json({ error: 'Algún identificador o valor tiene un formato inválido' });
    case PG_ERRORS.CHECK_VIOLATION:
      return res.status(400).json({ error: 'Los datos no cumplen las reglas de validación' });
    case PG_ERRORS.UNIQUE_VIOLATION:
      return res.status(409).json({ error: 'Ya existe un registro con esos datos' });
    case PG_ERRORS.FOREIGN_KEY_VIOLATION:
      return res.status(409).json({ error: 'La operación entra en conflicto con datos relacionados' });
    default:
      console.error(err);
      return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = app;
