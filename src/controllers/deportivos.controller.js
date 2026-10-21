const deportivosService = require('../services/deportivos.service');

const getTorneos = async (req, res) => {
  try {
    const torneos = await deportivosService.getTorneos();
    res.json(torneos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener torneos' });
  }
};

const getEquipos = async (req, res) => {
  try {
    const equipos = await deportivosService.getEquipos();
    res.json(equipos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener equipos' });
  }
};

const getPartidos = async (req, res) => {
  try {
    const partidos = await deportivosService.getPartidos();
    res.json(partidos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener partidos' });
  }
};

module.exports = {
  getTorneos,
  getEquipos,
  getPartidos
};