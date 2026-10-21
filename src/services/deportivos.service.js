const deportivosDb = require('../database/deportivos.db');

const getTorneos = async () => {
  return await deportivosDb.obtenerTorneos();
};

const getEquipos = async () => {
  return await deportivosDb.obtenerEquipos();
};

const getPartidos = async () => {
  return await deportivosDb.obtenerPartidos();
};

module.exports = {
  getTorneos,
  getEquipos,
  getPartidos
};