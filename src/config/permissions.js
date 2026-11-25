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
  STATS_ADVANCED: 'estadisticas:avanzadas',
  ANALYTICS: 'analitica:predictiva',
  OWN_TEAM: 'equipo:propio',
  COLLECT: 'cobros:gestionar',
  PAY_OFFICIALS: 'oficiales:liquidar',
});

const P = PERMISSIONS;

// Permisos que entrega el ROL (asignado por un administrador).
const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.ADMIN]: Object.values(PERMISSIONS),
  [ROLES.ORGANIZER]: [P.MANAGE_TOURNAMENTS, P.MANAGE_TEAMS, P.MANAGE_PLAYERS, P.SCHEDULE_MATCHES, P.RECORD_MATCHES,
    P.EXPORT, P.STATS_ADVANCED, P.ANALYTICS, P.COLLECT, P.PAY_OFFICIALS],
  [ROLES.COACH]: [P.MANAGE_PLAYERS, P.EXPORT, P.STATS_ADVANCED, P.ANALYTICS, P.OWN_TEAM],
  [ROLES.REFEREE]: [P.RECORD_MATCHES, P.STATS_ADVANCED],
  [ROLES.STATS]: [P.RECORD_MATCHES, P.STATS_ADVANCED],
  [ROLES.PLAYER]: [],
  [ROLES.SPECTATOR]: [],
});

// Permisos que desbloquea cada PLAN de pago (se suman a los del rol). Nunca incluyen MANAGE_USERS.
const BASIC = [P.STATS_ADVANCED, P.EXPORT];
const PRO = [...BASIC, P.ANALYTICS, P.OWN_TEAM, P.MANAGE_PLAYERS];
const ULTRA = [...PRO, P.MANAGE_TOURNAMENTS, P.MANAGE_TEAMS, P.SCHEDULE_MATCHES, P.RECORD_MATCHES, P.COLLECT, P.PAY_OFFICIALS];
const PLAN_PERMISSIONS = Object.freeze({ BASICO: BASIC, PRO, ULTRA });

const effectivePermissions = (role, plan = null) =>
  [...new Set([...(ROLE_PERMISSIONS[role] || []), ...(PLAN_PERMISSIONS[plan] || [])])];

const hasPermission = (role, permission, plan = null) => effectivePermissions(role, plan).includes(permission);

module.exports = { PERMISSIONS, ROLE_PERMISSIONS, PLAN_PERMISSIONS, effectivePermissions, hasPermission };
