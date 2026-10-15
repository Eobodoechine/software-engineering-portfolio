FROM node:22-alpine
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN PV_LOCAL_DEMO=true npm run build
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["sh", "-c", "if [ \"$RUN_WORKER\" = \"true\" ]; then npm run worker; else npm start; fi"]
