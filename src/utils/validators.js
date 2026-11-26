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

// Contraseñas demasiado comunes (se rechazan aunque cumplan el largo).
const COMMON_PASSWORDS = new Set([
  'password1', 'password123', 'contraseña1', 'contrasena1', 'qwerty123', '12345678a', 'admin1234', 'administrador1',
  'statshub1', 'statshub123', 'futbol123', 'basquet123', 'abc12345', 'iloveyou1', 'chile2026', 'colocolo1',
]);

// Reglas comunes a registro, cambio y recuperación: largo, letras y números, no común, no basada en el correo.
function passwordProblem(password, correo = '') {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`;
  }
  if (Buffer.byteLength(password) > PASSWORD_MAX_BYTES) return `La contraseña no puede superar ${PASSWORD_MAX_BYTES} bytes`;
  if (!/\p{L}/u.test(password) || !/\d/.test(password)) return 'La contraseña debe combinar letras y números';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'Esa contraseña es demasiado común: elige otra';
  const local = normalizeEmail(correo).split('@')[0];
  if (local.length >= 4 && password.toLowerCase().includes(local)) return 'La contraseña no puede contener tu correo';
  return null;
}

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

  const problem = passwordProblem(body.password, body.correo);
  if (problem) errors.push(problem);
  return errors;
}

module.exports = {
  isUuid,
  isValidEmail,
  normalizeEmail,
  validateLogin,
  validateRegister,
  passwordProblem,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_BYTES,
};
