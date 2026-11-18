// Nombres de rol tal como están en seguridad.roles (StatsHub-Database/seeds/01_roles.sql).
const ROLES = Object.freeze({
  ADMIN: 'ADMINISTRADOR',
  ORGANIZER: 'ORGANIZADOR',
  COACH: 'ENTRENADOR',
  REFEREE: 'ARBITRO',
  STATS: 'ESTADIGRAFO',
  PLAYER: 'JUGADOR',
  SPECTATOR: 'ESPECTADOR',
});

// Rol asignado a toda cuenta creada con el registro público.
const DEFAULT_ROLE = ROLES.SPECTATOR;

const ASSIGNABLE_ROLES = Object.freeze(Object.values(ROLES));

const normalizeRole = (role) => (typeof role === 'string' ? role.trim().toUpperCase() : '');

module.exports = { ROLES, DEFAULT_ROLE, ASSIGNABLE_ROLES, normalizeRole };
