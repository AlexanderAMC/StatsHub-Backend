const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const { getJwtSecret, JWT_ALGORITHM } = require('../config/jwt');
const { normalizeRole } = require('../config/roles');
const { hasPermission } = require('../config/permissions');

// Verifica el JWT del header Authorization y carga req.user.
// El estado y el rol se leen de la BD en cada petición: un usuario bloqueado
// o al que se le cambió el rol pierde el acceso de inmediato, sin esperar a que expire el token.
async function authenticate(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Debes iniciar sesión' });
  }

  let payload;
  try {
    payload = jwt.verify(token, getJwtSecret(), { algorithms: [JWT_ALGORITHM] });
  } catch {
    return res.status(401).json({ error: 'Sesión inválida o expirada' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.activo, u.token_version, r.nombre AS rol
       FROM seguridad.usuarios u
       JOIN seguridad.roles r ON u.rol_id = r.id
       WHERE u.id = $1`,
      [payload.id]
    );

    const usuario = rows[0];
    // token_version cambia al cerrar sesión o cambiar la contraseña: invalida los tokens anteriores (RF-02).
    const tokenVersion = usuario?.token_version ?? 0;
    if (!usuario || !usuario.activo || (payload.tv ?? 0) !== tokenVersion) {
      return res.status(401).json({ error: 'Sesión inválida o expirada' });
    }

    req.user = { id: usuario.id, rol: normalizeRole(usuario.rol) };
    return next();
  } catch (error) {
    console.error('Error verificando sesión:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// Exige que req.user tenga uno de los roles indicados. Usar después de authenticate.
function requireRole(...roles) {
  const allowed = roles.map(normalizeRole);

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Debes iniciar sesión' });
    }
    if (!allowed.includes(req.user.rol)) {
      return res.status(403).json({ error: 'No tienes permisos para esta acción' });
    }
    return next();
  };
}

// Exige un permiso RBAC (ver config/permissions.js). Usar después de authenticate.
// Preferible a requireRole: los endpoints declaran QUÉ se necesita, no QUIÉN puede.
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Debes iniciar sesión' });
    }
    if (!hasPermission(req.user.rol, permission)) {
      return res.status(403).json({ error: 'No tienes permisos para esta acción' });
    }
    return next();
  };
}

// Para rutas públicas que muestran algo extra a quien tiene sesión: si hay un token válido
// carga req.user; si no hay token o es inválido, continúa como anónimo.
async function optionalAuth(req, res, next) {
  if (!req.headers.authorization) return next();
  return authenticate(req, res, next);
}

module.exports = { authenticate, optionalAuth, requireRole, requirePermission };
