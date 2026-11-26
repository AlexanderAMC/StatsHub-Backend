const pool = require('../config/database');
const { positiveInt, oneOf } = require('../utils/http');
const { predict, basketballPrediction } = require('../services/prediction');
const { SPORTS, BASQUETBOL, FUTBOL } = require('../config/sports');

const torneoParam = (req) => (req.query.torneo_id ? positiveInt(req.query.torneo_id, 'El torneo') : null);

// Deporte de la consulta: el del torneo pedido; sin torneo, ?deporte= (por defecto fútbol, compatibilidad).
async function sportOf(req, torneoId) {
  if (torneoId) {
    const { rows } = await pool.query('SELECT deporte FROM deportivo.torneos WHERE id = $1', [torneoId]);
    if (rows[0]) return rows[0].deporte;
  }
  return oneOf(String(req.query.deporte ?? FUTBOL).toUpperCase(), SPORTS, 'El deporte');
}

// RF-32: tabla de posiciones calculada desde los partidos con acta cerrada.
// Fútbol: 3 puntos por victoria y 1 por empate. Básquetbol (FIBA): 2 por victoria y 1 por derrota.
// Desempate: puntos, diferencia, tantos a favor, nombre.
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
     ), tabla AS (
       SELECT te.torneo_id, t.deporte, e.id AS equipo_id, e.nombre AS equipo,
              COUNT(j.equipo)::int AS pj,
              COUNT(*) FILTER (WHERE j.gf > j.gc)::int AS pg,
              COUNT(*) FILTER (WHERE j.gf = j.gc)::int AS pe,
              COUNT(*) FILTER (WHERE j.gf < j.gc)::int AS pp,
              COALESCE(SUM(j.gf), 0)::int AS gf,
              COALESCE(SUM(j.gc), 0)::int AS gc,
              COALESCE(SUM(j.gf - j.gc), 0)::int AS dg
       FROM deportivo.torneo_equipos te
       JOIN deportivo.torneos t ON t.id = te.torneo_id
       JOIN deportivo.equipos e ON e.id = te.equipo_id
       LEFT JOIN jugados j ON j.equipo = e.id AND j.torneo_id = te.torneo_id
       WHERE $1::int IS NULL OR te.torneo_id = $1
       GROUP BY te.torneo_id, t.deporte, e.id
     )
     SELECT *, (CASE WHEN deporte = 'BASQUETBOL' THEN pg * 2 + pp ELSE pg * 3 + pe END)::int AS pts
     FROM tabla
     ORDER BY torneo_id, pts DESC, dg DESC, gf DESC, equipo`,
    [torneoId]
  );
  res.json(rows);
};

// Ranking de jugadores: suma "valor" por cada evento de los tipos indicados.
function rankingQuery(column, tipos, valueSql = '1') {
  return `
    SELECT j.id AS jugador_id, j.nombre, ej.equipo_id,
           SUM(${valueSql})::int AS total,
           COUNT(DISTINCT ev.partido_id)::int AS partidos,
           COUNT(*) FILTER (WHERE ev.tipo_evento = 'PUNTO_3')::int AS triples
    FROM deportivo.eventos_partido ev
    JOIN deportivo.partidos p ON p.id = ev.partido_id
    JOIN deportivo.torneos t ON t.id = p.torneo_id
    JOIN deportivo.jugadores j ON j.id = ev.${column}
    LEFT JOIN deportivo.equipo_jugador ej ON ej.jugador_id = j.id AND ej.activo
    WHERE ev.tipo_evento IN (${tipos.map((t) => `'${t}'`).join(', ')})
      AND t.deporte = $2 AND ($1::int IS NULL OR p.torneo_id = $1)
    GROUP BY j.id, ej.equipo_id
    ORDER BY total DESC, j.nombre
    LIMIT 50`;
}

const POINTS_SQL = `CASE ev.tipo_evento WHEN 'PUNTO_3' THEN 3 WHEN 'PUNTO_2' THEN 2 ELSE 1 END`;

// RF-33: goleadores (fútbol) o máximos anotadores con promedio por partido (básquetbol).
const goleadores = async (req, res) => {
  const torneoId = torneoParam(req);
  const deporte = await sportOf(req, torneoId);
  const sql = deporte === BASQUETBOL
    ? rankingQuery('jugador_id', ['PUNTO_1', 'PUNTO_2', 'PUNTO_3'], POINTS_SQL)
    : rankingQuery('jugador_id', ['GOL']);
  const { rows } = await pool.query(sql, [torneoId, deporte]);
  res.json(rows.map((r) => ({ ...r, deporte, promedio: r.partidos ? Math.round((r.total / r.partidos) * 10) / 10 : 0 })));
};

// RF-34: asistencias (en básquetbol, las que terminan en doble o triple).
const asistencias = async (req, res) => {
  const torneoId = torneoParam(req);
  const deporte = await sportOf(req, torneoId);
  const tipos = deporte === BASQUETBOL ? ['PUNTO_2', 'PUNTO_3'] : ['GOL'];
  const { rows } = await pool.query(rankingQuery('asistencia_jugador_id', tipos), [torneoId, deporte]);
  res.json(rows);
};

// Básquetbol: rebotes por jugador.
const rebotes = async (req, res) => {
  const torneoId = torneoParam(req);
  const { rows } = await pool.query(rankingQuery('jugador_id', ['REBOTE']), [torneoId, BASQUETBOL]);
  res.json(rows);
};

// RF-35: Fair Play por equipo. Menos puntos = mejor posición.
// Fútbol: amarilla = 1, roja = 3. Básquetbol: falta = 1, técnica o antideportiva = 2.
const fairPlay = async (req, res) => {
  const torneoId = torneoParam(req);
  const deporte = await sportOf(req, torneoId);
  const { rows } = await pool.query(
    `SELECT e.id AS equipo_id, e.nombre AS equipo,
            COUNT(ev.id) FILTER (WHERE ev.tipo_evento = 'AMARILLA')::int AS amarillas,
            COUNT(ev.id) FILTER (WHERE ev.tipo_evento = 'ROJA')::int AS rojas,
            COUNT(ev.id) FILTER (WHERE ev.tipo_evento = 'FALTA')::int AS faltas,
            COUNT(ev.id) FILTER (WHERE ev.tipo_evento = 'FALTA_TECNICA')::int AS tecnicas,
            COUNT(ev.id) FILTER (WHERE ev.tipo_evento = 'FALTA_ANTIDEPORTIVA')::int AS antideportivas,
            (COUNT(ev.id) FILTER (WHERE ev.tipo_evento IN ('AMARILLA', 'FALTA'))
              + 3 * COUNT(ev.id) FILTER (WHERE ev.tipo_evento = 'ROJA')
              + 2 * COUNT(ev.id) FILTER (WHERE ev.tipo_evento IN ('FALTA_TECNICA', 'FALTA_ANTIDEPORTIVA')))::int AS puntos
     FROM deportivo.equipos e
     JOIN deportivo.torneo_equipos te ON te.equipo_id = e.id AND ($1::int IS NULL OR te.torneo_id = $1)
     JOIN deportivo.torneos t ON t.id = te.torneo_id AND t.deporte = $2
     LEFT JOIN deportivo.partidos p ON p.torneo_id = te.torneo_id AND e.id IN (p.equipo_local, p.equipo_visita)
     LEFT JOIN deportivo.eventos_partido ev ON ev.partido_id = p.id
          AND ev.lado = CASE WHEN p.equipo_local = e.id THEN 'LOCAL' ELSE 'VISITA' END
     GROUP BY e.id
     ORDER BY puntos, e.nombre`,
    [torneoId, deporte]
  );
  res.json(rows.map((r) => ({ ...r, deporte })));
};

// RF-36: rendimiento de un equipo partido a partido (para el panel del entrenador).
const rendimientoEquipo = async (req, res) => {
  const equipoId = positiveInt(req.params.id, 'El equipo');
  const { rows } = await pool.query(
    `SELECT p.id AS partido_id, p.fecha_partido, p.torneo_id, t.deporte,
            CASE WHEN p.equipo_local = $1 THEN p.equipo_visita ELSE p.equipo_local END AS rival_id,
            CASE WHEN p.equipo_local = $1 THEN r.goles_local ELSE r.goles_visita END AS gf,
            CASE WHEN p.equipo_local = $1 THEN r.goles_visita ELSE r.goles_local END AS gc,
            p.equipo_local = $1 AS de_local
     FROM deportivo.partidos p
     JOIN deportivo.resultados r ON r.partido_id = p.id
     JOIN deportivo.torneos t ON t.id = p.torneo_id
     WHERE p.estado = 'FINALIZADO' AND $1 IN (p.equipo_local, p.equipo_visita)
     ORDER BY p.fecha_partido`,
    [equipoId]
  );
  res.json(rows);
};

// RF-37: predicciones para los partidos programados, con el historial de partidos finalizados del
// mismo deporte. Fútbol: Poisson (con empate). Básquetbol: modelo normal de puntos (sin empate).
const predicciones = async (req, res) => {
  const torneoId = torneoParam(req);
  const sports = torneoId ? [await sportOf(req, torneoId)] : SPORTS;
  const out = [];
  for (const deporte of sports) {
    const [history, fixtures] = await Promise.all([
      pool.query(
        `SELECT p.equipo_local AS local, p.equipo_visita AS visita, r.goles_local, r.goles_visita
         FROM deportivo.partidos p
         JOIN deportivo.resultados r ON r.partido_id = p.id
         JOIN deportivo.torneos t ON t.id = p.torneo_id
         WHERE p.estado = 'FINALIZADO' AND t.deporte = $2 AND ($1::int IS NULL OR p.torneo_id = $1)`,
        [torneoId, deporte]
      ),
      pool.query(
        `SELECT p.id, p.equipo_local AS local, p.equipo_visita AS visita
         FROM deportivo.partidos p JOIN deportivo.torneos t ON t.id = p.torneo_id
         WHERE p.estado = 'PROGRAMADO' AND t.deporte = $2 AND ($1::int IS NULL OR p.torneo_id = $1)`,
        [torneoId, deporte]
      ),
    ]);
    if (history.rows.length === 0 || fixtures.rows.length === 0) continue;
    out.push(...(deporte === BASQUETBOL
      ? basketballPrediction(history.rows, fixtures.rows)
      : await predict(history.rows, fixtures.rows)));
  }
  res.json(out);
};

module.exports = { posiciones, goleadores, asistencias, rebotes, fairPlay, rendimientoEquipo, predicciones };
