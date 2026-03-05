#!/bin/bash
set -e

# Load nvm if it exists
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

echo "Deploying updates to Business Mail..."

# Pull new code
git reset --hard
git pull origin main

# Install dependencies
npm ci --production

# Restart PM2 process
pm2 restart ecosystem.config.js --env production || pm2 start ecosystem.config.js --env production

# Save PM2 state
pm2 save

echo "Deployment finished successfully!"
