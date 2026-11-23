// PM2: procesos de StatsHub en el servidor (EC2).
//   pm2 start deploy/ecosystem.config.js --env production
//   pm2 save && pm2 startup        (reinicio automático al arrancar el servidor)
//
// La API corre en UNA instancia (modo fork): el tiempo real (SSE) y el rate limiting viven en
// memoria. Para escalar horizontalmente habría que moverlos a Redis antes de usar modo cluster.
module.exports = {
  apps: [
    {
      name: 'statshub-api',
      script: 'src/server.js',
      cwd: __dirname + '/..',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '400M',
      kill_timeout: 10000,
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
    {
      name: 'statshub-ml',
      script: 'app.py',
      cwd: __dirname + '/../ml-service',
      interpreter: process.env.ML_PYTHON || 'python3',
      instances: 1,
      max_memory_restart: '400M',
      env_production: {
        ML_HOST: '127.0.0.1',
        ML_PORT: 8000,
      },
    },
  ],
};
