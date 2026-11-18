# Documentación Técnica: Módulo de Autenticación (Login y Registro)
**Proyecto:** StatsHub Deportivo
**Módulos documentados:** Frontend (React) / Backend (Node.js + Express) / Base de Datos (PostgreSQL)

Este documento detalla la ubicación exacta, la función y el flujo de todos los archivos involucrados en el sistema de inicio de sesión y creación de cuentas.

---

## 1. BACKEND (Node.js + Express)

### 1.1. Variables de Entorno
*   **Archivo:** `.env` (Ubicado en la raíz de `StatsHub-Backend`)
*   **Función:** Almacena las credenciales de la base de datos y el secreto para firmar los tokens de seguridad.
*   **Variables clave:**
    *   `DB_NAME=statshub_deportivo`
    *   `JWT_SECRET=<genera_uno_aleatorio_de_al_menos_32_caracteres>`

### 1.2. Conexión a la Base de Datos
*   **Archivo:** `src/config/database.js`
*   **Función:** Crea un "Pool" de conexiones usando la librería `pg`. Exporta la conexión para que los controladores puedan hacer consultas SQL a PostgreSQL.

### 1.3. Lógica de Negocio (Controladores)
*   **Archivo:** `src/controllers/auth.controller.js`
*   **Función:** Contiene la lógica pura de la autenticación. Exporta dos funciones principales:
    *   `login(req, res)`: Recibe `correo` y `password`. Busca al usuario en la tabla `seguridad.usuarios`, usa `bcrypt.compare()` para verificar la contraseña, y si es correcta, genera un Token JWT con `jsonwebtoken`.
    *   `register(req, res)`: Recibe `nombre`, `apellido`, `correo` y `password`. Verifica que el correo no exista, encripta la contraseña con `bcrypt.hash()`, busca el ID del rol "espectador" en `seguridad.roles` e inserta el nuevo usuario en la base de datos.

### 1.4. Enrutamiento (Rutas)
*   **Archivo:** `src/routes/auth.routes.js`
*   **Función:** Define las URLs que el frontend puede consumir. Conecta las rutas con los controladores.
    *   `POST /api/auth/login` -> Llama a `auth.controller.login`
    *   `POST /api/auth/register` -> Llama a `auth.controller.register`

### 1.5. Punto de Entrada del Servidor
*   **Archivo:** `src/server.js` (o `index.js` según tu configuración)
*   **Función:** Inicializa Express, configura CORS (para permitir peticiones desde Vite/React) y monta las rutas de autenticación usando `app.use('/api/auth', authRoutes)`.

---

## 2. FRONTEND (React)

### 2.1. Variables de Entorno
*   **Archivo:** `.env` (Ubicado en la raíz de `StatsHub-Frontend`)
*   **Función:** Indica la URL base del backend.
*   **Variable clave:** `VITE_API_URL=http://localhost:3000/api`

### 2.2. Capa de Servicios (Peticiones HTTP)
*   **Archivo:** `src/services/api.js`
    *   **Función:** Es el "mensajero" central. Se encarga de hacer el `fetch` al backend. Lee el Token JWT guardado en el `localStorage` y lo inyecta automáticamente en los headers (`Authorization: Bearer <token>`) de cada petición.
*   **Archivo:** `src/services/auth.service.js`
    *   **Función:** Contiene los métodos específicos `login(correo, password)` y `register(nombre, apellido, correo, password)` que utilizan el archivo `api.js` para enviar los datos al backend.

### 2.3. Gestión de Estado Global (Contexto)
*   **Archivo:** `src/context/authContext.js`
    *   **Función:** Crea el contexto de React (`createContext`) para que los datos del usuario estén disponibles en toda la aplicación.
*   **Archivo:** `src/context/AuthProvider.jsx`
    *   **Función:** Es el componente "cerebro" de la sesión. Envuelve a toda la aplicación.
    *   `login()`: Llama al servicio, recibe el Token y los datos del usuario, y los guarda en el `localStorage`.
    *   `register()`: Llama al servicio para crear la cuenta y, si es exitoso, ejecuta el `login` automáticamente.
    *   `logout()`: Borra el Token y los datos del `localStorage`.
    *   `can(permission)`: Verifica si el rol del usuario tiene permiso para realizar acciones específicas (ej. gestionar torneos).

### 2.4. Hook Personalizado
*   **Archivo:** `src/hooks/useAuth.js`
*   **Función:** Permite a cualquier componente acceder a los datos del usuario (`user`), a la función de `login`, `logout`, `register` y `can()` sin tener que importar el contexto directamente.

### 2.5. Vistas y Componentes de Interfaz (UI)
*   **Archivo:** `src/pages/Login.jsx`
    *   **Función:** Formulario visual de inicio de sesión. Maneja los estados de "cargando" mientras espera la respuesta del backend y muestra los errores si las credenciales fallan. Permite alternar entre Login, Registro y Recuperación de contraseña.
*   **Archivo:** `src/components/RouteGuards.jsx`
    *   **Función:** Componentes `<RequireSession>` y `<RequirePermission>`. Protegen las rutas privadas: si el usuario no tiene sesión, lo redirigen a `/login`.
*   **Archivo:** `src/components/Sidebar.jsx` y `src/components/Header.jsx`
    *   **Función:** Muestran las iniciales y el nombre del usuario logueado. Incluyen el botón para cerrar sesión (`logout`).
*   **Archivo:** `src/components/ProfileModal.jsx`
    *   **Función:** Muestra un modal con la información del perfil del usuario y las acciones que puede realizar según su rol.
*   **Archivo:** `src/components/AccessRestricted.jsx`
    *   **Función:** Pantalla que se muestra si un usuario intenta acceder a una vista para la cual no tiene permisos.

---

## 3. FLUJO COMPLETO DE EJECUCIÓN

### 3.1. Flujo de Inicio de Sesión (Login)
1. El usuario llena el formulario en **`src/pages/Login.jsx`**.
2. Se ejecuta la función de `login()` del **`src/context/AuthProvider.jsx`**.
3. El Provider llama a **`src/services/auth.service.js`**, que a su vez usa **`src/services/api.js`** para hacer un `POST` a `http://localhost:3000/api/auth/login`.
4. El Backend recibe la petición en **`src/routes/auth.routes.js`** y la deriva a **`src/controllers/auth.controller.js`**.
5. El controlador hace un `SELECT` en la tabla `seguridad.usuarios`. Si la contraseña coincide (usando `bcrypt.compare`), firma un Token JWT y responde con un JSON.
6. El Frontend recibe el JSON, guarda el Token en `localStorage` y redirige al usuario al Dashboard.

### 3.2. Flujo de Registro de Usuario (Register)
1. El usuario llena el formulario de "Crear cuenta" en **`src/pages/Login.jsx`**.
2. El **`AuthProvider`** llama al método `register` del **`auth.service.js`**.
3. El Backend recibe la petición en **`auth.controller.js`**.
4. El controlador verifica que el correo no exista, encripta la contraseña con `bcrypt.hash`, y hace un `INSERT` en `seguridad.usuarios` asignándole el rol de "espectador".
5. Si el registro es exitoso, el controlador responde con un `201 Created`.
6. El **`AuthProvider`** en el frontend recibe la confirmación y ejecuta la función `login()` automáticamente para que el usuario no tenga que volver a escribir sus datos.

---

## 4. SEGURIDAD IMPLEMENTADA
*   **Cifrado de contraseñas:** Implementado en `auth.controller.js` usando `bcrypt`. La base de datos nunca guarda la contraseña real.
*   **Tokens JWT:** Implementado con `jsonwebtoken`. Permite mantener la sesión activa sin consultar la base de datos en cada clic.
*   **Protección de rutas frontend:** Implementado en `RouteGuards.jsx`. Bloquea el acceso a vistas como `/actas` o `/usuarios` si el rol no cuenta con los permisos requeridos.
*   



==============================================================================================================================================================================================
==============================================================================================================================================================================================
==============================================================================================================================================================================================
==============================================================================================================================================================================================

AQUI HAY MAS PASOS YA QUE LA IA SE AWEONO Y NO QUISO DARME LAS WEAS COMO SE LAS PEDI


# Documentación Técnica: Módulo de Autenticación (Login y Registro)
**Proyecto:** StatsHub Deportivo
**Módulos documentados:** Frontend (React) / Backend (Node.js + Express) / Base de Datos (PostgreSQL)

Este documento detalla la ubicación exacta, la función y el flujo de todos los archivos involucrados en el sistema de inicio de sesión, creación de cuentas y manejo de sesiones.

---

## 1. BACKEND (Node.js + Express)

### 1.1. Variables de Entorno
*   **Archivo:** `.env` (Ubicado en la raíz de `StatsHub-Backend`)
*   **Función:** Almacena las credenciales de la base de datos y el secreto para firmar los tokens JWT.
*   **Variables clave:**
    ```env
    PORT=3000
    DB_HOST=localhost
    DB_PORT=5432
    DB_NAME=statshub_deportivo
    DB_USER=postgres
    DB_PASSWORD=tu_contraseña
    JWT_SECRET=<genera_uno_aleatorio_de_al_menos_32_caracteres>
1.2. Conexión a la Base de Datos
Archivo: src/config/database.js

Función: Crea un "Pool" de conexiones usando la librería pg. Exporta la conexión para que los controladores puedan hacer consultas SQL a PostgreSQL.

1.3. Lógica de Negocio (Controladores)
Archivo: src/controllers/auth.controller.js

Función: Contiene la lógica pura de la autenticación.

login(req, res): Recibe correo y password. Busca al usuario en la tabla seguridad.usuarios, usa bcrypt.compare() para verificar la contraseña, y si es correcta, genera un Token JWT con jsonwebtoken.

register(req, res): Recibe nombre, apellido, correo y password. Verifica que el correo no exista, encripta la contraseña con bcrypt.hash(), busca el ID del rol "espectador" en seguridad.roles e inserta el nuevo usuario en la base de datos.

1.4. Enrutamiento (Rutas)
Archivo: src/routes/auth.routes.js

Función: Define las URLs que el frontend puede consumir. Conecta las rutas con los controladores.

POST /api/auth/login -> Llama a auth.controller.login

POST /api/auth/register -> Llama a auth.controller.register

1.5. Punto de Entrada del Servidor
Archivo: src/server.js (o index.js según tu configuración)

Función: Inicializa Express, configura CORS (para permitir peticiones desde Vite/React) y monta las rutas de autenticación usando app.use('/api/auth', authRoutes).

2. FRONTEND (React)
2.1. Variables de Entorno
Archivo: .env (Ubicado en la raíz de StatsHub-Frontend)

Función: Indica la URL base del backend.

Variable clave:

env
VITE_API_URL=http://localhost:3000/api
2.2. Capa de Servicios (Peticiones HTTP)
Archivo: src/services/api.js

Función: Es el "mensajero" central. Se encarga de hacer el fetch al backend. Lee el Token JWT guardado en el localStorage y lo inyecta automáticamente en los headers (Authorization: Bearer <token>) de cada petición.

Archivo: src/services/auth.service.js

Función: Contiene los métodos específicos login(correo, password) y register(nombre, apellido, correo, password) que utilizan el archivo api.js para enviar los datos al backend.

2.3. Gestión de Estado Global (Contexto)
Archivo: src/context/authContext.js

Función: Crea el contexto de React (createContext) para que los datos del usuario estén disponibles en toda la aplicación.

Archivo: src/context/AuthProvider.jsx

Función: Es el componente "cerebro" de la sesión. Envuelve a toda la aplicación.

login(): Llama al servicio, recibe el Token y los datos del usuario, y los guarda en el localStorage.

register(): Llama al servicio para crear la cuenta y, si es exitoso, ejecuta el login automáticamente.

logout(): Borra el Token y los datos del localStorage.

can(permission): Verifica si el rol del usuario tiene permiso para realizar acciones específicas (ej. gestionar torneos).

2.4. Hook Personalizado
Archivo: src/hooks/useAuth.js

Función: Permite a cualquier componente acceder a los datos del usuario (user), a la función de login, logout, register y can() sin tener que importar el contexto directamente.

2.5. Vistas y Componentes de Interfaz (UI)
Archivo: src/pages/Login.jsx

Función: Formulario visual de inicio de sesión. Maneja los estados de "cargando" mientras espera la respuesta del backend y muestra los errores si las credenciales fallan. Permite alternar entre Login, Registro y Recuperación de contraseña.

Archivo: src/components/RouteGuards.jsx

Función: Componentes <RequireSession> y <RequirePermission>. Protegen las rutas privadas: si el usuario no tiene sesión, lo redirigen a /login.

Archivo: src/components/Sidebar.jsx y src/components/Header.jsx

Función: Muestran las iniciales y el nombre del usuario logueado. Incluyen el botón para cerrar sesión (logout).

Archivo: src/components/ProfileModal.jsx

Función: Muestra un modal con la información del perfil del usuario y las acciones que puede realizar según su rol.

Archivo: src/components/AccessRestricted.jsx

Función: Pantalla que se muestra si un usuario intenta acceder a una vista para la cual no tiene permisos.

3. FLUJO COMPLETO DE EJECUCIÓN
3.1. Flujo de Inicio de Sesión (Login)
El usuario llena el formulario en src/pages/Login.jsx.

Se ejecuta la función de login() del src/context/AuthProvider.jsx.

El Provider llama a src/services/auth.service.js, que a su vez usa src/services/api.js para hacer un POST a http://localhost:3000/api/auth/login.

El Backend recibe la petición en src/routes/auth.routes.js y la deriva a src/controllers/auth.controller.js.

El controlador hace un SELECT en la tabla seguridad.usuarios. Si la contraseña coincide (usando bcrypt.compare), firma un Token JWT y responde con un JSON.

El Frontend recibe el JSON, guarda el Token en localStorage y redirige al usuario al Dashboard.

3.2. Flujo de Registro de Usuario (Register)
El usuario llena el formulario de "Crear cuenta" en src/pages/Login.jsx.

El AuthProvider llama al método register del auth.service.js.

El Backend recibe la petición en auth.controller.js.

El controlador verifica que el correo no exista, encripta la contraseña con bcrypt.hash, y hace un INSERT en seguridad.usuarios asignándole el rol de "espectador".

Si el registro es exitoso, el controlador responde con un 201 Created.

El AuthProvider en el frontend recibe la confirmación y ejecuta la función login() automáticamente para que el usuario no tenga que volver a escribir sus datos.

4. CONTRATOS DE COMUNICACIÓN (Endpoints y JSON)
4.1. Endpoint: Login
URL: POST /api/auth/login

Body (lo que envía el Frontend):

json
{
  "correo": "admin@statshub.cl",
  "password": "mi_clave_secreta"
}
Response Exitosa (Status 200):

json
{
  "mensaje": "Login exitoso",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "usuario": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "nombre": "Juan",
    "apellido": "Villagran",
    "correo": "admin@statshub.cl",
    "rol": "administrador"
  }
}
Response Error (Status 401):

json
{ "error": "Credenciales inválidas" }
4.2. Endpoint: Registro
URL: POST /api/auth/register

Body (lo que envía el Frontend):

json
{
  "nombre": "Pedro",
  "apellido": "Pávez",
  "correo": "pedro@correo.cl",
  "password": "clave_segura_123"
}
Response Exitosa (Status 201):

json
{
  "mensaje": "Usuario registrado exitosamente",
  "usuario": {
    "id": "660f9500-f39c-52e5-b827-557766551111",
    "nombre": "Pedro",
    "apellido": "Pávez",
    "correo": "pedro@correo.cl"
  }
}
Response Error (Status 400 - Correo duplicado):

json
{ "error": "El correo ya está registrado" }
5. SEGURIDAD IMPLEMENTADA
Cifrado de contraseñas: Implementado en auth.controller.js usando bcrypt. La base de datos nunca guarda la contraseña real, solo el hash.

Tokens JWT: Implementado con jsonwebtoken. Permite mantener la sesión activa sin consultar la base de datos en cada clic, ya que el token firmado contiene el ID y el rol del usuario.

Protección de rutas frontend: Implementado en RouteGuards.jsx. Bloquea el acceso a vistas como /actas o /usuarios si el rol no cuenta con los permisos requeridos.

Variables de entorno: Las contraseñas de la base de datos y la clave secreta del JWT nunca están escritas en el código, sino en archivos .env que no se suben a GitHub.