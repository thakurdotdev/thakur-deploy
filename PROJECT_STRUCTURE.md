# Thakur Deploy - Project Overview

Thakur Deploy is a self-hosted PaaS (Platform as a Service) solution for deploying web applications (Next.js, Vite/React, and backend frameworks like Hono/Express) directly from GitHub. It mimics the functionality of platforms like Vercel but runs on your own infrastructure.

## Core Features

- **GitHub Integration**: Automatically listens for push events to deploy changes via GitHub App.
- **Zero-Downtime Deployments**: Maintains uptime during updates with health checks.
- **Frontend & Backend Support**: Native support for Next.js, Vite, and backend frameworks (Hono, Express, Elysia).
- **Environment Management**: Securely manage encrypted environment variables.
- **Custom Domains**: Automatic subdomain generation (`project-name.thakur.dev`).
- **Real-time Logs**: View build and deployment logs in real-time via WebSocket.
- **Structured Logging**: Log levels (info, warning, error, success, deploy) with clear logs functionality.
- **Authentication**: GitHub OAuth via Better Auth.

## Architecture & Services

The project is structured as a **Monorepo** containing several distinct services:

### 1. Control API (`packages/control-api`)

**Role**: The Brain.

- Manages the database (Projects, Builds, Deployments, Users, Build Logs).
- Exposes REST endpoints for the UI and other services.
- Handles authentication (Better Auth + GitHub OAuth).
- GitHub Apps integration for private repository access.
- WebSocket server for real-time log streaming.
- Job queue management via BullMQ + Redis.

**Key Files:**

- `src/db/schema.ts` - Drizzle ORM schema (projects, builds, buildLogs, deployments, etc.)
- `src/services/` - Business logic (BuildService, LogService, ProjectService, etc.)
- `src/routes/` - API endpoints (builds, projects, github, env, domains)
- `src/ws/` - WebSocket service for real-time updates

### 2. Deploy Engine (`packages/deploy-engine`)

**Role**: The Muscle.

- Runs on the deployment server.
- **Artifact Management**: Receives, extracts, and stores build artifacts.
- **Process Management**: Starts/Stops/Restarts applications using `bun`.
- **Request Proxy**: Routes incoming HTTP requests to running applications.
- **Health Checks**: Validates applications are running before marking deployment as active.
- **Log Streaming**: Sends deployment logs back to Control API.

**Key Files:**

- `src/services/deploy-service.ts` - Core deployment logic
- `src/services/log-service.ts` - Streams logs to Control API
- `src/index.ts` - HTTP server and request routing

### 3. Build Worker (`packages/build-worker`)

**Role**: The Builder.

- Picks up build jobs from Redis queue.
- Clones repositories (with GitHub App token for private repos).
- Installs dependencies and runs build commands.
- Converts npm/yarn/pnpm commands to bun equivalents.
- Bundles the output and streams artifacts to Deploy Engine.
- Streams structured logs with levels to Control API.

**Key Files:**

- `src/services/builder.ts` - Build execution logic
- `src/services/log-streamer.ts` - Buffered log streaming with levels
- `src/services/git-service.ts` - Git clone operations
- `src/services/artifact-service.ts` - Artifact packaging and upload

### 4. Webhook Listener (`packages/webhook-listener`)

**Role**: The Ear.

- Listens for GitHub webhooks (push events, installation events).
- Triggers new builds in the Control API when code is pushed.
- Manages GitHub App installation lifecycle.

### 5. UI (`packages/ui`)

**Role**: The Face.

- Modern Next.js 15 dashboard with App Router.
- Create/manage projects, view logs, manage env vars, monitor deployments.
- Real-time log viewer with WebSocket connection.
- GitHub repository browser for project creation.
- Authentication via Better Auth client.

**Key Files:**

- `app/` - Next.js App Router pages
- `components/log-viewer.tsx` - Real-time log viewer component
- `stores/log-store.ts` - Zustand store for log state
- `lib/api.ts` - API client for Control API

## Database Schema

```
projects          - Project configuration (name, github_url, app_type, domain, etc.)
builds            - Build records (status, artifact_id, timestamps)
build_logs        - Structured log entries (level, message, timestamp) ← NEW
deployments       - Active deployment tracking
environment_variables - Encrypted env vars per project
github_installations - GitHub App installation records
user/session/account - Better Auth tables
```

## Directory Structure

```
thakur-deploy/
├── packages/
│   ├── control-api/      # Backend API (Elysia.js + Drizzle ORM)
│   │   ├── src/
│   │   │   ├── services/ # Business logic (BuildService, LogService, etc.)
│   │   │   ├── routes/   # API endpoints
│   │   │   ├── db/       # Database schema & migrations
│   │   │   ├── ws/       # WebSocket service
│   │   │   └── queue/    # BullMQ job queue
│   │
│   ├── deploy-engine/    # Deployment & Runtime Manager
│   │   ├── src/services/ # Deploy, Process, Log services
│   │   └── apps/         # Deployed application instances
│   │
│   ├── build-worker/     # Build Job Processor
│   │   └── src/services/ # Builder, LogStreamer, GitService
│   │
│   ├── webhook-listener/ # GitHub Event Handler
│   │
│   └── ui/               # Frontend Dashboard (Next.js 15)
│       ├── app/          # App Router pages
│       ├── components/   # React components (log-viewer, etc.)
│       ├── stores/       # Zustand stores
│       └── lib/          # API client, types, utils
│
├── deploy.sh             # Deployment utility script
├── ecosystem.config.js   # PM2 configuration for running services
└── .env                  # Environment variables
```

## Key Workflows

### 1. New Deployment

1. **User** pushes code to GitHub.
2. **Webhook Listener** receives push event → Calls **Control API**.
3. **Control API** creates a `Build` record → Queues job via BullMQ.
4. **Build Worker** picks up job → Clones → Builds → Streams logs → Uploads artifact.
5. **Deploy Engine** extracts artifact → Installs deps → Starts app → Health check.
6. **Control API** marks deployment as `active`.

### 2. Real-time Log Flow

1. **Build Worker** or **Deploy Engine** sends log with level to Control API.
2. **Control API** persists to `build_logs` table.
3. **Control API** broadcasts via WebSocket to subscribed clients.
4. **UI** receives log and appends to log viewer in real-time.

### 3. Project Deletion

1. **User** clicks delete in UI.
2. **Control API** tells **Deploy Engine** to clean up:
   - Kill process (PID).
   - Remove artifact files.
3. **Control API** deletes DB records (cascades to builds, logs, env vars).

## Tech Stack

| Component     | Technology                 |
| ------------- | -------------------------- |
| API Framework | Elysia.js (Bun)            |
| Database      | PostgreSQL + Drizzle ORM   |
| Queue         | BullMQ + Redis             |
| Frontend      | Next.js 15 + Tailwind CSS  |
| Auth          | Better Auth + GitHub OAuth |
| Runtime       | Bun                        |
| Real-time     | Socket.IO                  |
