#!/bin/sh
# Mullvad Server Configuration Applier
# Updates WireGuard peer configuration with new Mullvad server
# Usage: mullvad-apply-server.sh <hostname> <public_key> <endpoint_ip> <endpoint_port>

# Validate arguments
if [ $# -ne 4 ]; then
    echo "ERROR: Invalid number of arguments"
    echo "Usage: $0 <hostname> <public_key> <endpoint_ip> <endpoint_port>"
    echo "Example: $0 us-nyc-wg-301 abc123... 192.0.2.1 51820"
    exit 1
fi

HOSTNAME="$1"
PUBLIC_KEY="$2"
ENDPOINT_IP="$3"
ENDPOINT_PORT="$4"

# Input validation
if [ -z "$HOSTNAME" ] || [ -z "$PUBLIC_KEY" ] || [ -z "$ENDPOINT_IP" ] || [ -z "$ENDPOINT_PORT" ]; then
    echo "ERROR: All parameters must be non-empty"
    exit 1
fi

# Validate endpoint port is numeric
if ! echo "$ENDPOINT_PORT" | grep -qE '^[0-9]+$'; then
    echo "ERROR: Endpoint port must be numeric"
    exit 1
fi

# Validate endpoint port range
if [ "$ENDPOINT_PORT" -lt 1 ] || [ "$ENDPOINT_PORT" -gt 65535 ]; then
    echo "ERROR: Endpoint port must be between 1 and 65535"
    exit 1
fi

# Validate IP address format (basic check)
if ! echo "$ENDPOINT_IP" | grep -qE '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'; then
    echo "ERROR: Invalid IP address format"
    exit 1
fi

# Validate public key format (base64, typically 44 characters for WireGuard)
if ! echo "$PUBLIC_KEY" | grep -qE '^[A-Za-z0-9+/]+=*$'; then
    echo "ERROR: Invalid public key format (must be base64)"
    exit 1
fi

# Auto-detect WireGuard interface or use configured value
auto_detect_interface() {
    # Look for WireGuard interfaces in network config
    # Find interfaces with proto=wireguard and an associated peer
    for iface in $(uci show network | grep "\.proto='wireguard'" | cut -d. -f2 | cut -d= -f1); do
        # Check if there's a corresponding peer section (wireguard_<interface>)
        if uci show network | grep -q "^network\..*=wireguard_${iface}"; then
            echo "$iface"
            return 0
        fi
    done
    return 1
}

# Get WireGuard interface name from mullvad config
WG_INTERFACE=$(uci -q get mullvad.config.wireguard_interface 2>/dev/null)

# If not configured, try auto-detection
if [ -z "$WG_INTERFACE" ]; then
    echo "No interface configured, attempting auto-detection..."
    WG_INTERFACE=$(auto_detect_interface)

    if [ -n "$WG_INTERFACE" ]; then
        echo "Auto-detected WireGuard interface: $WG_INTERFACE"
        # Save the detected interface to config for future use
        uci set mullvad.config.wireguard_interface="$WG_INTERFACE"
        uci commit mullvad
        echo "Saved interface name to configuration"
    else
        echo "WARNING: Could not auto-detect interface, using default: MullvadWG"
        WG_INTERFACE="MullvadWG"
    fi
else
    echo "Using configured interface: $WG_INTERFACE"
fi

# Find the peer section name for this interface
# Look for wireguard_<interface_name> section in network config
PEER_SECTION=$(uci show network | grep "^network\..*=wireguard_${WG_INTERFACE}" | head -1 | cut -d. -f2 | cut -d= -f1)

if [ -z "$PEER_SECTION" ]; then
    echo "ERROR: Could not find WireGuard peer section for interface $WG_INTERFACE"
    echo "Expected section name pattern: wireguard_${WG_INTERFACE}"
    exit 1
fi

echo "Found peer section: network.$PEER_SECTION"

# Get current configuration for comparison
CURRENT_PUBLIC_KEY=$(uci -q get network.${PEER_SECTION}.public_key 2>/dev/null)
CURRENT_ENDPOINT=$(uci -q get network.${PEER_SECTION}.endpoint_host 2>/dev/null)
CURRENT_PORT=$(uci -q get network.${PEER_SECTION}.endpoint_port 2>/dev/null)

echo "Current configuration:"
echo "  Public Key: ${CURRENT_PUBLIC_KEY:-<not set>}"
echo "  Endpoint: ${CURRENT_ENDPOINT:-<not set>}:${CURRENT_PORT:-<not set>}"

echo "New configuration:"
echo "  Public Key: $PUBLIC_KEY"
echo "  Endpoint: $ENDPOINT_IP:$ENDPOINT_PORT"
echo "  Server: $HOSTNAME"

# Update peer configuration
echo "Updating UCI configuration..."

uci set network.${PEER_SECTION}.public_key="$PUBLIC_KEY"
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to set public_key"
    exit 1
fi

uci set network.${PEER_SECTION}.endpoint_host="$ENDPOINT_IP"
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to set endpoint_host"
    exit 1
fi

uci set network.${PEER_SECTION}.endpoint_port="$ENDPOINT_PORT"
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to set endpoint_port"
    exit 1
fi

uci set network.${PEER_SECTION}.description="Mullvad VPN Server: $HOSTNAME"
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to set description"
    exit 1
fi

# Commit changes to UCI
echo "Committing changes to UCI..."
uci commit network
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to commit UCI changes"
    exit 1
fi

echo "OK: Configuration updated successfully"
echo "NOTE: Changes committed to UCI but not yet applied"
echo "      Use LuCI 'Apply' button or run '/etc/init.d/network reload' to apply changes"
exit 0
