#!/bin/sh
# Mullvad Server List Fetcher
# Fetches active WireGuard servers from Mullvad API and caches them

API_URL="https://api.mullvad.net/app/v1/relays"
CACHE_FILE="/tmp/mullvad_servers.json"
UCI_CONFIG="mullvad"

# Fetch from Mullvad API
fetch_servers() {
    echo "Fetching server list from Mullvad API..." >&2
    RESPONSE=$(curl -s --max-time 30 "$API_URL" 2>&1)
    CURL_EXIT=$?

    if [ $CURL_EXIT -ne 0 ]; then
        echo "ERROR: curl failed with exit code $CURL_EXIT" >&2
        return 1
    fi

    if [ -z "$RESPONSE" ]; then
        echo "ERROR: Empty response from API" >&2
        return 1
    fi

    # Basic JSON validation - check for opening brace
    if ! echo "$RESPONSE" | grep -q '^{'; then
        echo "ERROR: Invalid JSON response" >&2
        return 1
    fi

    echo "$RESPONSE"
    return 0
}

# Main execution
main() {
    # Fetch from API
    RESPONSE=$(fetch_servers)
    if [ $? -ne 0 ]; then
        echo "$RESPONSE" >&2
        exit 1
    fi

    # Save to temporary cache file
    echo "$RESPONSE" > "$CACHE_FILE"
    if [ $? -ne 0 ]; then
        echo "ERROR: Failed to write cache file" >&2
        exit 1
    fi

    echo "Server list saved to $CACHE_FILE" >&2

    # Update UCI cache if enabled
    CACHE_ENABLED=$(uci -q get ${UCI_CONFIG}.config.cache_enabled)
    if [ "$CACHE_ENABLED" = "1" ]; then
        echo "Updating UCI cache..." >&2

        # Store compressed JSON in UCI (single line, no extra whitespace)
        COMPRESSED=$(echo "$RESPONSE" | tr -d '\n' | tr -s ' ')

        # Set UCI values
        uci -q set ${UCI_CONFIG}.servers.data="$COMPRESSED" 2>/dev/null
        uci -q set ${UCI_CONFIG}.servers.timestamp="$(date +%s)" 2>/dev/null
        uci -q set ${UCI_CONFIG}.config.last_fetch="$(date +%s)" 2>/dev/null
        uci commit ${UCI_CONFIG} 2>/dev/null

        if [ $? -eq 0 ]; then
            echo "UCI cache updated successfully" >&2
        else
            echo "WARNING: Failed to update UCI cache (continuing anyway)" >&2
        fi
    else
        echo "UCI caching disabled" >&2
    fi

    echo "OK: Server list fetched and cached successfully" >&2
    exit 0
}

main
