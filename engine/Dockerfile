# APE Engine — Railway container
#
# v2.26 (Session 1 of the rebuild): first-ever npm dependency, better-sqlite3.
# Requires build-essentials + python3 for the native binding to compile
# during npm install. The install adds ~30MB to the image and ~15s to build
# but eliminates the class of state-corruption failures that motivated the
# rebuild in the first place.

FROM node:20-slim
WORKDIR /app

# System tools:
#   ffmpeg           — for scene_video.js FFmpeg concat/edit pipeline
#   build-essential  — gcc/g++ for better-sqlite3 native compilation
#   python3          — node-gyp needs python
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Install npm deps first (better Docker layer caching — the package.json
# changes less often than the source code)
COPY package.json ./
RUN npm install --omit=dev

# Then copy the rest of the source
COPY . .

ENV NODE_ENV=production
CMD ["node", "server.js"]
