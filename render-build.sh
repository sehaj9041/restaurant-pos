#!/usr/bin/env bash
set -o errexit

npm install
npm rebuild sqlite3 --build-from-source
