const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PASSWORD_MIN_LENGTH = 8;
// bcrypt ignora todo lo que pase de 72 bytes; además, limitarlo evita abusar de la CPU con hashes enormes.
const PASSWORD_MAX_BYTES = 72;

const isNonEmptyString = (value, max) =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;

const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

const isValidEmail = (value) => {
  const email = normalizeEmail(value);
  return email.length > 0 && email.length <= 255 && EMAIL_REGEX.test(email);
};

const isUuid = (value) => typeof value === 'string' && UUID_REGEX.test(value);

function validateLogin(body = {}) {
  const errors = [];
  if (typeof body.correo !== 'string' || body.correo.trim() === '') errors.push('El correo es obligatorio');
  if (typeof body.password !== 'string' || body.password === '') errors.push('La contraseña es obligatoria');
  if (typeof body.password === 'string' && Buffer.byteLength(body.password) > PASSWORD_MAX_BYTES) {
    errors.push('La contraseña es demasiado larga');
  }
  return errors;
}

function validateRegister(body = {}) {
  const errors = [];
  if (!isNonEmptyString(body.nombre, 100)) errors.push('El nombre es obligatorio (máximo 100 caracteres)');
  if (!isNonEmptyString(body.apellido, 100)) errors.push('El apellido es obligatorio (máximo 100 caracteres)');
  if (!isValidEmail(body.correo)) errors.push('El correo no es válido');

  if (typeof body.password !== 'string' || body.password.length < PASSWORD_MIN_LENGTH) {
    errors.push(`La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`);
  } else if (Buffer.byteLength(body.password) > PASSWORD_MAX_BYTES) {
    errors.push(`La contraseña no puede superar ${PASSWORD_MAX_BYTES} bytes`);
  }
  return errors;
}

module.exports = {
  isUuid,
  isValidEmail,
  normalizeEmail,
  validateLogin,
  validateRegister,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_BYTES,
};
