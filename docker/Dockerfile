# ════════════════════════════════════════════════════════════
# Stage 1: Compile whisper.cpp + llama.cpp (CPU-only, no GPU)
# ════════════════════════════════════════════════════════════
FROM node:20-slim AS cpp-builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends git cmake g++ make ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# whisper.cpp — local speech-to-text fallback (whisper-small)
RUN git clone --depth 1 https://github.com/ggerganov/whisper.cpp /opt/whisper && \
    cd /opt/whisper && \
    cmake -B build -DBUILD_SHARED_LIBS=OFF && \
    cmake --build build --config Release -j$(nproc) && \
    # Handle both new (whisper-cli) and old (main) binary names
    (cp build/bin/whisper-cli /usr/local/bin/whisper-cli 2>/dev/null || \
     cp build/bin/main /usr/local/bin/whisper-cli)

# llama.cpp — local LLM fallback (Qwen2.5-1.5B-Instruct)
RUN git clone --depth 1 https://github.com/ggerganov/llama.cpp /opt/llama && \
    cd /opt/llama && \
    cmake -B build -DBUILD_SHARED_LIBS=OFF -DGGML_CUDA=OFF -DLLAMA_CURL=OFF && \
    cmake --build build --config Release --target llama-server -j$(nproc) && \
    (cp build/bin/llama-server /usr/local/bin/llama-server 2>/dev/null || \
     cp build/bin/server /usr/local/bin/llama-server)

# ════════════════════════════════════════════════════════════
# Stage 2: Runtime image (slim — no build tools)
# ════════════════════════════════════════════════════════════
FROM node:20-slim

# Runtime deps:
#   ffmpeg   — audio chunking / wav conversion
#   curl     — model downloads on first use
#   libgomp1 — OpenMP threading for whisper.cpp / llama.cpp
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg curl libgomp1 ca-certificates && \
    update-ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Copy compiled C++ binaries from build stage
COPY --from=cpp-builder /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=cpp-builder /usr/local/bin/llama-server /usr/local/bin/llama-server

WORKDIR /app

# Copy package files first — cached unless dependencies change
COPY package.json package-lock.json* ./

# Production dependencies only
RUN npm install --omit=dev

# Copy source
COPY . .

# Pre-create dirs that will be volume-mounted
RUN mkdir -p outputs/accounts changelog inputs samples models

EXPOSE 3000

CMD ["node", "server.js"]