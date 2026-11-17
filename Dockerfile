FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
# npm ci installs exactly what the lockfile pins, and fails if the two disagree.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# guacamole-common-js only publishes CommonJS and ESM builds -- there is no UMD
# or browser-global bundle. Loading the CJS file straight from a <script> tag
# throws, because its last line is `module.exports = Guacamole` and `module` does
# not exist in a browser. Wrap it in an IIFE that supplies a fake `module` and
# then hangs the result on `window`, which gives us the global the frontend
# expects without pulling in a bundler.
COPY public ./public
RUN mkdir -p public/vendor \
 && { echo '(function(){var module={exports:{}};var exports=module.exports;'; \
      cat node_modules/guacamole-common-js/dist/cjs/guacamole-common.js; \
      echo ';window.Guacamole=module.exports;})();'; } \
    > public/vendor/guacamole-common.js

COPY src ./src

# Reported by vncgw_build_info. install.sh passes the git commit it deployed.
ARG VNCGW_COMMIT=unknown
ENV VNCGW_COMMIT=${VNCGW_COMMIT} \
    NODE_ENV=production

# The app needs no privileges and writes nothing to disk.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s --start-interval=2s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/index.js"]
