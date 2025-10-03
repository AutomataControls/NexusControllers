#!/bin/bash

echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║           AutomataNexus Portal Restart Script                ║"
echo "╚═══════════════════════════════════════════════════════════════╝"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_status() {
    echo -e "${GREEN}[✓]${NC} $1"
}

print_error() {
    echo -e "${RED}[✗]${NC} $1"
}

print_info() {
    echo -e "${YELLOW}[*]${NC} $1"
}

# Kill all Node processes
print_info "Stopping all Node processes..."
pm2 kill 2>/dev/null || killall node 2>/dev/null
sleep 2

# Clean build cache
print_info "Cleaning build cache..."
cd /home/Automata/remote-access-portal
rm -rf .next .next-cache build dist 2>/dev/null
print_status "Cache cleaned"

# Rebuild the application
print_info "Rebuilding application..."
npm run build
if [ $? -eq 0 ]; then
    print_status "Build completed successfully"
else
    print_error "Build failed!"
    exit 1
fi

# Create logs directory
mkdir -p logs

# Start with PM2
print_info "Starting services with PM2..."
pm2 delete nexus-portal 2>/dev/null
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u Automata --hp /home/Automata 2>/dev/null

print_status "Portal restarted successfully!"
echo ""
pm2 status

# Optional: Open in fullscreen browser
if [ "$1" == "--browser" ]; then
    print_info "Opening portal in fullscreen browser..."
    sleep 3
    chromium-browser --kiosk --noerrdialogs --disable-infobars --no-first-run --disable-translate "http://localhost:8000" &
fi

echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║  Portal: http://localhost:8000                               ║"
echo "║  Logs: pm2 logs nexus-portal                                 ║"
echo "║  Stop: pm2 stop nexus-portal                                 ║"
echo "║  Restart: ./restartnexus.sh                                  ║"
echo "║  Fullscreen: ./restartnexus.sh --browser                     ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
