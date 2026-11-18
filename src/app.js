const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const pool = require('./config/database');
const deportivosRoutes = require('./routes/deportivos.routes');
const authRoutes = require('./routes/auth.routes');
const { AppError, PG_ERRORS } = require('./utils/errors');

const app = express();

// Orígenes permitidos para CORS (separados por coma). En desarrollo, por defecto el servidor de Vite.
const DEFAULT_DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map((o) => o.trim()).filter(Boolean)
  : process.env.NODE_ENV === 'production'
    ? []
    : DEFAULT_DEV_ORIGINS;

// Middlewares
app.use(helmet());
app.use(
  cors({
    // Sin cabecera Origin (curl, servidor a servidor) no aplica CORS. Un origen no listado
    // no recibe cabeceras CORS y el navegador bloquea la respuesta.
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)),
  })
);
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}
// Límite de tamaño: evita payloads enormes (por ejemplo contraseñas gigantes para bcrypt).
app.use(express.json({ limit: '10kb' }));

// Ruta de prueba de conexión
app.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      mensaje: 'API StatsHub funcionando correctamente',
      hora_db: result.rows[0].now,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error conectando a la base de datos' });
  }
});

// Rutas
app.use('/api', deportivosRoutes);
app.use('/api/auth', authRoutes);

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
