const pool = require('../config/database'); // Asegúrate que la ruta sea correcta a tu archivo de conexión
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// 1. INICIAR SESIÓN
const login = async (req, res) => {
  const { correo, password } = req.body;

  try {
    // Buscamos al usuario uniendo con la tabla de roles
    const query = `
      SELECT u.id, u.nombre, u.apellido, u.correo, u.password_hash, u.activo, r.nombre AS rol
      FROM seguridad.usuarios u
      JOIN seguridad.roles r ON u.rol_id = r.id
      WHERE u.correo = $1
    `;
    const result = await pool.query(query, [correo]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const usuario = result.rows[0];

    if (!usuario.activo) {
      return res.status(403).json({ error: 'Usuario desactivado' });
    }

    // Verificamos la contraseña encriptada
    const passwordValido = await bcrypt.compare(password, usuario.password_hash);
    if (!passwordValido) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // Generamos el Token JWT
    const token = jwt.sign(
      { id: usuario.id, rol: usuario.rol },
      process.env.JWT_SECRET || 'secreto_super_seguro_statshub',
      { expiresIn: '8h' }
    );

    res.json({
      mensaje: 'Login exitoso',
      token,
      usuario: {
        id: usuario.id,
        nombre: usuario.nombre,
        apellido: usuario.apellido,
        correo: usuario.correo,
        rol: usuario.rol
      }
    });
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// 2. REGISTRAR NUEVO USUARIO
const register = async (req, res) => {
  const { nombre, apellido, correo, password } = req.body;

  try {
    // Verificar si el correo ya existe
    const userExists = await pool.query('SELECT * FROM seguridad.usuarios WHERE correo = $1', [correo]);
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'El correo ya está registrado' });
    }

    // Encriptar la contraseña
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Obtener el ID del rol "espectador" o el rol por defecto
    const roleQuery = await pool.query("SELECT id FROM seguridad.roles WHERE nombre ILIKE 'espectador' LIMIT 1");
    const rolId = roleQuery.rows.length > 0 ? roleQuery.rows[0].id : 1;

    // Insertar el nuevo usuario
    const newUser = await pool.query(
      `INSERT INTO seguridad.usuarios (nombre, apellido, correo, password_hash, rol_id, activo) 
       VALUES ($1, $2, $3, $4, $5, true) RETURNING id, nombre, apellido, correo`,
      [nombre, apellido, correo, passwordHash, rolId]
    );

    res.status(201).json({ 
      mensaje: 'Usuario registrado exitosamente', 
      usuario: newUser.rows[0] 
    });
  } catch (error) {
    console.error('Error en registro:', error);
    res.status(500).json({ error: 'Error al registrar el usuario' });
  }
};

module.exports = { login, register };