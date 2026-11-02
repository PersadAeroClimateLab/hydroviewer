FROM node:22-alpine

# Dependencies live in /node_modules, not /app/node_modules, so bind-mounting the repo onto
# /app does not hide them and there is no stale named volume to clear. Node resolves
# imports from /app upward to /node_modules. After changing package.json, rebuild the image.
WORKDIR /
COPY package.json package-lock.json ./
RUN npm ci
ENV PATH=/node_modules/.bin:$PATH

WORKDIR /app
CMD ["vite"]
