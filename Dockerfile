# UFile worker: the site (with the engines already built into public/engines/) and its server.
#   scripts/build-engines.sh          # on the build machine: Rust + trunk
#   docker build -t ufile-worker .
#   docker run -p 8080:8080 -v ufile-files:/data ufile-worker
FROM node:24-alpine
WORKDIR /app
COPY server ./server
COPY public ./public
ENV UFILE_HOST=0.0.0.0 \
    UFILE_PORT=8080 \
    UFILE_STORAGE=/data \
    UFILE_QUIET=1
VOLUME /data
EXPOSE 8080
USER node
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/server.mjs"]
