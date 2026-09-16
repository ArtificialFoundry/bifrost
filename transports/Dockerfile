# --- UI Build Stage: Build the React + Vite frontend ---
  FROM node:25-alpine3.23@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS ui-builder
  WORKDIR /app

  # Apply latest alpine security patches before installing packages
  RUN apk upgrade --no-cache

  # Copy UI package files and install dependencies
  COPY ui/package*.json ./
  RUN npm ci

  # Copy UI source code
  COPY ui/ ./

  # Build UI (skip the copy-build step)
  RUN npm run build-enterprise
  # Skip the copy-build step since we'll copy the files in the Go build stage

  # --- Go Build Stage: Compile the Go binary ---
  FROM golang:1.27.0-alpine3.24@sha256:4c9fe60190a2a3350ddc51de80d0224b8a6698d12bdfc999fee45ea9d6c46dbc AS builder
  WORKDIR /app

  # Install dependencies including gcc for CGO and sqlite (with latest security patches)
  RUN apk upgrade --no-cache && \
    apk add --no-cache gcc musl-dev sqlite-dev binutils binutils-gold

  # Set environment for CGO-enabled build (required for go-sqlite3)
  ENV CGO_ENABLED=1 GOOS=linux

  # BIFROST-FORK: inject our patched local modules into the versioned-module build.
  # transports/go.mod carries `replace` directives that send
  # github.com/maximhq/bifrost/core -> /core, .../plugins/logging -> /plugins/logging,
  # .../framework -> /framework, .../plugins/routing -> /plugins/routing, and
  # .../plugins/governance -> /plugins/governance, so our source edits (unified
  # githubcopilot provider + OAuth typed key-config in core, streaming-persist fix in
  # plugins/logging, config_keys OAuth column + rdb.go mapping in framework, and the
  # sticky/latency/circuit-breaker routing strategies in plugins/routing) are compiled
  # in. plugins/governance is copied because plugins/routing's go.mod itself replaces it
  # locally (see plugins/routing/go.mod's own replace block) — without it here, the
  # nested replace inside the routing module's go.mod can't resolve during the build.
  # Every other upstream module (otel/maxim/compat/prompts/semanticcache/telemetry/
  # modelcatalogresolver/mocker/...) still resolves from the Go module proxy at its
  # pinned version (unchanged upstream, nothing to override).
  COPY core/go.mod core/go.sum /core/
  COPY core/ /core/
  COPY plugins/logging/go.mod plugins/logging/go.sum /plugins/logging/
  COPY plugins/logging/ /plugins/logging/
  COPY framework/go.mod framework/go.sum /framework/
  COPY framework/ /framework/
  COPY plugins/routing/go.mod plugins/routing/go.sum /plugins/routing/
  COPY plugins/routing/ /plugins/routing/
  COPY plugins/governance/go.mod plugins/governance/go.sum /plugins/governance/
  COPY plugins/governance/ /plugins/governance/

  COPY transports/go.mod transports/go.sum ./
  RUN go mod download

  # Copy source code and dependencies
  COPY transports/ ./

  COPY --from=ui-builder /app/out ./bifrost-http/ui

  # Build the binary with CGO enabled and static SQLite linking
  ENV GOWORK=off
  ARG VERSION=unknown
  RUN go build \
    -ldflags="-w -s -X main.Version=v${VERSION} -extldflags '-static'" \
    -a -trimpath \
    -tags "sqlite_static" \
    -o /app/main \
    ./bifrost-http

  # Verify build succeeded
  RUN test -f /app/main || (echo "Build failed" && exit 1)

  # --- Runtime Stage: Minimal runtime image ---
  FROM alpine:3.23.5@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40
  WORKDIR /app

  # Install runtime dependencies for CGO-enabled binary
  # musl: C standard library (required for CGO binaries)
  # libgcc: GCC runtime library
  # ca-certificates: For HTTPS connections
  # nodejs + npm: required by Bifrost's MCP client stdio transport, which
  #   spawns MCP servers via `npx` (e.g. @modelcontextprotocol/server-*).
  #   Without Node in the runtime, adding any npx-based MCP server fails with
  #   `exec: "npx": executable file not found in $PATH`.
  RUN apk upgrade --no-cache && \
    apk add --no-cache musl libgcc ca-certificates zlib nodejs npm

  # Create data directory and set up user
  COPY --from=builder /app/main .
  COPY --from=builder /app/docker-entrypoint.sh .

  # Getting arguments
  ARG ARG_APP_PORT=8080
  ARG ARG_APP_HOST=0.0.0.0
  ARG ARG_LOG_LEVEL=info
  ARG ARG_LOG_STYLE=json
  ARG ARG_APP_DIR=/app/data

  # Environment variables with defaults (can be overridden at runtime)
  ENV APP_PORT=$ARG_APP_PORT \
    APP_HOST=$ARG_APP_HOST \
    LOG_LEVEL=$ARG_LOG_LEVEL \
    LOG_STYLE=$ARG_LOG_STYLE \
    APP_DIR=$ARG_APP_DIR

  # Go runtime performance tuning (override at runtime for your workload)
  # GOGC: GC target percentage. Higher = less frequent GC, more memory usage.
  #       Default: 100. For high-throughput with available memory, try 200-400.
  # GOMEMLIMIT: Soft memory limit for Go runtime. Set to ~90% of container memory limit.
  #             Example: "1800MiB" for a 2GB container, "3600MiB" for 4GB.
  #             When set, Go will be more aggressive about GC as it approaches this limit.
  # Note: GOMAXPROCS is automatically detected from cgroup CPU limits via automaxprocs.
  ENV GOGC="" \
    GOMEMLIMIT=""


  # adduser -D (no -u) on this alpine base assigns the first free UID, which is
  # 1000 on a fresh image — so the numeric USER 1000:0 below resolves to appuser.
  # Guard the group-writable chmod so it never applies when APP_DIR resolves to
  # /app itself (e.g. --build-arg ARG_APP_DIR=/app), which would make the binary
  # group-0-writable.
  RUN mkdir -p "$APP_DIR/logs" && \
    adduser -D -s /bin/sh appuser && \
    chown -R appuser:appuser /app && \
    chown -R appuser:0 "$APP_DIR" && \
    { [ "$APP_DIR" = "/app" ] || chmod -R g=rwX "$APP_DIR"; } && \
    chmod +x /app/docker-entrypoint.sh
  # Numeric USER (uid:gid) so kubelet can verify runAsNonRoot; group 0 grants
  # write access to the group-0-owned data dir under arbitrary OpenShift UIDs.
  USER 1000:0


  # Declare volume for data persistence
  VOLUME ["${APP_DIR}"]
  EXPOSE $APP_PORT

  # Health check for container status monitoring
  # Uses busybox wget (built into alpine) instead of the standalone wget package
  # to avoid CVE-2025-69194; busybox wget supports -q/-O but not --no-verbose/--tries.
  HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:${APP_PORT}/health || exit 1

  # Use entrypoint script that handles volume permissions and argument processing
  ENTRYPOINT ["/app/docker-entrypoint.sh"]
  CMD ["/app/main"]
