const crypto = require('node:crypto');
const pool = require('../config/database');
const bcrypt = require('bcrypt');
const { audit } = require('../utils/audit');
const { sendMail } = require('../services/mailer');
const jwt = require('jsonwebtoken');
const { getJwtSecret, JWT_ALGORITHM, JWT_EXPIRES_IN } = require('../config/jwt');
const { ROLES, DEFAULT_ROLE, ASSIGNABLE_ROLES, normalizeRole } = require('../config/roles');
const { isUuid, isValidEmail, normalizeEmail, validateLogin, validateRegister } = require('../utils/validators');
const { badRequest } = require('../utils/errors');

const BCRYPT_ROUNDS = 12;
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const USER_STATUSES = ['activo', 'bloqueado'];

// Hash ficticio para comparar cuando el correo no existe: así la respuesta tarda lo mismo
// exista o no la cuenta, y no se puede averiguar qué correos están registrados.
const DUMMY_HASH = bcrypt.hashSync('statshub-usuario-inexistente', BCRYPT_ROUNDS);

const INVALID_CREDENTIALS = 'Credenciales inválidas';
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hora

// El JWT lleva la versión del token (tv): al cerrar sesión o cambiar la contraseña se
// incrementa en la BD y todos los tokens anteriores quedan inválidos (RF-02).
const signToken = (usuario) =>
  jwt.sign({ id: usuario.id, rol: usuario.rol, tv: usuario.token_version ?? 0 }, getJwtSecret(), {
    algorithm: JWT_ALGORITHM,
    expiresIn: JWT_EXPIRES_IN,
  });

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function findUserWithRole(id) {
  const { rows } = await pool.query(
    `SELECT u.id, u.activo, r.nombre AS rol
     FROM seguridad.usuarios u
     JOIN seguridad.roles r ON u.rol_id = r.id
     WHERE u.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function countActiveAdmins() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM seguridad.usuarios u
     JOIN seguridad.roles r ON u.rol_id = r.id
     WHERE UPPER(r.nombre) = $1 AND u.activo = true`,
    [ROLES.ADMIN]
  );
  return rows[0].total;
}

const isActiveAdmin = (user) => user.activo && normalizeRole(user.rol) === ROLES.ADMIN;

// 1. INICIAR SESIÓN
const login = async (req, res) => {
  const errors = validateLogin(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ error: errors[0], detalles: errors });
  }

  const correo = normalizeEmail(req.body.correo);
  const { password } = req.body;

  try {
    const result = await pool.query(
      `SELECT u.id, u.nombre, u.apellido, u.correo, u.password_hash, u.activo, u.token_version,
              u.acepta_privacidad_en, r.nombre AS rol
       FROM seguridad.usuarios u
       JOIN seguridad.roles r ON u.rol_id = r.id
       WHERE LOWER(u.correo) = $1`,
      [correo]
    );
    const usuario = result.rows[0];

    const passwordValido = await bcrypt.compare(password, usuario ? usuario.password_hash : DUMMY_HASH);
    if (!usuario || !passwordValido) {
      return res.status(401).json({ error: INVALID_CREDENTIALS });
    }

    // Solo se informa del bloqueo a quien ya demostró conocer la contraseña.
    if (!usuario.activo) {
      return res.status(403).json({ error: 'Usuario desactivado' });
    }

    const token = signToken(usuario);
    audit(req, { accion: 'LOGIN', tabla: 'seguridad.usuarios', registroId: usuario.id, usuarioId: usuario.id });

    return res.json({
      mensaje: 'Login exitoso',
      token,
      usuario: {
        id: usuario.id,
        nombre: usuario.nombre,
        apellido: usuario.apellido,
        correo: usuario.correo,
        rol: usuario.rol,
        acepta_privacidad_en: usuario.acepta_privacidad_en ?? null,
      },
    });
  } catch (error) {
    console.error('Error en login:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// 2. REGISTRAR NUEVO USUARIO (siempre con el rol por defecto, nunca elegido por el cliente)
const register = async (req, res) => {
  const errors = validateRegister(req.body);
  // RNF-11 (Ley 19.628): sin aceptación explícita del tratamiento de datos no se crea la cuenta.
  if (req.body?.aceptaPrivacidad !== true) {
    errors.push('Debes aceptar la política de privacidad y tratamiento de datos (Ley 19.628)');
  }
  if (errors.length > 0) {
    return res.status(400).json({ error: errors[0], detalles: errors });
  }

  const nombre = req.body.nombre.trim();
  const apellido = req.body.apellido.trim();
  const correo = normalizeEmail(req.body.correo);
  const { password } = req.body;

  try {
    const roleQuery = await pool.query('SELECT id FROM seguridad.roles WHERE UPPER(nombre) = $1 LIMIT 1', [
      DEFAULT_ROLE,
    ]);
    if (roleQuery.rows.length === 0) {
      // Nunca se asigna otro rol como alternativa: antes se caía al id 1 (ADMINISTRADOR).
      console.error(`Registro bloqueado: no existe el rol ${DEFAULT_ROLE} en seguridad.roles`);
      return res.status(500).json({ error: 'El registro no está disponible en este momento' });
    }
    const rolId = roleQuery.rows[0].id;

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const newUser = await pool.query(
      `INSERT INTO seguridad.usuarios (nombre, apellido, correo, password_hash, rol_id, activo, acepta_privacidad_en)
       VALUES ($1, $2, $3, $4, $5, true, now())
       RETURNING id, nombre, apellido, correo`,
      [nombre, apellido, correo, passwordHash, rolId]
    );

    return res.status(201).json({
      mensaje: 'Usuario registrado exitosamente',
      usuario: newUser.rows[0],
    });
  } catch (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      return res.status(409).json({ error: 'El correo ya está registrado' });
    }
    console.error('Error en registro:', error);
    return res.status(500).json({ error: 'Error al registrar el usuario' });
  }
};

// 3. LISTAR USUARIOS (solo admin)
const getUsuarios = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.nombre, u.apellido, u.correo, u.activo, r.nombre AS rol
       FROM seguridad.usuarios u
       JOIN seguridad.roles r ON u.rol_id = r.id
       ORDER BY u.fecha_creacion DESC`
    );
    return res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener usuarios:', error);
    return res.status(500).json({ error: 'Error al obtener usuarios' });
  }
};

// 4. CAMBIAR ROL (solo admin)
const updateUserRole = async (req, res) => {
  const { id } = req.params;
  const newRole = normalizeRole(req.body?.role);

  if (!isUuid(id)) return res.status(400).json({ error: 'Identificador de usuario inválido' });
  if (!ASSIGNABLE_ROLES.includes(newRole)) return res.status(400).json({ error: 'Rol inválido' });

  try {
    const target = await findUserWithRole(id);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

    const demotingAdmin = isActiveAdmin(target) && newRole !== ROLES.ADMIN;
    if (demotingAdmin && target.id === req.user.id) {
      return res.status(400).json({ error: 'No puedes quitarte a ti mismo el rol de administrador' });
    }
    if (demotingAdmin && (await countActiveAdmins()) <= 1) {
      return res.status(409).json({ error: 'Debe quedar al menos un administrador activo' });
    }

    const roleResult = await pool.query('SELECT id FROM seguridad.roles WHERE UPPER(nombre) = $1', [newRole]);
    if (roleResult.rows.length === 0) return res.status(400).json({ error: 'Rol inválido' });

    await pool.query('UPDATE seguridad.usuarios SET rol_id = $1 WHERE id = $2', [roleResult.rows[0].id, id]);
    audit(req, { accion: 'CAMBIAR_ROL', tabla: 'seguridad.usuarios', registroId: id, detalle: { de: target.rol, a: newRole } });
    return res.json({ mensaje: 'Rol actualizado correctamente' });
  } catch (error) {
    console.error('Error al actualizar el rol:', error);
    return res.status(500).json({ error: 'Error al actualizar el rol' });
  }
};

// 5. BLOQUEAR / ACTIVAR (solo admin)
const updateUserStatus = async (req, res) => {
  const { id } = req.params;
  const status = req.body?.status;

  if (!isUuid(id)) return res.status(400).json({ error: 'Identificador de usuario inválido' });
  if (!USER_STATUSES.includes(status)) {
    return res.status(400).json({ error: "Estado inválido: usa 'activo' o 'bloqueado'" });
  }

  try {
    const target = await findUserWithRole(id);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

    const activo = status === 'activo';
    if (!activo && target.id === req.user.id) {
      return res.status(400).json({ error: 'No puedes bloquear tu propia cuenta' });
    }
    if (!activo && isActiveAdmin(target) && (await countActiveAdmins()) <= 1) {
      return res.status(409).json({ error: 'Debe quedar al menos un administrador activo' });
    }

    await pool.query('UPDATE seguridad.usuarios SET activo = $1 WHERE id = $2', [activo, id]);
    audit(req, { accion: activo ? 'ACTIVAR_USUARIO' : 'BLOQUEAR_USUARIO', tabla: 'seguridad.usuarios', registroId: id });
    return res.json({ mensaje: 'Estado actualizado correctamente' });
  } catch (error) {
    console.error('Error al actualizar el estado:', error);
    return res.status(500).json({ error: 'Error al actualizar el estado' });
  }
};

// 6. ELIMINAR (solo admin)
const deleteUser = async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'Identificador de usuario inválido' });

  try {
    const target = await findUserWithRole(id);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

    if (target.id === req.user.id) {
      return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
    }
    if (isActiveAdmin(target) && (await countActiveAdmins()) <= 1) {
      return res.status(409).json({ error: 'Debe quedar al menos un administrador activo' });
    }

    await pool.query('DELETE FROM seguridad.usuarios WHERE id = $1', [id]);
    audit(req, { accion: 'ELIMINAR_USUARIO', tabla: 'seguridad.usuarios', registroId: id });
    return res.json({ mensaje: 'Usuario eliminado correctamente' });
  } catch (error) {
    if (error.code === PG_FOREIGN_KEY_VIOLATION) {
      return res.status(409).json({
        error: 'El usuario tiene datos asociados y no se puede eliminar. Bloquéalo en su lugar.',
      });
    }
    console.error('Error al eliminar el usuario:', error);
    return res.status(500).json({ error: 'Error al eliminar el usuario' });
  }
};

// 7. CERRAR SESIÓN (RF-02): invalida este token y todos los anteriores del usuario.
const logout = async (req, res) => {
  await pool.query('UPDATE seguridad.usuarios SET token_version = token_version + 1 WHERE id = $1', [req.user.id]);
  audit(req, { accion: 'LOGOUT', tabla: 'seguridad.usuarios', registroId: req.user.id });
  return res.status(204).end();
};

// 8. PERFIL PROPIO
const PROFILE_SQL = `
  SELECT u.id, u.nombre, u.apellido, u.correo, u.telefono, u.activo, u.acepta_privacidad_en,
         u.recibe_notificaciones, u.fecha_creacion, r.nombre AS rol,
         (SELECT e.id FROM deportivo.equipos e WHERE e.entrenador_id = u.id ORDER BY e.id LIMIT 1) AS equipo_id
  FROM seguridad.usuarios u
  JOIN seguridad.roles r ON u.rol_id = r.id
  WHERE u.id = $1`;

const getMe = async (req, res) => {
  const { rows } = await pool.query(PROFILE_SQL, [req.user.id]);
  return res.json(rows[0]);
};

const updateMe = async (req, res) => {
  const body = req.body ?? {};
  const sets = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    sets.push(`${sql} = $${params.length}`);
  };

  if (body.nombre !== undefined) {
    if (typeof body.nombre !== 'string' || !body.nombre.trim() || body.nombre.length > 100) throw badRequest('Nombre inválido');
    add('nombre', body.nombre.trim());
  }
  if (body.apellido !== undefined) {
    if (typeof body.apellido !== 'string' || !body.apellido.trim() || body.apellido.length > 100) throw badRequest('Apellido inválido');
    add('apellido', body.apellido.trim());
  }
  if (body.telefono !== undefined) {
    if (body.telefono !== null && (typeof body.telefono !== 'string' || body.telefono.length > 20)) throw badRequest('Teléfono inválido');
    add('telefono', body.telefono || null);
  }
  if (body.recibeNotificaciones !== undefined) add('recibe_notificaciones', Boolean(body.recibeNotificaciones));
  // La aceptación de la política solo se puede dar (no retirar desde aquí: retirarla implica cerrar la cuenta).
  if (body.aceptaPrivacidad === true) sets.push('acepta_privacidad_en = COALESCE(acepta_privacidad_en, now())');

  if (sets.length === 0) throw badRequest('No hay cambios que guardar');
  params.push(req.user.id);
  await pool.query(`UPDATE seguridad.usuarios SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  const { rows } = await pool.query(PROFILE_SQL, [req.user.id]);
  return res.json(rows[0]);
};

// 9. CAMBIAR CONTRASEÑA: exige la actual e invalida las demás sesiones.
const changePassword = async (req, res) => {
  const { actual, nueva } = req.body ?? {};
  const errors = validateRegister({ nombre: 'x', apellido: 'x', correo: 'a@b.cl', password: nueva });
  if (typeof actual !== 'string' || !actual) throw badRequest('Ingresa tu contraseña actual');
  if (errors.length > 0) throw badRequest(errors[0]);

  const { rows } = await pool.query('SELECT password_hash FROM seguridad.usuarios WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(actual, rows[0].password_hash))) {
    return res.status(400).json({ error: 'La contraseña actual no es correcta' });
  }
  const hash = await bcrypt.hash(nueva, BCRYPT_ROUNDS);
  const updated = await pool.query(
    `UPDATE seguridad.usuarios SET password_hash = $1, token_version = token_version + 1
     WHERE id = $2 RETURNING id, token_version, (SELECT nombre FROM seguridad.roles WHERE id = rol_id) AS rol`,
    [hash, req.user.id]
  );
  audit(req, { accion: 'CAMBIO_PASSWORD', tabla: 'seguridad.usuarios', registroId: req.user.id });
  // Se entrega un token nuevo para que esta sesión siga activa; las demás quedan cerradas.
  return res.json({ mensaje: 'Contraseña actualizada', token: signToken(updated.rows[0]) });
};

// 10. RECUPERAR CONTRASEÑA (RF-03): respuesta idéntica exista o no el correo.
const GENERIC_RESET_MESSAGE = 'Si el correo está registrado, te enviamos las instrucciones para restablecer tu contraseña.';

const forgotPassword = async (req, res) => {
  const correo = normalizeEmail(req.body?.correo);
  if (!isValidEmail(correo)) throw badRequest('Ingresa un correo válido');

  const { rows } = await pool.query(
    'SELECT id, nombre FROM seguridad.usuarios WHERE LOWER(correo) = $1 AND activo = true',
    [correo]
  );
  if (rows.length > 0) {
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO seguridad.password_resets (usuario_id, token_hash, expira_en) VALUES ($1, $2, $3)`,
      [rows[0].id, sha256(token), new Date(Date.now() + RESET_TOKEN_TTL_MS)]
    );
    const base = (process.env.FRONTEND_PUBLIC_URL || (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0]).replace(/\/$/, '');
    const link = `${base}/restablecer?token=${token}`;
    await sendMail({
      to: correo,
      subject: 'Restablecer tu contraseña de StatsHub Deportivo',
      text: `Hola ${rows[0].nombre}:\n\nPara crear una nueva contraseña abre este enlace (válido por 1 hora):\n${link}\n\nSi no lo solicitaste, ignora este correo.`,
    });
    audit(req, { accion: 'SOLICITUD_RESET_PASSWORD', tabla: 'seguridad.usuarios', registroId: rows[0].id, usuarioId: rows[0].id });
  }
  return res.json({ mensaje: GENERIC_RESET_MESSAGE });
};

const resetPassword = async (req, res) => {
  const { token, password } = req.body ?? {};
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw badRequest('El enlace no es válido');
  const errors = validateRegister({ nombre: 'x', apellido: 'x', correo: 'a@b.cl', password });
  if (errors.length > 0) throw badRequest(errors[0]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, usuario_id FROM seguridad.password_resets
       WHERE token_hash = $1 AND usado_en IS NULL AND expira_en > now()
       FOR UPDATE`,
      [sha256(token)]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'El enlace expiró o ya fue utilizado. Solicita uno nuevo.' });
    }
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await client.query(
      'UPDATE seguridad.usuarios SET password_hash = $1, token_version = token_version + 1 WHERE id = $2',
      [hash, rows[0].usuario_id]
    );
    // Un solo uso: se invalidan todos los enlaces pendientes del usuario.
    await client.query(
      'UPDATE seguridad.password_resets SET usado_en = now() WHERE usuario_id = $1 AND usado_en IS NULL',
      [rows[0].usuario_id]
    );
    await client.query('COMMIT');
    audit(req, { accion: 'RESET_PASSWORD', tabla: 'seguridad.usuarios', registroId: rows[0].usuario_id, usuarioId: rows[0].usuario_id });
    return res.json({ mensaje: 'Tu contraseña fue actualizada. Ya puedes iniciar sesión.' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

// 11. CREAR USUARIO (admin, RF-04 / CP-02): con rol y contraseña inicial.
const createUser = async (req, res) => {
  const body = req.body ?? {};
  const errors = validateRegister(body);
  const rol = normalizeRole(body.rol);
  if (!ASSIGNABLE_ROLES.includes(rol)) errors.push('Rol inválido');
  if (errors.length > 0) return res.status(400).json({ error: errors[0], detalles: errors });

  const roleResult = await pool.query('SELECT id FROM seguridad.roles WHERE UPPER(nombre) = $1', [rol]);
  if (roleResult.rows.length === 0) throw badRequest('Rol inválido');
  const hash = await bcrypt.hash(body.password, BCRYPT_ROUNDS);
  try {
    const { rows } = await pool.query(
      `INSERT INTO seguridad.usuarios (nombre, apellido, correo, password_hash, telefono, rol_id, activo)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id, nombre, apellido, correo, activo`,
      [body.nombre.trim(), body.apellido.trim(), normalizeEmail(body.correo), hash, body.telefono || null, roleResult.rows[0].id]
    );
    audit(req, { accion: 'CREAR_USUARIO', tabla: 'seguridad.usuarios', registroId: rows[0].id, detalle: { rol } });
    return res.status(201).json({ ...rows[0], rol });
  } catch (error) {
    if (error.code === PG_UNIQUE_VIOLATION) return res.status(409).json({ error: 'El correo ya está registrado' });
    throw error;
  }
};

// 12. EDITAR DATOS DE UN USUARIO (admin, RF-04)
const updateUser = async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) throw badRequest('Identificador de usuario inválido');
  const body = req.body ?? {};
  const errors = [];
  if (typeof body.nombre !== 'string' || !body.nombre.trim() || body.nombre.length > 100) errors.push('Nombre inválido');
  if (typeof body.apellido !== 'string' || !body.apellido.trim() || body.apellido.length > 100) errors.push('Apellido inválido');
  if (!isValidEmail(body.correo)) errors.push('El correo no es válido');
  if (errors.length > 0) return res.status(400).json({ error: errors[0], detalles: errors });

  try {
    const { rows } = await pool.query(
      `UPDATE seguridad.usuarios SET nombre = $1, apellido = $2, correo = $3, telefono = $4
       WHERE id = $5 RETURNING id`,
      [body.nombre.trim(), body.apellido.trim(), normalizeEmail(body.correo), body.telefono || null, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    audit(req, { accion: 'EDITAR_USUARIO', tabla: 'seguridad.usuarios', registroId: id });
    return res.json({ mensaje: 'Usuario actualizado' });
  } catch (error) {
    if (error.code === PG_UNIQUE_VIOLATION) return res.status(409).json({ error: 'El correo ya está registrado' });
    throw error;
  }
};

module.exports = {
  login, register, getUsuarios, updateUserRole, updateUserStatus, deleteUser,
  logout, getMe, updateMe, changePassword, forgotPassword, resetPassword, createUser, updateUser,
};
