FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# guacamole-common-js only publishes CommonJS and ESM builds -- there is no UMD
# or browser-global bundle. Loading the CJS file straight from a <script> tag
# throws, because its last line is `module.exports = Guacamole` and `module` does
# not exist in a browser. Wrap it in an IIFE that supplies a fake `module` and
# then hangs the result on `window`, which gives us the global the frontend
# expects without pulling in a bundler.
RUN mkdir -p public/vendor \
 && { echo '(function(){var module={exports:{}};var exports=module.exports;'; \
      cat node_modules/guacamole-common-js/dist/cjs/guacamole-common.js; \
      echo ';window.Guacamole=module.exports;})();'; } \
    > public/vendor/guacamole-common.js

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/index.js"]
