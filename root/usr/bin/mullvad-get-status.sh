#!/bin/sh
# Mullvad WireGuard Status Checker
# Returns JSON with current connection status, endpoint, handshake, and transfer stats

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
    WG_INTERFACE=$(auto_detect_interface)

    if [ -n "$WG_INTERFACE" ]; then
        # Save the detected interface to config for future use
        uci set mullvad.config.wireguard_interface="$WG_INTERFACE" 2>/dev/null
        uci commit mullvad 2>/dev/null
    else
        # Default to MullvadWG if auto-detection fails
        WG_INTERFACE="MullvadWG"
    fi
fi

# Get WireGuard status
WG_STATUS=$(wg show "$WG_INTERFACE" 2>/dev/null)

# Check if interface exists
if [ -z "$WG_STATUS" ]; then
    cat <<EOF
{
    "connected": false,
    "interface": "$WG_INTERFACE",
    "error": "Interface not found or WireGuard not running",
    "endpoint": "N/A",
    "current_host": "N/A",
    "current_server": "Not configured",
    "latest_handshake": "Never",
    "transfer_rx": "0 B",
    "transfer_tx": "0 B"
}
EOF
    exit 0
fi

# Find the peer section for this interface
PEER_SECTION=$(uci show network 2>/dev/null | grep "^network\..*=wireguard_${WG_INTERFACE}" | head -1 | cut -d. -f2 | cut -d= -f1)

# Get current server info from UCI
CURRENT_HOST="N/A"
CURRENT_DESC="Not configured"
if [ -n "$PEER_SECTION" ]; then
    CURRENT_HOST=$(uci -q get network.${PEER_SECTION}.endpoint_host 2>/dev/null)
    CURRENT_DESC=$(uci -q get network.${PEER_SECTION}.description 2>/dev/null)
    [ -z "$CURRENT_HOST" ] && CURRENT_HOST="N/A"
    [ -z "$CURRENT_DESC" ] && CURRENT_DESC="Mullvad VPN Server"
fi

# Parse WireGuard output
ENDPOINT=$(echo "$WG_STATUS" | grep "endpoint:" | awk '{print $2}' | head -1)
LATEST_HANDSHAKE=$(echo "$WG_STATUS" | grep "latest handshake:" | sed 's/.*latest handshake: //' | head -1)
TRANSFER_RX=$(echo "$WG_STATUS" | grep "transfer:" | awk '{print $2, $3}' | head -1)
TRANSFER_TX=$(echo "$WG_STATUS" | grep "transfer:" | awk '{print $5, $6}' | head -1)

# Set defaults if empty
[ -z "$ENDPOINT" ] && ENDPOINT="N/A"
[ -z "$LATEST_HANDSHAKE" ] && LATEST_HANDSHAKE="Never"
[ -z "$TRANSFER_RX" ] && TRANSFER_RX="0 B"
[ -z "$TRANSFER_TX" ] && TRANSFER_TX="0 B"

# Determine connection status based on handshake
CONNECTED="false"
if [ "$LATEST_HANDSHAKE" != "Never" ]; then
    # Check if handshake contains "second" or "minute" (recent connection)
    # WireGuard shows: "X seconds ago", "X minutes ago", or timestamp
    if echo "$LATEST_HANDSHAKE" | grep -qE "second|minute"; then
        CONNECTED="true"
    # Also check for "1 hour" through "2 hours" as still connected
    elif echo "$LATEST_HANDSHAKE" | grep -qE "1 hour|hours ago" | grep -qE "^(1|2) hour"; then
        # Extract hour number
        HOURS=$(echo "$LATEST_HANDSHAKE" | grep -oE "^[0-9]+" | head -1)
        if [ -n "$HOURS" ] && [ "$HOURS" -le 2 ]; then
            CONNECTED="true"
        fi
    fi
fi

# Escape special characters for JSON
escape_json() {
    echo "$1" | sed 's/"/\\"/g' | sed "s/'/\\'/g"
}

ENDPOINT=$(escape_json "$ENDPOINT")
CURRENT_HOST=$(escape_json "$CURRENT_HOST")
CURRENT_DESC=$(escape_json "$CURRENT_DESC")
LATEST_HANDSHAKE=$(escape_json "$LATEST_HANDSHAKE")
TRANSFER_RX=$(escape_json "$TRANSFER_RX")
TRANSFER_TX=$(escape_json "$TRANSFER_TX")

# Output JSON
cat <<EOF
{
    "connected": $CONNECTED,
    "interface": "$WG_INTERFACE",
    "endpoint": "$ENDPOINT",
    "current_host": "$CURRENT_HOST",
    "current_server": "$CURRENT_DESC",
    "latest_handshake": "$LATEST_HANDSHAKE",
    "transfer_rx": "$TRANSFER_RX",
    "transfer_tx": "$TRANSFER_TX"
}
EOF

exit 0
