const express = require('express');
const router = express.Router();

// Importamos TODAS las funciones
const { 
  login, 
  register, 
  getUsuarios, 
  updateUserRole, 
  updateUserStatus, 
  deleteUser 
} = require('../controllers/auth.controller');

// Rutas de autenticación
router.post('/login', login);       // <-- Asegúrate de que ESTA línea esté aquí
router.post('/register', register); // <-- Y esta también

// Rutas de usuarios
router.get('/users', getUsuarios);
router.put('/users/:id/role', updateUserRole);
router.put('/users/:id/status', updateUserStatus);
router.delete('/users/:id', deleteUser);

module.exports = router;