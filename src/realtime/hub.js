// Tiempo real con Server-Sent Events (RF-29, RF-42): el servidor avisa a los navegadores
// conectados cuando cambia un partido, y el frontend vuelve a pedir los datos afectados.
// Sin dependencias: funciona en una sola instancia. Con varias instancias detrás de un
// balanceador habría que repartir los eventos (p. ej. Redis pub/sub o LISTEN/NOTIFY).
const clients = new Set();
const HEARTBEAT_MS = 25000;

function subscribe(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx no debe acumular el stream en su buffer.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');

  clients.add(res);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  heartbeat.unref();

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

function broadcast(type, data = {}) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

const clientCount = () => clients.size;

module.exports = { subscribe, broadcast, clientCount };
