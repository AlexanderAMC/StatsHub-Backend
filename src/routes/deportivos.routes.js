const express = require('express');
const router = express.Router();
const deportivosController = require('../controllers/deportivos.controller');

router.get('/torneos', deportivosController.getTorneos);
router.get('/equipos', deportivosController.getEquipos);
router.get('/partidos', deportivosController.getPartidos);

module.exports = router;