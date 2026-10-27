const express = require('express');
const router = express.Router();
const { login, register } = require('../controllers/auth.controller');

// Ruta para iniciar sesión
router.post('/login', login);

// Ruta para registrar un nuevo usuario
router.post('/register', register);

module.exports = router;