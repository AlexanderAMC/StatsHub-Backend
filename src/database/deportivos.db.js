const pool = require('../config/database');

// 1. Obtener Torneos
const obtenerTorneos = async () => {
  const query = `
    SELECT t.id, t.nombre, t.fecha_inicio, t.fecha_fin, t.estado, c.nombre AS categoria 
    FROM deportivo.torneos t
    JOIN deportivo.categorias c ON t.categoria_id = c.id
    ORDER BY t.fecha_inicio DESC
  `;
  const { rows } = await pool.query(query);
  return rows;
};

// 2. Obtener Equipos
const obtenerEquipos = async () => {
  const { rows } = await pool.query('SELECT * FROM deportivo.equipos ORDER BY nombre ASC');
  return rows;
};

// 3. Obtener Partidos
const obtenerPartidos = async () => {
  const query = `
    SELECT 
      p.id, p.fecha_partido, p.cancha, p.estado,
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
  obtenerPartidos
};