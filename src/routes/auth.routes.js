const express = require('express');
const router = express.Router();

const {
  login,
  register,
  getUsuarios,
  updateUserRole,
  updateUserStatus,
  deleteUser,
} = require('../controllers/auth.controller');
const { authenticate, requirePermission } = require('../middleware/auth');
const { loginLimiter, registerLimiter } = require('../middleware/rateLimit');
const { PERMISSIONS } = require('../config/permissions');

// Rutas públicas de autenticación (con límite de intentos)
router.post('/login', loginLimiter, login);
router.post('/register', registerLimiter, register);

// Gestión de usuarios: requiere sesión válida y el permiso usuarios:gestionar (solo ADMINISTRADOR)
router.use('/users', authenticate, requirePermission(PERMISSIONS.MANAGE_USERS));
router.get('/users', getUsuarios);
router.put('/users/:id/role', updateUserRole);
router.put('/users/:id/status', updateUserStatus);
router.delete('/users/:id', deleteUser);

module.exports = router;
