#!/bin/bash
# Claude Code Clean Reinstall Script
echo "===================================="
echo "Claude Code Clean Reinstall"
echo "===================================="

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [[ $EUID -ne 0 ]]; then
   echo -e "${RED}[!]${NC} This script must be run with sudo"
   exit 1
fi

echo -e "${YELLOW}[*]${NC} Starting Claude Code clean reinstall..."
npm uninstall -g @anthropic-ai/claude-code 2>/dev/null
rm -rf /usr/lib/node_modules/@anthropic-ai/claude-code 2>/dev/null
rm -rf /usr/lib/node_modules/@anthropic-ai/.claude-code* 2>/dev/null
echo -e "${GREEN}[✓]${NC} Cleaned up Claude Code directories"

echo -e "${YELLOW}[*]${NC} Installing Claude Code for ARM64 Linux..."
npm install -g @anthropic-ai/claude-code --target_arch=arm64 --target_platform=linux

if [ $? -eq 0 ]; then
    echo -e "${GREEN}[✓]${NC} Claude Code successfully installed!"
    echo "You can now use Claude Code by running: claude"
else
    echo -e "${RED}[✗]${NC} Failed to install Claude Code"
    exit 1
fi
