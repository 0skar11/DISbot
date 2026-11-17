FROM node:22-bookworm-slim

WORKDIR /usr/src/app

ENV NODE_ENV=production
# onnxruntime-node (`شيل الخلفية`) ships glibc binaries (not Alpine) and would download CUDA files on Linux x64:
# the CPU build bundled in the package is all the bot needs.
ENV ONNXRUNTIME_NODE_INSTALL=skip

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
