require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./config/database'); 
const deportivosRoutes = require('./routes/deportivos.routes');

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Ruta de prueba de conexión
app.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ 
      mensaje: 'API StatsHub funcionando correctamente', 
      hora_db: result.rows[0].now 
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error conectando a la base de datos' });
  }
});

// Rutas
app.use('/api', deportivosRoutes);

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});