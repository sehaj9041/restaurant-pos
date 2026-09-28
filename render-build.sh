#!/usr/bin/env bash
set -o errexit

npm install
npm install sqlite3@5.1.7 --build-from-source
npx puppeteer browsers install chrome
