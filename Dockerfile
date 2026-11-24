FROM node:22-bookworm-slim

WORKDIR /usr/src/app

ENV NODE_ENV=production
# onnxruntime-node (`شيل الخلفية`) ships glibc binaries (not Alpine) and would download CUDA files on Linux x64:
# the CPU build bundled in the package is all the bot needs.
ENV ONNXRUNTIME_NODE_INSTALL=skip

COPY package*.json ./
# ffmpeg-static (`.caption` on video GIFs) downloads its static ffmpeg (linux-x64, about 30 MB) from GitHub during
# npm ci, so the build needs to reach github.com; FFMPEG_BIN can point at another ffmpeg instead.
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
