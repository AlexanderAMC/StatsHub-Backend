const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// Sin este manejador, un error en un cliente inactivo (p. ej. si se reinicia PostgreSQL)
// emite un 'error' no capturado y tumba el proceso. El pool descarta ese cliente y sigue.
pool.on('error', (error) => {
  console.error('⚠️  Error en una conexión inactiva de PostgreSQL:', error.message);
});

module.exports = pool;