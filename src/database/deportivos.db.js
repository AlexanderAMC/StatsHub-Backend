const pool = require('../config/database');

// 1. Obtener Torneos (con cantidad de equipos inscritos)
const obtenerTorneos = async () => {
  const query = `
    SELECT t.id, t.nombre, t.fecha_inicio, t.fecha_fin, t.estado,
           t.categoria_id, c.nombre AS categoria,
           COUNT(te.equipo_id)::int AS cantidad_equipos
    FROM deportivo.torneos t
    JOIN deportivo.categorias c ON t.categoria_id = c.id
    LEFT JOIN deportivo.torneo_equipos te ON te.torneo_id = t.id
    GROUP BY t.id, c.nombre
    ORDER BY t.fecha_inicio DESC
  `;
  const { rows } = await pool.query(query);
  return rows;
};

// 2. Obtener Equipos (con los torneos en que están inscritos)
// torneo_id es el torneo más reciente del equipo; torneo_ids, todos sus torneos.
const obtenerEquipos = async () => {
  const query = `
    SELECT e.id, e.nombre, e.escudo_url, e.fecha_creacion,
           (ARRAY_AGG(t.id ORDER BY t.fecha_inicio DESC) FILTER (WHERE t.id IS NOT NULL))[1] AS torneo_id,
           COALESCE(ARRAY_AGG(t.id ORDER BY t.fecha_inicio DESC) FILTER (WHERE t.id IS NOT NULL), '{}') AS torneo_ids
    FROM deportivo.equipos e
    LEFT JOIN deportivo.torneo_equipos te ON te.equipo_id = e.id
    LEFT JOIN deportivo.torneos t ON t.id = te.torneo_id
    GROUP BY e.id
    ORDER BY e.nombre ASC
  `;
  const { rows } = await pool.query(query);
  return rows;
};

// 3. Obtener Partidos (incluye los ids de torneo y equipos que el frontend usa para relacionarlos)
const obtenerPartidos = async () => {
  const query = `
    SELECT
      p.id, p.torneo_id, p.equipo_local, p.equipo_visita,
      p.fecha_partido, p.cancha, p.estado,
      el.nombre AS equipo_local_nombre, ev.nombre AS equipo_visita_nombre,
      r.goles_local, r.goles_visita
    FROM deportivo.partidos p
    JOIN deportivo.equipos el ON p.equipo_local = el.id
    JOIN deportivo.equipos ev ON p.equipo_visita = ev.id
    LEFT JOIN deportivo.resultados r ON p.id = r.partido_id
    ORDER BY p.fecha_partido DESC
  `;
  const { rows } = await pool.query(query);
  return rows;
};

module.exports = {
  obtenerTorneos,
  obtenerEquipos,
  obtenerPartidos,
};
