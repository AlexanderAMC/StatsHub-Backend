# Despliegue de StatsHub Deportivo

Guía para poner en producción los tres repositorios en AWS, siguiendo la arquitectura del
proyecto de título: **EC2 (API + servicio de ML + Nginx) + RDS PostgreSQL**, con el frontend
servido por Nginx en la misma instancia (opción simple) o por **S3 + CloudFront** (opción escalable).

```
                Internet (HTTPS)
                       │
              ┌────────▼─────────┐       (opcional) CloudFront + S3 para el frontend
              │  Nginx (443/80)  │  EC2 Ubuntu 24.04
              │  /        → dist │
              │  /api     → :3000│──► statshub-api  (Node 22, PM2)  ──► RDS PostgreSQL 17 (Multi-AZ)
              │  /uploads → disco│        │
              └──────────────────┘        └──► statshub-ml (Python 3.12, PM2, 127.0.0.1:8000)
                                          └──► Flow (pagos) · SMTP (correo)
```

## 1. Estructura en el servidor

```
/var/www/statshub/
├── StatsHub-Backend/     # git clone (rama main) → PM2: statshub-api y statshub-ml
├── StatsHub-Database/    # git clone → migraciones y seeds
├── StatsHub-Frontend/    # git clone → npm run build
├── frontend/             # copia de StatsHub-Frontend/dist (lo que sirve Nginx)
└── uploads/              # escudos WebP (UPLOADS_DIR); respaldar o mover a S3
```

Usuario de sistema sin privilegios para correr la aplicación: `statshub` (dueño de `/var/www/statshub`).

## 2. Infraestructura AWS

| Recurso | Configuración recomendada |
|---|---|
| EC2 | t3.small (2 GB), Ubuntu 24.04, disco gp3 20 GB, IP elástica |
| Security Group EC2 | entrada 80/443 desde 0.0.0.0/0; 22 solo desde tu IP |
| RDS | PostgreSQL 17, db.t3.micro/small, **Multi-AZ** (RNF-13), backups automáticos 7 días (RNF-14), cifrado en reposo |
| Security Group RDS | 5432 solo desde el Security Group de la EC2 (nunca público) |
| Route 53 / DNS | `statshub.cl` → IP elástica de la EC2 |

## 3. Preparar la instancia

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx git python3 python3-pip python3-venv postgresql-client certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs build-essential
sudo npm install -g pm2
sudo adduser --system --group --home /var/www/statshub statshub
sudo -u statshub git clone https://github.com/AlexanderAMC/StatsHub-Backend.git  /var/www/statshub/StatsHub-Backend
sudo -u statshub git clone https://github.com/AlexanderAMC/StatsHub-Database.git /var/www/statshub/StatsHub-Database
sudo -u statshub git clone https://github.com/AlexanderAMC/StatsHub-Frontend.git /var/www/statshub/StatsHub-Frontend
sudo -u statshub mkdir -p /var/www/statshub/uploads /var/www/statshub/frontend
```

## 4. Base de datos (RDS)

1. Crear la base y un **usuario de aplicación con permisos mínimos** (no usar `postgres` en la API):

```sql
CREATE DATABASE statshub_deportivo;
CREATE ROLE statshub_app LOGIN PASSWORD '<contraseña larga y aleatoria>';
\c statshub_deportivo
GRANT CONNECT ON DATABASE statshub_deportivo TO statshub_app;
```

2. Aplicar migraciones (con el usuario administrador de RDS) y seeds:

```bash
cd /var/www/statshub/StatsHub-Database
npm ci
cp .env.example .env    # DB_HOST=<endpoint RDS>, DB_USER=<admin RDS>, DB_PASSWORD=...
npm run migrate:up
npm run seed            # roles y categorías (NO usar --demo en producción)
```

3. Dar permisos al usuario de aplicación sobre los esquemas:

```sql
GRANT USAGE ON SCHEMA seguridad, deportivo, pagos, auditoria, analytics TO statshub_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA seguridad, deportivo, pagos, auditoria, analytics TO statshub_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA seguridad, deportivo, pagos, auditoria, analytics TO statshub_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA seguridad, deportivo, pagos, auditoria, analytics
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO statshub_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA seguridad, deportivo, pagos, auditoria, analytics
  GRANT USAGE, SELECT ON SEQUENCES TO statshub_app;
```

> Base existente creada con los scripts antiguos (`install.sql`/`schemas/`): `npm run migrate:baseline` y luego `npm run migrate:up`.

## 5. Backend y servicio de ML

```bash
cd /var/www/statshub/StatsHub-Backend
npm ci --omit=dev
npm install-scripts approve bcrypt && npm rebuild bcrypt   # npm bloquea los scripts de instalación por defecto
python3 -m venv ml-service/.venv && ml-service/.venv/bin/pip install -r ml-service/requirements.txt
cp .env.example .env && chmod 600 .env
```

Variables de producción en `.env` (ver `.env.example`):

| Variable | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `FRONTEND_URL` / `FRONTEND_PUBLIC_URL` | `https://statshub.cl` |
| `API_PUBLIC_URL` | `https://statshub.cl` (Flow notifica a `/api/pagos/flow/confirmacion`) |
| `TRUST_PROXY` | `1` (detrás de Nginx) |
| `DB_*` | endpoint de RDS y usuario `statshub_app` |
| `JWT_SECRET` | `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `UPLOADS_DIR` | `/var/www/statshub/uploads` |
| `ML_SERVICE_URL` | `http://127.0.0.1:8000` |
| `SMTP_*`, `MAIL_FROM` | proveedor de correo (Amazon SES, Gmail Workspace, etc.) |
| `FLOW_API_URL`, `FLOW_API_KEY`, `FLOW_SECRET_KEY` | credenciales de Flow (primero sandbox) |

Crear el administrador (la contraseña no queda en ningún archivo):

```bash
ADMIN_EMAIL=admin@statshub.cl ADMIN_PASSWORD='<contraseña segura>' npm run create-admin
```

Levantar los procesos con PM2:

```bash
ML_PYTHON=/var/www/statshub/StatsHub-Backend/ml-service/.venv/bin/python \
  pm2 start deploy/ecosystem.config.js --env production
pm2 save && pm2 startup          # ejecutar el comando que imprime pm2 startup
pm2 logs statshub-api            # ver logs
curl http://127.0.0.1:3000/api/salud   # → {"estado":"ok"}
curl http://127.0.0.1:8000/health      # → {"status":"ok"}
```

## 6. Frontend

```bash
cd /var/www/statshub/StatsHub-Frontend
npm ci
VITE_API_URL=https://statshub.cl/api npm run build
rsync -a --delete dist/ /var/www/statshub/frontend/
```

**Opción S3 + CloudFront:** subir `dist/` a un bucket privado con OAC, CloudFront con certificado ACM,
comportamiento por defecto → S3 (error 403/404 → `/index.html`, código 200) y comportamiento `/api/*`
→ origen EC2. En ese caso Nginx solo atiende `/api` y `/uploads`.

## 7. Nginx y HTTPS

```bash
sudo cp /var/www/statshub/StatsHub-Backend/deploy/nginx/statshub.conf /etc/nginx/sites-available/statshub
sudo ln -s /etc/nginx/sites-available/statshub /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo certbot --nginx -d statshub.cl -d www.statshub.cl   # certificado Let's Encrypt (RNF-06), renovación automática
sudo nginx -t && sudo systemctl reload nginx
```

La configuración ya incluye: redirección a HTTPS, HSTS, cabeceras de seguridad, proxy sin buffer para
el tiempo real (`/api/tiempo-real`), límite de peticiones por IP y caché de los archivos estáticos.

## 8. Flow (pagos)

1. Probar primero en **sandbox** (`FLOW_API_URL=https://sandbox.flow.cl/api`) con las credenciales de prueba de Flow.
2. En el panel de Flow no hace falta registrar URLs: StatsHub envía `urlConfirmation` y `urlReturn` en cada cobro,
   construidas desde `API_PUBLIC_URL`. Deben ser accesibles desde internet por HTTPS.
3. Al pasar a producción cambiar `FLOW_API_URL=https://www.flow.cl/api` y las claves de producción, y reiniciar:
   `pm2 restart statshub-api`.

## 9. Respaldos y recuperación (RNF-14, RNF-15)

- **RDS:** snapshots automáticos diarios (retención 7 días) + Multi-AZ. Restauración a un punto en el tiempo
  desde la consola de RDS (objetivo RTO < 4 h).
- **Escudos:** respaldar `/var/www/statshub/uploads` (p. ej. `aws s3 sync` diario por cron) o configurar la API para S3.
- **Dump adicional opcional** (cron diario):
  `pg_dump -Fc -h <endpoint> -U <admin> statshub_deportivo > /var/backups/statshub-$(date +\%F).dump`
- Probar una restauración completa al menos una vez antes del lanzamiento y documentar el tiempo obtenido.

## 10. Actualizar a una nueva versión

```bash
cd /var/www/statshub/StatsHub-Database && git pull && npm ci && npm run migrate:up
cd /var/www/statshub/StatsHub-Backend  && git pull && npm ci --omit=dev && pm2 reload deploy/ecosystem.config.js --env production
cd /var/www/statshub/StatsHub-Frontend && git pull && npm ci && VITE_API_URL=https://statshub.cl/api npm run build && rsync -a --delete dist/ /var/www/statshub/frontend/
```

Las migraciones se aplican **antes** de reiniciar la API. Cada repositorio tiene CI en GitHub Actions
(`.github/workflows/ci.yml`) que ejecuta lint/tests en cada push a `develop` y `main`.

## 11. Lista de verificación antes de abrir al público

- [ ] `NODE_ENV=production`, `JWT_SECRET` aleatorio y `.env` con permisos `600`
- [ ] La API usa `statshub_app`, no el usuario administrador de RDS
- [ ] RDS sin acceso público; puerto 22 de la EC2 restringido a tu IP
- [ ] HTTPS activo y `http://` redirige a `https://`
- [ ] `GET /api/salud` responde `ok`; `pm2 status` sin reinicios en bucle
- [ ] Correo de recuperación de contraseña recibido de verdad (SMTP configurado)
- [ ] Pago de prueba en Flow sandbox: el equipo pasa a "Inscrito" y el comprobante se ve
- [ ] Administrador creado con `npm run create-admin`; sin cuentas de prueba (`seed --demo`) en producción
- [ ] Snapshot de RDS verificado y restauración probada
- [ ] CloudWatch: alarma de CPU > 70 % y de estado de la instancia (KPI-01)
