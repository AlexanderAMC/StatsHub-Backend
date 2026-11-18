require('dotenv').config();
const { getJwtSecret } = require('./config/jwt');

// Fallar al arrancar si falta configuración crítica, en lugar de firmar tokens con un secreto inseguro.
try {
  getJwtSecret();
} catch (error) {
  console.error(`❌ Configuración inválida: ${error.message}`);
  process.exit(1);
}

const app = require('./app');

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
