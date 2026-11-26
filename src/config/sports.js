// Reglas de cada deporte. El torneo define el deporte; el acta, la tabla y las estadísticas lo siguen.
const FUTBOL = 'FUTBOL';
const BASQUETBOL = 'BASQUETBOL';
const SPORTS = [BASQUETBOL, FUTBOL];

// Básquetbol (reglamento FIBA adaptado al amateur).
const BASKETBALL = {
  points: { PUNTO_1: 1, PUNTO_2: 2, PUNTO_3: 3 },
  // Eventos que requieren al jugador en cancha (el tiempo muerto es del equipo).
  onCourt: ['PUNTO_1', 'PUNTO_2', 'PUNTO_3', 'REBOTE', 'FALTA', 'FALTA_TECNICA', 'FALTA_ANTIDEPORTIVA'],
  fouls: ['FALTA', 'FALTA_TECNICA', 'FALTA_ANTIDEPORTIVA'],
  foulOut: 5, // con 5 faltas el jugador queda eliminado del partido
  techOut: 2, // 2 técnicas o 2 antideportivas también lo descalifican
  periods: 4,
  periodMinutes: 10,
  overtimeMinutes: 5,
  // Tiempos muertos por equipo: 2 en la primera mitad, 3 en la segunda y 1 por prórroga.
  timeoutsAllowed: (periodo) => (periodo <= 2 ? 2 : periodo <= 4 ? 3 : 1),
  timeoutWindow: (periodo) => (periodo <= 2 ? [1, 2] : periodo <= 4 ? [3, 4] : [periodo, periodo]),
};

const EVENT_TYPES = {
  [FUTBOL]: ['GOL', 'AMARILLA', 'ROJA', 'SUSTITUCION', 'LESION'],
  [BASQUETBOL]: [
    'PUNTO_1', 'PUNTO_2', 'PUNTO_3', 'REBOTE', 'FALTA', 'FALTA_TECNICA', 'FALTA_ANTIDEPORTIVA',
    'TIEMPO_MUERTO', 'SUSTITUCION', 'LESION',
  ],
};

// Puntos que suma cada evento al marcador del partido.
const scoreValue = (deporte, tipo) => (deporte === BASQUETBOL ? BASKETBALL.points[tipo] ?? 0 : tipo === 'GOL' ? 1 : 0);

module.exports = { FUTBOL, BASQUETBOL, SPORTS, BASKETBALL, EVENT_TYPES, scoreValue };
