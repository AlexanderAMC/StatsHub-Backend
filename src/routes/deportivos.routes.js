const express = require('express');
const multer = require('multer');
const router = express.Router();

const catalogo = require('../controllers/catalogo.controller');
const equipos = require('../controllers/equipos.controller');
const partidos = require('../controllers/partidos.controller');
const estadisticas = require('../controllers/estadisticas.controller');
const notificaciones = require('../controllers/notificaciones.controller');
const pagos = require('../controllers/pagos.controller');
const auditoria = require('../controllers/auditoria.controller');
const { subscribe } = require('../realtime/hub');
const { authenticate, requirePermission } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rateLimit');
const { PERMISSIONS } = require('../config/permissions');
const { badRequest } = require('../utils/errors');

const P = PERMISSIONS;
const can = (permission) => [authenticate, requirePermission(permission)];

// Escudos: máximo 2 MB y solo imágenes (sharp vuelve a validar el contenido real).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    /^image\/(png|jpe?g|webp|gif|avif)$/.test(file.mimetype) ? cb(null, true) : cb(badRequest('El escudo debe ser una imagen PNG, JPG, WebP, GIF o AVIF')),
});

// ---------- Portal público (sin sesión, RF-42 a RF-44 / HU-04) ----------
router.get('/liga', catalogo.getLiga);
router.get('/categorias', catalogo.listCategorias);
router.get('/torneos', catalogo.listTorneos);
router.get('/equipos', equipos.listEquipos);
router.get('/jugadores', equipos.listJugadores);
router.get('/transferencias', equipos.listTransferencias);
router.get('/partidos', partidos.listPartidos);
router.get('/eventos', partidos.listEventos);
router.get('/tiempo-real', subscribe);
router.get('/estadisticas/posiciones', estadisticas.posiciones);
router.get('/estadisticas/goleadores', estadisticas.goleadores);
router.get('/estadisticas/asistencias', estadisticas.asistencias);
router.get('/estadisticas/fair-play', estadisticas.fairPlay);
router.get('/estadisticas/predicciones', estadisticas.predicciones);
router.get('/estadisticas/equipos/:id/rendimiento', estadisticas.rendimientoEquipo);

// ---------- Liga, categorías y torneos ----------
router.put('/liga', ...can(P.MANAGE_TOURNAMENTS), catalogo.updateLiga);
router.post('/categorias', ...can(P.MANAGE_TOURNAMENTS), catalogo.createCategoria);
router.delete('/categorias/:id', ...can(P.MANAGE_TOURNAMENTS), catalogo.deleteCategoria);
router.post('/torneos', ...can(P.MANAGE_TOURNAMENTS), catalogo.createTorneo);
router.put('/torneos/:id', ...can(P.MANAGE_TOURNAMENTS), catalogo.updateTorneo);
router.delete('/torneos/:id', ...can(P.MANAGE_TOURNAMENTS), catalogo.deleteTorneo);
router.get('/oficiales', authenticate, catalogo.listOficiales);

// ---------- Equipos y jugadores ----------
router.post('/equipos', ...can(P.MANAGE_TEAMS), equipos.createEquipo);
router.put('/equipos/:id', ...can(P.MANAGE_TEAMS), equipos.updateEquipo);
router.delete('/equipos/:id', ...can(P.MANAGE_TEAMS), equipos.deleteEquipo);
router.post('/equipos/:id/escudo', ...can(P.MANAGE_TEAMS), uploadLimiter, upload.single('escudo'), equipos.uploadEscudo);
router.post('/jugadores', ...can(P.MANAGE_PLAYERS), equipos.createJugador);
router.put('/jugadores/:id', ...can(P.MANAGE_PLAYERS), equipos.updateJugador);
router.delete('/jugadores/:id', ...can(P.MANAGE_PLAYERS), equipos.deleteJugador);
router.post('/jugadores/:id/transferencia', ...can(P.MANAGE_TEAMS), equipos.transferJugador);

// ---------- Programación ----------
router.post('/partidos', ...can(P.SCHEDULE_MATCHES), partidos.createPartido);
router.post('/partidos/lote', ...can(P.SCHEDULE_MATCHES), partidos.createPartidosLote);
router.put('/partidos/:id', ...can(P.SCHEDULE_MATCHES), partidos.updatePartido);
router.post('/partidos/:id/suspender', ...can(P.SCHEDULE_MATCHES), partidos.suspenderPartido);
router.post('/partidos/:id/recordatorio', ...can(P.SCHEDULE_MATCHES), partidos.recordatorioPartido);

// ---------- Acta digital ----------
router.post('/partidos/:id/iniciar', ...can(P.RECORD_MATCHES), partidos.iniciarPartido);
router.put('/partidos/:id/minuto', ...can(P.RECORD_MATCHES), partidos.setMinuto);
router.post('/partidos/:id/eventos', ...can(P.RECORD_MATCHES), partidos.addEvento);
router.delete('/partidos/:id/eventos/ultimo', ...can(P.RECORD_MATCHES), partidos.undoUltimoEvento);
router.post('/partidos/:id/finalizar', ...can(P.RECORD_MATCHES), partidos.finalizarPartido);

// ---------- Notificaciones ----------
router.get('/notificaciones', authenticate, notificaciones.listNotificaciones);
router.post('/notificaciones/leidas', authenticate, notificaciones.marcarLeidas);

// ---------- Pagos con Flow ----------
router.post('/pagos/inscripcion', ...can(P.MANAGE_TEAMS), pagos.crearCobroInscripcion);
// Webhook y retorno: los llama Flow (sin JWT); el estado se verifica consultando a Flow.
router.post('/pagos/flow/confirmacion', pagos.confirmacionFlow);
router.all('/pagos/flow/retorno', pagos.retornoFlow);
router.get('/pagos', ...can(P.MANAGE_TEAMS), pagos.listPagos);
router.get('/pagos/:id', authenticate, pagos.getPago);

// ---------- Auditoría ----------
router.get('/auditoria', ...can(P.MANAGE_USERS), auditoria.listAuditoria);

module.exports = router;
