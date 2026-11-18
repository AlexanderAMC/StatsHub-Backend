const pool = require('../config/database');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { getJwtSecret, JWT_ALGORITHM, JWT_EXPIRES_IN } = require('../config/jwt');
const { ROLES, DEFAULT_ROLE, ASSIGNABLE_ROLES, normalizeRole } = require('../config/roles');
const { isUuid, normalizeEmail, validateLogin, validateRegister } = require('../utils/validators');

const BCRYPT_ROUNDS = 12;
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const USER_STATUSES = ['activo', 'bloqueado'];

// Hash ficticio para comparar cuando el correo no existe: así la respuesta tarda lo mismo
// exista o no la cuenta, y no se puede averiguar qué correos están registrados.
const DUMMY_HASH = bcrypt.hashSync('statshub-usuario-inexistente', BCRYPT_ROUNDS);

const INVALID_CREDENTIALS = 'Credenciales inválidas';

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
      `SELECT u.id, u.nombre, u.apellido, u.correo, u.password_hash, u.activo, r.nombre AS rol
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

    const token = jwt.sign({ id: usuario.id, rol: usuario.rol }, getJwtSecret(), {
      algorithm: JWT_ALGORITHM,
      expiresIn: JWT_EXPIRES_IN,
    });

    return res.json({
      mensaje: 'Login exitoso',
      token,
      usuario: {
        id: usuario.id,
        nombre: usuario.nombre,
        apellido: usuario.apellido,
        correo: usuario.correo,
        rol: usuario.rol,
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
      `INSERT INTO seguridad.usuarios (nombre, apellido, correo, password_hash, rol_id, activo)
       VALUES ($1, $2, $3, $4, $5, true)
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

module.exports = { login, register, getUsuarios, updateUserRole, updateUserStatus, deleteUser };
