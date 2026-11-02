# The image tag and playwright-core in package.json must be the same version: the image
# ships the matching Chromium. Bump them together.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

# Optional: a local forward-proxy CA to trust at build time (e.g. a sandbox whose proxy
# re-signs HTTPS). The directory always exists (.gitkeep) so the build works without one;
# only *.crt files are picked up. HTTP(S)_PROXY build args are used by npm and not kept.
COPY certs/ /usr/local/share/ca-certificates/

WORKDIR /opt/browser
COPY package.json package-lock.json ./
RUN update-ca-certificates \
  && NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt npm ci --omit=dev
COPY src/ src/

ENTRYPOINT ["node", "src/browse.mjs"]
