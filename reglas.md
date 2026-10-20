# StatsHub Backend

API REST oficial de StatsHub Deportivo.

---

# Tecnologías

- Node.js
- Express
- PostgreSQL
- JWT
- bcrypt
- dotenv

---

# Requisitos

- Node.js 22+
- npm 10+
- PostgreSQL 17+
- Git

---

# Instalación

Clonar repositorio:

```bash
git clone https://github.com/AlexanderAMC/StatsHub-Backend.git
```

Entrar al proyecto:

```bash
cd StatsHub-Backend
```

Instalar dependencias:

```bash
npm install
```

---

# Configuración

Crear archivo:

```env
.env
```

Ejemplo:

```env
PORT=5000

DB_HOST=localhost
DB_PORT=5432

DB_NAME=statshub

DB_USER=postgres
DB_PASSWORD=password

JWT_SECRET=MiClaveJWT
```

⚠ Nunca subir el archivo `.env`.

---

# Ejecución

Modo desarrollo:

```bash
npm run dev
```

Modo normal:

```bash
node src/server.js
```

---

# Pruebas

Ejecutar pruebas:

```bash
npm test
```

Modo observación:

```bash
npm run test:watch
```

Cobertura:

```bash
npm run test:coverage
```

---

# Estructura de ramas

```txt
main
develop

feature/AlexanderMendez
feature/DanielBalcarce
feature/JuanVillagran
feature/DanielPincheira
```

---

# Flujo de Trabajo

Actualizar develop:

```bash
git checkout develop

git pull origin develop
```

Cambiar a rama personal:

```bash
git checkout feature/TuNombre
```

Actualizar rama:

```bash
git merge develop
```

Subir cambios:

```bash
git add .

git commit -m "feat: descripción"

git push
```

---

# Pull Request

Todos los Pull Request deben apuntar a:

```txt
develop
```

Nunca directamente a:

```txt
main
```

El Pull Request debe contener:

- Objetivo
- Endpoints afectados
- Pruebas realizadas
- Evidencias

Checklist:

- [ ] API funciona correctamente
- [ ] Probado localmente
- [ ] No contiene credenciales
- [ ] Documentación actualizada

---

# Estándares Backend

- Controllers separados
- Routes separadas
- Middleware separado
- Validaciones obligatorias
- Manejo de errores obligatorio
- Uso de variables de entorno obligatorio

---

# Convención de Commits

```txt
feat:
fix:
docs:
refactor:
test:
```

Ejemplo:

```txt
feat: endpoint crear torneo
```

---

# Prohibido

❌ Push directo a main

❌ Push directo a develop

❌ Subir .env

❌ Subir credenciales

❌ Subir JWT Secrets

❌ Subir claves AWS

❌ Eliminar endpoints sin consenso

---

# Objetivo

Desarrollar una API REST segura, escalable y mantenible para StatsHub Deportivo.