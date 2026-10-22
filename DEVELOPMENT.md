# Development setup

## Requirements

- Bash and `curl` to install Bun when it is not already installed.
- Docker Engine with the Docker Compose plugin for the local PostgreSQL and LocalStack services.

## Install and verify Bun

The project pins Bun 1.4.3 in `package.json`, the Docker images, and the bootstrap script. To install it in the default user directory and prepare the project:

```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
bash scripts/bootstrap.sh
```

The script installs the exact pinned Bun release when it cannot find that release at `BUN_INSTALL/bin/bun`. It then performs a frozen lockfile install, strict typecheck, and build. If another Bun executable is on `PATH` but has a different version, the script stops with a version error instead of silently switching runtimes.

To keep the Bun installation in a temporary directory, set `BUN_INSTALL` explicitly and add its `bin` directory to `PATH` for subsequent commands:

```bash
export BUN_INSTALL=/tmp/jungle-bun
export PATH="$BUN_INSTALL/bin:$PATH"
bash scripts/bootstrap.sh
```

## Start local infrastructure

```bash
docker compose up -d --build
docker compose ps
```

The Compose stack starts PostgreSQL, LocalStack SQS, and the NestJS liveness endpoint. The LocalStack health check accepts the SQS states returned by supported LocalStack releases. Verify the API with:

```bash
bun run smoke
```

Stop the stack with `docker compose down`. The PostgreSQL volume is retained; use `docker compose down -v` only when intentionally deleting local database state.
