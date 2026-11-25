const pool = require('../config/database');
const { ROLES } = require('../config/roles');
const { AppError, notFound } = require('./errors');

// Alcance de gestión:
//  - Administrador y organizador de la liga (rol): gestionan todo.
//  - Plan Ultra: solo los torneos de los que es dueño (torneos.organizador_id) y lo que contienen.
//  - Entrenador / plan Pro: solo el equipo que tiene asignado (equipos.entrenador_id).
const isLeagueManager = (user) => [ROLES.ADMIN, ROLES.ORGANIZER].includes(user?.rol);

const forbidden = (message) => new AppError(403, message);

async function assertTournamentAccess(req, torneoId, db = pool) {
  if (isLeagueManager(req.user)) return;
  const { rows } = await db.query('SELECT organizador_id FROM deportivo.torneos WHERE id = $1', [torneoId]);
  if (rows.length === 0) throw notFound('Torneo no encontrado');
  if (rows[0].organizador_id !== req.user.id) throw forbidden('Este torneo pertenece a otro organizador');
}

// Dueño de algún torneo donde está inscrito el equipo; con allowCoach, también su entrenador.
async function assertTeamAccess(req, equipoId, db = pool, { allowCoach = false } = {}) {
  if (isLeagueManager(req.user)) return;
  const { rows } = await db.query(
    `SELECT e.entrenador_id,
            EXISTS (SELECT 1 FROM deportivo.torneo_equipos te JOIN deportivo.torneos t ON t.id = te.torneo_id
                    WHERE te.equipo_id = e.id AND t.organizador_id = $2) AS es_dueno
     FROM deportivo.equipos e WHERE e.id = $1`,
    [equipoId, req.user.id]
  );
  if (rows.length === 0) throw notFound('Equipo no encontrado');
  if (rows[0].es_dueno) return;
  if (allowCoach && rows[0].entrenador_id === req.user.id) return;
  throw forbidden(allowCoach ? 'Solo puedes gestionar tu propio equipo' : 'Este equipo pertenece a un torneo de otro organizador');
}

async function assertMatchAccess(req, partidoId, db = pool) {
  if (isLeagueManager(req.user)) return;
  const { rows } = await db.query('SELECT torneo_id FROM deportivo.partidos WHERE id = $1', [partidoId]);
  if (rows.length === 0) throw notFound('Partido no encontrado');
  await assertTournamentAccess(req, rows[0].torneo_id, db);
}

// Filtro SQL de torneos visibles para gestión: NULL = todos.
const ownerFilter = (user) => (isLeagueManager(user) ? null : user.id);

module.exports = { isLeagueManager, assertTournamentAccess, assertTeamAccess, assertMatchAccess, ownerFilter, forbidden };
