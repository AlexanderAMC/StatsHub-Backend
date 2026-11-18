const MIN_SECRET_LENGTH = 32;
const JWT_ALGORITHM = 'HS256';
const JWT_EXPIRES_IN = '8h';

// Devuelve el secreto JWT o lanza un error si no está configurado.
// No existe valor por defecto: un secreto conocido permitiría falsificar tokens.
function getJwtSecret() {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error(
      'Falta la variable de entorno JWT_SECRET. Genera una con: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
  }

  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET debe tener al menos ${MIN_SECRET_LENGTH} caracteres.`);
  }

  return secret;
}

module.exports = { getJwtSecret, JWT_ALGORITHM, JWT_EXPIRES_IN, MIN_SECRET_LENGTH };
