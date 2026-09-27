FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    NEEDLE_DROP_DATA_DIR=/data/daily

COPY site/package.json ./package.json
COPY site/dist ./dist
COPY site/scripts/*.mjs ./scripts/

RUN npm test \
    && mkdir -p /data/daily \
    && chown -R node:node /data

USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/serve.mjs"]
