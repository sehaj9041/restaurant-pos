#!/usr/bin/env bash
set -o errexit

npm install
npm install sqlite3@5.1.7 --build-from-source
export PUPPETEER_CACHE_DIR=/opt/render/project/src/.puppeteer_cache
npx puppeteer browsers install chrome
