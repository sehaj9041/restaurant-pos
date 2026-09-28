#!/usr/bin/env bash
set -o errexit

npm install
npx puppeteer browsers install chrome
