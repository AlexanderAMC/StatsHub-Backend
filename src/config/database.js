const { Pool, types } = require('pg');

// Las columnas DATE se devuelven como texto 'AAAA-MM-DD'. Convertirlas a Date de JavaScript
// las desplaza según el huso horario del servidor (p. ej. 2027-03-01 → 2027-02-28T23:00Z).
types.setTypeParser(1082, (value) => value);
// TIMESTAMP sin zona (hora local del partido): se devuelve 'AAAA-MM-DDTHH:MM:SS' sin convertir a UTC.
types.setTypeParser(1114, (value) => value.replace(' ', 'T'));
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