const express = require('express');
const cors = require('cors');
const pool = require('./config/database');
const deportivosRoutes = require('./routes/deportivos.routes');
const authRoutes = require('./routes/auth.routes');

const app = express();

// Middlewares
app.use(cors());
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

// Errores de parseo del body (JSON mal formado o demasiado grande): responder JSON, no HTML.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'El cuerpo de la petición no es JSON válido' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'El cuerpo de la petición es demasiado grande' });
  }
  console.error(err);
  return res.status(500).json({ error: 'Error interno del servidor' });
});

module.exports = app;
