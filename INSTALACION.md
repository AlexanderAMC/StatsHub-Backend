# StatsHub Backend - Guía de Instalación

## Descripción

Este documento describe el proceso de instalación y configuración del entorno de desarrollo para StatsHub Backend.

---

# Requisitos Previos

## Node.js

Versión oficial:

```text
22.19.0
```

Verificar:

```bash
node -v
```

Resultado esperado:

```text
v22.19.0
```

---

## npm

Verificar:

```bash
npm -v
```

Resultado esperado:

```text
10.9.3
```

---

## Git

Verificar:

```bash
git --version
```

---

## PostgreSQL

Versión oficial:

```text
17.11
```

Verificar:

```bash
psql --version
```

Resultado esperado:

```text
psql (PostgreSQL) 17.11
```

---

## Visual Studio Code

Utilizar la versión más reciente disponible.

---

# Clonar el Repositorio

```bash
git clone https://github.com/TU_ORGANIZACION/StatsHub-Backend.git
```

Ingresar al proyecto:

```bash
cd StatsHub-Backend
```

---

# Instalación de Dependencias

Instalar todas las dependencias:

```bash
npm install
```

---

# Dependencias Oficiales

## Express

```bash
npm install express
```

## PostgreSQL Driver

```bash
npm install pg
```

## CORS

```bash
npm install cors
```

## Dotenv

```bash
npm install dotenv
```

## Nodemon (Desarrollo)

```bash
npm install --save-dev nodemon
```

---

# Variables de Entorno

Crear archivo:

```text
.env
```

Contenido:

```env
PORT=3000

DB_HOST=localhost
DB_PORT=5432
DB_NAME=statshub_deportivo
DB_USER=postgres
DB_PASSWORD=TU_PASSWORD
```

---

# Archivo .env.example

El repositorio incluye:

```text
.env.example
```

Contenido:

```env
PORT=3000

DB_HOST=localhost
DB_PORT=5432
DB_NAME=statshub_deportivo
DB_USER=postgres
DB_PASSWORD=CAMBIAR_PASSWORD
```

---

# Ejecutar el Proyecto

Modo desarrollo:

```bash
npm run dev
```

---

# Ejecutar en Producción

```bash
npm start
```

---

# Pruebas

```bash
npm test
```

---

# Base de Datos

Antes de ejecutar el backend se debe:

1. Instalar PostgreSQL.
2. Crear la base de datos:

```sql
CREATE DATABASE statshub_deportivo;
```

3. Ejecutar los scripts del repositorio Database.

---

# Estructura Recomendada

```text
src/
│
├── config/
├── controllers/
├── services/
├── repositories/
├── routes/
├── middleware/
├── models/
├── database/
└── app.js
```

---

# Arquitectura del Proyecto

El proyecto utiliza arquitectura de 3 capas:

```text
Presentación (Routes / Controllers)
        ↓
Lógica de Negocio (Services)
        ↓
Acceso a Datos (Repositories)
```

Reglas:

- Los Controllers no acceden directamente a la base de datos.
- Los Services contienen la lógica de negocio.
- Los Repositories ejecutan consultas SQL.

---

# Actualización del Proyecto

Obtener cambios:

```bash
git pull origin develop
```

Actualizar dependencias:

```bash
npm install
```

---

# Estructura de Ramas

No realizar commits directamente sobre:

```text
main
```

ni sobre:

```text
develop
```

Cada integrante trabajará exclusivamente en su rama:

```text
feature-AlexanderMendez
feature-DanielPincheira
feature-NombreIntegrante
```

---

# Reglas de Dependencias

No ejecutar:

```bash
npm update
```

No ejecutar:

```bash
npm install paquete@latest
```

Sin aprobación del líder.

---

# Archivos Importantes

Nunca eliminar:

```text
package.json
```

```text
package-lock.json
```

```text
.env.example
```

```text
.nvmrc
```

---

# Instalación Inicial

```bash
git clone URL_DEL_REPOSITORIO
```

```bash
cd StatsHub-Backend
```

```bash
npm install
```

```bash
npm run dev
```

---

# Solución de Problemas

Eliminar dependencias:

```bash
rm -rf node_modules
```

Eliminar lock:

```bash
rm package-lock.json
```

Instalar nuevamente:

```bash
npm install
```

---

# Versiones Oficiales

| Herramienta | Versión |
|-------------|----------|
| Node.js | 22.19.0 |
| npm | 10.9.3 |
| PostgreSQL | 17.11 |
| Express | Última versión definida en package-lock.json |
| pg | Última versión definida en package-lock.json |
| cors | Última versión definida en package-lock.json |
| dotenv | Última versión definida en package-lock.json |
| nodemon | Última versión definida en package-lock.json |