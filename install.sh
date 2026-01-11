#!/bin/sh
# LuCI Mullvad WireGuard Manager - Installation Script
# Version: 1.0.0
# Usage: wget -O - https://raw.githubusercontent.com/linakis/luci-app-mullvad/main/install.sh | sh

set -e

echo "==================================================="
echo "  LuCI Mullvad WireGuard Manager - Installer"
echo "  Version: 1.0.0"
echo "==================================================="
echo ""

# Check if running as root
if [ "$(id -u)" != "0" ]; then
   echo "ERROR: This script must be run as root" 1>&2
   exit 1
fi

# Check prerequisites
echo "Checking prerequisites..."
MISSING_DEPS=""

for pkg in curl jsonfilter; do
    if ! opkg list-installed | grep -q "^$pkg "; then
        MISSING_DEPS="$MISSING_DEPS $pkg"
    fi
done

if [ -n "$MISSING_DEPS" ]; then
    echo "Missing dependencies:$MISSING_DEPS"
    echo "Installing dependencies..."
    opkg update
    opkg install $MISSING_DEPS
fi

echo "Prerequisites OK"
echo ""

# Download and extract
TEMP_DIR="/tmp/luci-app-mullvad-install"
rm -rf "$TEMP_DIR"
mkdir -p "$TEMP_DIR"
cd "$TEMP_DIR"

echo "Downloading package..."
wget -q --show-progress https://github.com/linakis/luci-app-mullvad/archive/refs/tags/v1.0.0.tar.gz -O luci-app-mullvad.tar.gz

echo "Extracting files..."
tar xzf luci-app-mullvad.tar.gz
cd luci-app-mullvad-1.0.0

echo "Installing files..."
# Copy application files
cp -r root/* /
cp -r htdocs/* /www/

# Make scripts executable
chmod +x /usr/bin/mullvad-fetch-servers.sh
chmod +x /usr/bin/mullvad-apply-server.sh
chmod +x /usr/bin/mullvad-get-status.sh

# Fix file permissions
chmod 644 /usr/share/rpcd/acl.d/luci-app-mullvad.json
chmod 644 /usr/share/luci/menu.d/luci-app-mullvad.json
chmod 644 /etc/config/mullvad
chmod 644 /www/luci-static/resources/view/mullvad/manager.js

# Fix directory permissions
chmod 755 /www/luci-static/resources/view/mullvad

echo "Initializing configuration..."
uci commit mullvad

echo "Restarting services..."
/etc/init.d/rpcd restart
/etc/init.d/uhttpd restart

# Cleanup
cd /
rm -rf "$TEMP_DIR"

echo ""
echo "==================================================="
echo "  Installation Complete!"
echo "==================================================="
echo ""
echo "Access the application:"
echo "  1. Open your router's LuCI interface"
echo "  2. Navigate to Services → Mullvad WireGuard"
echo ""
echo "Documentation: https://github.com/linakis/luci-app-mullvad"
echo ""
