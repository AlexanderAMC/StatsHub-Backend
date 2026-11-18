const { ROLES } = require('./roles');

// Permisos RBAC. Deben coincidir con StatsHub-Frontend/src/data/users.js (PERMISSIONS / ROLE_PERMISSIONS):
// el frontend los usa para mostrar u ocultar acciones; el backend es quien los hace cumplir.
const PERMISSIONS = Object.freeze({
  MANAGE_USERS: 'usuarios:gestionar',
  MANAGE_TOURNAMENTS: 'torneos:gestionar',
  MANAGE_TEAMS: 'equipos:gestionar',
  MANAGE_PLAYERS: 'jugadores:gestionar',
  SCHEDULE_MATCHES: 'partidos:programar',
  RECORD_MATCHES: 'actas:registrar',
  EXPORT: 'reportes:exportar',
});

const P = PERMISSIONS;

const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.ADMIN]: Object.values(PERMISSIONS),
  [ROLES.ORGANIZER]: [P.MANAGE_TOURNAMENTS, P.MANAGE_TEAMS, P.MANAGE_PLAYERS, P.SCHEDULE_MATCHES, P.RECORD_MATCHES, P.EXPORT],
  [ROLES.COACH]: [P.MANAGE_PLAYERS, P.EXPORT],
  [ROLES.REFEREE]: [P.RECORD_MATCHES, P.EXPORT],
  [ROLES.STATS]: [P.RECORD_MATCHES, P.EXPORT],
  [ROLES.PLAYER]: [P.EXPORT],
  [ROLES.SPECTATOR]: [P.EXPORT],
});

const hasPermission = (role, permission) => (ROLE_PERMISSIONS[role] || []).includes(permission);

module.exports = { PERMISSIONS, ROLE_PERMISSIONS, hasPermission };
