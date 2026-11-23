const nodemailer = require('nodemailer');

// Envío de correos. Con SMTP_HOST configurado usa ese servidor; si no, escribe el correo en
// la consola (modo desarrollo), lo que permite probar la recuperación de contraseña sin
// proveedor. En producción SMTP es obligatorio (ver config de arranque en server.js).
let transporter = null;

function getTransporter() {
  if (!process.env.SMTP_HOST) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  const transport = getTransporter();
  if (!transport) {
    if (process.env.NODE_ENV !== 'test') {
      console.log(`\n📧 [correo de desarrollo] Para: ${to}\nAsunto: ${subject}\n${text}\n`);
    }
    return { delivered: false };
  }
  await transport.sendMail({
    from: process.env.MAIL_FROM || 'StatsHub Deportivo <no-responder@statshub.cl>',
    to,
    subject,
    text,
    html,
  });
  return { delivered: true };
}

module.exports = { sendMail };
