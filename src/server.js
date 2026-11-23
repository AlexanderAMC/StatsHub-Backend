require('dotenv').config();
const { getJwtSecret } = require('./config/jwt');

// Fallar al arrancar si falta configuración crítica, en lugar de firmar tokens con un secreto inseguro.
try {
  getJwtSecret();
} catch (error) {
  console.error(`❌ Configuración inválida: ${error.message}`);
  process.exit(1);
}

// En producción, avisar de lo que deja funciones sin operar (no detiene el arranque).
if (process.env.NODE_ENV === 'production') {
  const missing = [
    ['FRONTEND_URL', 'CORS bloqueará al frontend'],
    ['FRONTEND_PUBLIC_URL', 'los enlaces de recuperación de contraseña y el retorno de Flow usarán FRONTEND_URL'],
    ['API_PUBLIC_URL', 'Flow no podrá notificar los pagos'],
    ['SMTP_HOST', 'los correos de recuperación solo se escribirán en el log'],
    ['FLOW_API_KEY', 'los pagos con Flow estarán desactivados'],
    ['ML_SERVICE_URL', 'las predicciones usarán el modelo local de Node'],
  ].filter(([name]) => !process.env[name]);
  for (const [name, effect] of missing) console.warn(`⚠️  Falta ${name}: ${effect}.`);
}

const app = require('./app');
const pool = require('./config/database');

// Iniciar servidor
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});

// Apagado ordenado (PM2 / systemd envían SIGINT/SIGTERM): termina las peticiones en curso y cierra el pool.
const shutdown = (signal) => {
  console.log(`${signal} recibido: cerrando el servidor…`);
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => console.error('Promesa rechazada sin manejar:', reason));
