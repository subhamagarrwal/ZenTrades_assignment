FROM node:20-slim

# Install ffmpeg for audio processing
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install --production

# Copy everything else
COPY . .

# Create output directories
RUN mkdir -p outputs/accounts changelog

# Default command shows help
CMD ["node", "scripts/v1/runDemo.js"]