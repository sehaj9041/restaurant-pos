
#!/usr/bin/env bash
# Exit on error
set -o errexit

npm install

# Download Chrome for Puppeteer if not cached
npx puppeteer browsers install chrome
