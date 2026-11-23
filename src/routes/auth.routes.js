const express = require('express');
const router = express.Router();

const auth = require('../controllers/auth.controller');
const { authenticate, requirePermission } = require('../middleware/auth');
const { loginLimiter, registerLimiter, forgotLimiter } = require('../middleware/rateLimit');
const { PERMISSIONS } = require('../config/permissions');

// Rutas públicas de autenticación (con límite de intentos)
router.post('/login', loginLimiter, auth.login);
router.post('/register', registerLimiter, auth.register);
router.post('/forgot-password', forgotLimiter, auth.forgotPassword);
router.post('/reset-password', forgotLimiter, auth.resetPassword);

// Sesión propia
router.post('/logout', authenticate, auth.logout);
router.get('/me', authenticate, auth.getMe);
router.put('/me', authenticate, auth.updateMe);
router.put('/me/password', authenticate, auth.changePassword);

// Gestión de usuarios: requiere sesión válida y el permiso usuarios:gestionar (solo ADMINISTRADOR)
router.use('/users', authenticate, requirePermission(PERMISSIONS.MANAGE_USERS));
router.get('/users', auth.getUsuarios);
router.post('/users', auth.createUser);
router.put('/users/:id', auth.updateUser);
router.put('/users/:id/role', auth.updateUserRole);
router.put('/users/:id/status', auth.updateUserStatus);
router.delete('/users/:id', auth.deleteUser);

module.exports = router;
