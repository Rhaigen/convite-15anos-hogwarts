# Profeta Diário: Node 24 roda o TypeScript direto (sem build) e o ffmpeg converte as mídias.
# Sem dependências do npm. Construído na VPS por `npm run deploy:profeta` (ver docs/hospedagem-vps.md).
FROM node:24-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production PROFETA_DADOS=/dados PORT=8080
# O disco /dados pertence ao usuário node (uid 1000): chown 1000:1000 na montagem.
USER node
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
