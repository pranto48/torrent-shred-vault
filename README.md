# Welcome to your Lovable project

## Project info

**URL**: https://lovable.dev/projects/0b114f61-b813-437c-a624-96aa4ffef8e0

## How can I edit this code?

There are several ways of editing your application.

**Use Lovable**

Simply visit the [Lovable Project](https://lovable.dev/projects/0b114f61-b813-437c-a624-96aa4ffef8e0) and start prompting.

Changes made via Lovable will be committed automatically to this repo.

**Use your preferred IDE**

If you want to work locally using your own IDE, you can clone this repo and push changes. Pushed changes will also be reflected in Lovable.

The only requirement is having Node.js & npm installed - [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating)

Follow these steps:

```sh
# Step 1: Clone the repository using the project's Git URL.
git clone <YOUR_GIT_URL>

# Step 2: Navigate to the project directory.
cd <YOUR_PROJECT_NAME>

# Step 3: Install the necessary dependencies.
npm i

# Step 4: Start the development server with auto-reloading and an instant preview.
npm run dev
```

**Edit a file directly in GitHub**

- Navigate to the desired file(s).
- Click the "Edit" button (pencil icon) at the top right of the file view.
- Make your changes and commit the changes.

**Use GitHub Codespaces**

- Navigate to the main page of your repository.
- Click on the "Code" button (green button) near the top right.
- Select the "Codespaces" tab.
- Click on "New codespace" to launch a new Codespace environment.
- Edit files directly within the Codespace and commit and push your changes once you're done.

## What technologies are used for this project?

This project is built with:

- Vite
- TypeScript
- React
- shadcn-ui
- Tailwind CSS

## How can I deploy this project?

Simply open [Lovable](https://lovable.dev/projects/0b114f61-b813-437c-a624-96aa4ffef8e0) and click on Share -> Publish.

## Can I connect a custom domain to my Lovable project?

Yes, you can!

To connect a domain, navigate to Project > Settings > Domains and click Connect Domain.

Read more here: [Setting up a custom domain](https://docs.lovable.dev/tips-tricks/custom-domain#step-by-step-guide)

## Docker deployment

You can run Torrent Shred Vault in Docker and provision a local PostgreSQL database with Docker Compose.

### 1) Build and run

```sh
docker compose up --build -d
```

- Web app: `http://localhost:8080`
- PostgreSQL: `localhost:5432`

### 2) Optional configuration

Create a `.env` file in the project root to override defaults:

```env
POSTGRES_DB=torrent_shred_vault
POSTGRES_USER=torrent_user
POSTGRES_PASSWORD=change_me

# Frontend build-time Supabase values
VITE_SUPABASE_URL=http://localhost:54321
VITE_SUPABASE_ANON_KEY=local-dev-anon-key
```

> Note: The app expects a Supabase-compatible backend for auth/storage APIs. The bundled PostgreSQL container provides a local database service, while Supabase URL/key can be pointed to your own local or hosted Supabase stack.

## API service (JWT + RBAC)

A new API service is included under `api/` and runs in Docker Compose on `http://localhost:3000`.

### Features

- JWT auth (`/api/auth/register`, `/api/auth/login`, `/api/me`)
- RBAC roles: `user`, `admin`
- Admin-only endpoint: `/api/admin/users`
- User/Admin endpoint: `/api/vaults`
- Automatic DB bootstrap for `app_users` table
- Optional default admin seeding via env vars

### Default admin (Docker)

By default compose seeds an admin user using:

- Email: `mail@arifmahmud.com`
- Password: `ITSupp0rtbd`

Override in `.env`:

```env
DEFAULT_ADMIN_EMAIL=mail@arifmahmud.com
DEFAULT_ADMIN_PASSWORD=ITSupp0rtbd
JWT_SECRET=replace-with-strong-secret
```

### PostgreSQL schema migrations

API migrations are versioned SQL files in `api/migrations/`.

- `0001_init.sql` creates:
  - `app_users`
  - `pgcrypto` extension
- API startup runs migrations in sorted order.
- Applied migrations are recorded in `schema_migrations`.

## Object storage service (MinIO)

Docker Compose now includes MinIO for local object storage.

- S3 API endpoint: `http://localhost:9000`
- MinIO Console: `http://localhost:9001`
- Default credentials:
  - Access key: `minioadmin`
  - Secret key: `minioadmin123`

### MinIO environment variables

```env
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minioadmin123
MINIO_BUCKET=vault-data
MINIO_ENDPOINT=minio
MINIO_PORT=9000
MINIO_USE_SSL=false
```

The API service is preconfigured with these variables so the next storage integration step can directly create/read encrypted vault objects in MinIO.

## Vault creation

Vault model now persists in PostgreSQL:

- `user_vault` (private user drive)
- `share_vault` (share drive)

Behavior:
- On user registration, both default vaults are auto-created.
- Default admin seeding also auto-creates both vaults.
- `POST /api/vaults` creates or renames a vault by type for current user.
- `GET /api/vaults` returns persisted vault records for current user.

## Key management (Argon2id + KEK/DEK wrapping)

Implemented in API:

- Password hashing: Argon2id (`user_security.password_hash`)
- KEK derivation: Argon2id raw 32-byte key using per-user salt (`user_security.salt`)
- DEK generation: random 32-byte DEK per vault
- DEK wrapping: AES-256-GCM (`vault_keys.wrapped_dek`, `wrap_iv`, `wrap_tag`)

Schema added in `0003_key_management.sql`:
- `user_security`
- `vault_keys`

## Encrypted chunk upload/download

Added encrypted chunk APIs backed by MinIO object storage:

- `POST /api/chunks/upload?vaultId=<vault_uuid>`
  - Auth: Bearer token
  - Header: `x-vault-password: <user_password>`
  - Body: raw bytes (`application/octet-stream`)
  - Flow: derive KEK -> unwrap vault DEK -> encrypt chunk with AES-256-GCM -> store ciphertext in MinIO -> store metadata in `vault_chunks`

- `GET /api/chunks/:chunkId/download`
  - Auth: Bearer token
  - Header: `x-vault-password: <user_password>`
  - Flow: load encrypted object + metadata -> unwrap DEK -> decrypt -> return raw bytes

Schema: `api/migrations/0004_chunks.sql` creates `vault_chunks`.
