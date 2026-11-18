// Crea (o actualiza) el usuario administrador con una contraseña hasheada con bcrypt.
// La contraseña se lee del entorno y nunca queda escrita en el repositorio.
//
// Uso (PowerShell):
//   $env:ADMIN_EMAIL="admin@statshub.cl"; $env:ADMIN_PASSWORD="<contraseña segura>"; npm run create-admin
// Uso (bash):
//   ADMIN_EMAIL=admin@statshub.cl ADMIN_PASSWORD='<contraseña segura>' npm run create-admin
require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('../src/config/database');
const { ROLES } = require('../src/config/roles');
const { isValidEmail, normalizeEmail, PASSWORD_MAX_BYTES } = require('../src/utils/validators');

const BCRYPT_ROUNDS = 12;
const ADMIN_PASSWORD_MIN_LENGTH = 12;

async function main() {
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const password = process.env.ADMIN_PASSWORD || '';
  const nombre = (process.env.ADMIN_NOMBRE || 'Admin').trim();
  const apellido = (process.env.ADMIN_APELLIDO || 'StatsHub').trim();

  if (!isValidEmail(email)) {
    throw new Error('ADMIN_EMAIL no está definido o no es un correo válido.');
  }
  if (password.length < ADMIN_PASSWORD_MIN_LENGTH) {
    throw new Error(`ADMIN_PASSWORD debe tener al menos ${ADMIN_PASSWORD_MIN_LENGTH} caracteres.`);
  }
  if (Buffer.byteLength(password) > PASSWORD_MAX_BYTES) {
    throw new Error(`ADMIN_PASSWORD no puede superar ${PASSWORD_MAX_BYTES} bytes.`);
  }

  const roleResult = await pool.query('SELECT id FROM seguridad.roles WHERE UPPER(nombre) = $1', [ROLES.ADMIN]);
  if (roleResult.rows.length === 0) {
    throw new Error(`No existe el rol ${ROLES.ADMIN}. Ejecuta primero seeds/01_roles.sql.`);
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const { rows } = await pool.query(
    `INSERT INTO seguridad.usuarios (nombre, apellido, correo, password_hash, rol_id, activo)
     VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (correo) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           rol_id = EXCLUDED.rol_id,
           activo = true
     RETURNING id, correo, (xmax = 0) AS creado`,
    [nombre, apellido, email, passwordHash, roleResult.rows[0].id]
  );

  const accion = rows[0].creado ? 'creado' : 'actualizado';
  console.log(`✅ Administrador ${accion}: ${rows[0].correo}`);
}

main()
  .catch((error) => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
