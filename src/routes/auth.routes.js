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
const { authenticate, requireRole } = require('../middleware/auth');
const { loginLimiter, registerLimiter } = require('../middleware/rateLimit');
const { ROLES } = require('../config/roles');

// Rutas públicas de autenticación (con límite de intentos)
router.post('/login', loginLimiter, login);
router.post('/register', registerLimiter, register);

// Gestión de usuarios: solo administradores con sesión válida
router.use('/users', authenticate, requireRole(ROLES.ADMIN));
router.get('/users', getUsuarios);
router.put('/users/:id/role', updateUserRole);
router.put('/users/:id/status', updateUserStatus);
router.delete('/users/:id', deleteUser);

module.exports = router;
