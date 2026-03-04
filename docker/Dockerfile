FROM node:20-slim

# Install system deps (cached unless this changes)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first — cached unless dependencies change
COPY package.json package-lock.json* ./

# Install all deps including devDependencies (nodemon)
RUN npm install

# Copy source — this layer rebuilds only when code changes
COPY . .

# Pre-create dirs
RUN mkdir -p outputs/accounts changelog inputs

# Use nodemon for dev hot-reload
CMD ["npx", "nodemon", "--watch", "server.js", "--watch", "scripts", "server.js"]