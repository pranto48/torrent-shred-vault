# Torrent Shred Vault

Docker-first local vault web app with encrypted MinIO storage, Postgres metadata, JWT auth, user/share vaults, and an admin update workflow.

## Docker deployment

Create a private `.env` from `.env.docker.example`, set strong secrets, then run:

```sh
docker compose up --build -d
```

- Web app: `http://192.168.20.5:4400/`
- API: proxied through `http://192.168.20.5:4400/api`
- Postgres and MinIO: internal Docker services with persistent volumes
- Default admin is seeded from `DEFAULT_ADMIN_EMAIL` and `DEFAULT_ADMIN_PASSWORD`

The admin panel includes a System Update tab that checks `https://github.com/pranto48/torrent-shred-vault.git` branch `main`, rebuilds Docker images, and recreates containers without deleting the Postgres or MinIO volumes.

See `BUILD_POLICY.md` for the current build state, quota rules, encryption policy, and Windows/Android client roadmap.

# Lovable project notes

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

## Implementation notes

- API migrations live in `api/migrations/` and run automatically on API startup.
- Vault file metadata is stored in Postgres; encrypted file chunks are stored in MinIO.
- `user_vault` upload/download requires the user password in the `x-vault-password` header.
- `share_vault` files are listed and downloaded by authenticated users through `/api/share/files`.
- Nginx uses SPA fallback, so `/auth`, `/dashboard`, and `/admin` can be opened directly in Docker.
