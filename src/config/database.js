const fs = require('node:fs');
const { Pool, types } = require('pg');

// Las columnas DATE se devuelven como texto 'AAAA-MM-DD'. Convertirlas a Date de JavaScript
// las desplaza según el huso horario del servidor (p. ej. 2027-03-01 → 2027-02-28T23:00Z).
types.setTypeParser(1082, (value) => value);
// TIMESTAMP sin zona (hora local del partido): se devuelve 'AAAA-MM-DDTHH:MM:SS' sin convertir a UTC.
types.setTypeParser(1114, (value) => value.replace(' ', 'T'));
require('dotenv').config();

// Conexión cifrada (obligatoria en Amazon RDS: desde PostgreSQL 15, rds.force_ssl=1 por defecto).
//   DB_SSL=true                       → cifra la conexión
//   DB_SSL_CA=/ruta/global-bundle.pem → además verifica que el servidor sea realmente RDS (recomendado)
function sslConfig() {
  if (process.env.DB_SSL !== 'true') return undefined;
  if (process.env.DB_SSL_CA) {
    return { ca: fs.readFileSync(process.env.DB_SSL_CA, 'utf8'), rejectUnauthorized: true };
  }
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: sslConfig(),
});

// Sin este manejador, un error en un cliente inactivo (p. ej. si se reinicia PostgreSQL)
// emite un 'error' no capturado y tumba el proceso. El pool descarta ese cliente y sigue.
pool.on('error', (error) => {
  console.error('⚠️  Error en una conexión inactiva de PostgreSQL:', error.message);
});

module.exports = pool;