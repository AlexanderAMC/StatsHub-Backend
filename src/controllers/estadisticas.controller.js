const pool = require('../config/database');
const { positiveInt } = require('../utils/http');
const { predict } = require('../services/prediction');

const torneoParam = (req) => (req.query.torneo_id ? positiveInt(req.query.torneo_id, 'El torneo') : null);

// RF-32: tabla de posiciones calculada desde los partidos con acta cerrada.
// 3 puntos por victoria y 1 por empate; desempate: puntos, diferencia de gol, goles a favor, nombre.
const posiciones = async (req, res) => {
  const torneoId = torneoParam(req);
  const { rows } = await pool.query(
    `WITH jugados AS (
       SELECT p.torneo_id, p.equipo_local AS equipo, r.goles_local AS gf, r.goles_visita AS gc
       FROM deportivo.partidos p JOIN deportivo.resultados r ON r.partido_id = p.id
       WHERE p.estado = 'FINALIZADO'
       UNION ALL
       SELECT p.torneo_id, p.equipo_visita, r.goles_visita, r.goles_local
       FROM deportivo.partidos p JOIN deportivo.resultados r ON r.partido_id = p.id
       WHERE p.estado = 'FINALIZADO'
     )
     SELECT te.torneo_id, e.id AS equipo_id, e.nombre AS equipo,
            COUNT(j.equipo)::int AS pj,
            COUNT(*) FILTER (WHERE j.gf > j.gc)::int AS pg,
            COUNT(*) FILTER (WHERE j.gf = j.gc)::int AS pe,
            COUNT(*) FILTER (WHERE j.gf < j.gc)::int AS pp,
            COALESCE(SUM(j.gf), 0)::int AS gf,
            COALESCE(SUM(j.gc), 0)::int AS gc,
            COALESCE(SUM(j.gf - j.gc), 0)::int AS dg,
            (COUNT(*) FILTER (WHERE j.gf > j.gc) * 3 + COUNT(*) FILTER (WHERE j.gf = j.gc))::int AS pts
     FROM deportivo.torneo_equipos te
     JOIN deportivo.equipos e ON e.id = te.equipo_id
     LEFT JOIN jugados j ON j.equipo = e.id AND j.torneo_id = te.torneo_id
     WHERE $1::int IS NULL OR te.torneo_id = $1
     GROUP BY te.torneo_id, e.id
     ORDER BY te.torneo_id, pts DESC, dg DESC, gf DESC, e.nombre`,
    [torneoId]
  );
  res.json(rows);
};

// RF-33 / RF-34: rankings de goleadores y asistencias.
function rankingQuery(column, tipoFilter) {
  return `
    SELECT j.id AS jugador_id, j.nombre, ej.equipo_id, COUNT(*)::int AS total
    FROM deportivo.eventos_partido ev
    JOIN deportivo.partidos p ON p.id = ev.partido_id
    JOIN deportivo.jugadores j ON j.id = ev.${column}
    LEFT JOIN deportivo.equipo_jugador ej ON ej.jugador_id = j.id AND ej.activo
    WHERE ev.tipo_evento = '${tipoFilter}' AND ($1::int IS NULL OR p.torneo_id = $1)
    GROUP BY j.id, ej.equipo_id
    ORDER BY total DESC, j.nombre
    LIMIT 50`;
}

const goleadores = async (req, res) => {
  const { rows } = await pool.query(rankingQuery('jugador_id', 'GOL'), [torneoParam(req)]);
  res.json(rows);
};

const asistencias = async (req, res) => {
  const { rows } = await pool.query(rankingQuery('asistencia_jugador_id', 'GOL'), [torneoParam(req)]);
  res.json(rows);
};

// RF-35: Fair Play por equipo (amarilla = 1 punto, roja = 3). Menos puntos = mejor posición.
const fairPlay = async (req, res) => {
  const torneoId = torneoParam(req);
  const { rows } = await pool.query(
    `SELECT e.id AS equipo_id, e.nombre AS equipo,
            COUNT(ev.id) FILTER (WHERE ev.tipo_evento = 'AMARILLA')::int AS amarillas,
            COUNT(ev.id) FILTER (WHERE ev.tipo_evento = 'ROJA')::int AS rojas,
            (COUNT(ev.id) FILTER (WHERE ev.tipo_evento = 'AMARILLA')
              + 3 * COUNT(ev.id) FILTER (WHERE ev.tipo_evento = 'ROJA'))::int AS puntos
     FROM deportivo.equipos e
     JOIN deportivo.torneo_equipos te ON te.equipo_id = e.id AND ($1::int IS NULL OR te.torneo_id = $1)
     LEFT JOIN deportivo.partidos p ON p.torneo_id = te.torneo_id AND e.id IN (p.equipo_local, p.equipo_visita)
     LEFT JOIN deportivo.eventos_partido ev ON ev.partido_id = p.id
          AND ev.lado = CASE WHEN p.equipo_local = e.id THEN 'LOCAL' ELSE 'VISITA' END
     GROUP BY e.id
     ORDER BY puntos, e.nombre`,
    [torneoId]
  );
  res.json(rows);
};

// RF-36: rendimiento de un equipo partido a partido (para el panel del entrenador).
const rendimientoEquipo = async (req, res) => {
  const equipoId = positiveInt(req.params.id, 'El equipo');
  const { rows } = await pool.query(
    `SELECT p.id AS partido_id, p.fecha_partido, p.torneo_id,
            CASE WHEN p.equipo_local = $1 THEN p.equipo_visita ELSE p.equipo_local END AS rival_id,
            CASE WHEN p.equipo_local = $1 THEN r.goles_local ELSE r.goles_visita END AS gf,
            CASE WHEN p.equipo_local = $1 THEN r.goles_visita ELSE r.goles_local END AS gc,
            p.equipo_local = $1 AS de_local
     FROM deportivo.partidos p JOIN deportivo.resultados r ON r.partido_id = p.id
     WHERE p.estado = 'FINALIZADO' AND $1 IN (p.equipo_local, p.equipo_visita)
     ORDER BY p.fecha_partido`,
    [equipoId]
  );
  res.json(rows);
};

// RF-37: predicciones para los partidos programados, con el historial de partidos finalizados.
const predicciones = async (req, res) => {
  const torneoId = torneoParam(req);
  const [history, fixtures] = await Promise.all([
    pool.query(
      `SELECT p.equipo_local AS local, p.equipo_visita AS visita, r.goles_local, r.goles_visita
       FROM deportivo.partidos p JOIN deportivo.resultados r ON r.partido_id = p.id
       WHERE p.estado = 'FINALIZADO' AND ($1::int IS NULL OR p.torneo_id = $1)`,
      [torneoId]
    ),
    pool.query(
      `SELECT id, equipo_local AS local, equipo_visita AS visita
       FROM deportivo.partidos
       WHERE estado = 'PROGRAMADO' AND ($1::int IS NULL OR torneo_id = $1)`,
      [torneoId]
    ),
  ]);
  if (history.rows.length === 0) return res.json([]);
  res.json(await predict(history.rows, fixtures.rows));
};

module.exports = { posiciones, goleadores, asistencias, fairPlay, rendimientoEquipo, predicciones };
