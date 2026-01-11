# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a LuCI web application for OpenWrt that provides a user-friendly interface to manage Mullvad WireGuard VPN server selection and monitor connection status. The package is architecture-independent and designed to run on any OpenWrt router.

## Architecture

### Component Structure

The application follows the standard OpenWrt/LuCI package structure:

1. **Frontend (JavaScript)**: `htdocs/luci-static/resources/view/mullvad/manager.js`
   - Single-page LuCI view using the LuCI JavaScript framework
   - Manages UI state, server selection, and status polling
   - Communicates with backend via shell script execution through `fs.exec()`
   - Uses UCI for configuration management via LuCI's `uci` module

2. **Backend (Shell Scripts)**: `root/usr/bin/mullvad-*.sh`
   - `mullvad-fetch-servers.sh`: Fetches server list from Mullvad API and manages caching
   - `mullvad-apply-server.sh`: Updates UCI network configuration with new server details
   - `mullvad-get-status.sh`: Retrieves WireGuard connection status from `wg show`

3. **Configuration**:
   - UCI config: `/etc/config/mullvad` - App settings (cache, interface name)
   - Network config: `/etc/config/network` - WireGuard peer configuration (modified by apply script)

4. **LuCI Integration**:
   - Menu definition: `root/usr/share/luci/menu.d/luci-app-mullvad.json`
   - ACL permissions: `root/usr/share/rpcd/acl.d/luci-app-mullvad.json`

### Key Design Patterns

**Auto-detection Pattern**: The app automatically detects the WireGuard interface name on first run by:
1. Searching for interfaces with `proto=wireguard` in `/etc/config/network`
2. Validating the interface has an associated peer section (`wireguard_<InterfaceName>`)
3. Saving the detected name to `/etc/config/mullvad` for future use
4. Falling back to `MullvadWG` if detection fails

This logic is implemented in `mullvad-apply-server.sh` (`auto_detect_interface()` function).

**Two-tier Caching**: Server list is cached at two levels:
1. Temporary file cache: `/tmp/mullvad_servers.json` (checked first, TTL-based)
2. UCI cache: `mullvad.servers.data` (persists across reboots, optional)

**Safe Configuration Changes**: The app stages UCI changes without immediately reloading the network. LuCI's save/apply mechanism handles the actual network reload, preventing partial configuration states.

**Status Polling**: Frontend polls status every 30 seconds using `getStatus()` → `mullvad-get-status.sh` → `wg show`.

## Building and Testing

### Building IPK Package

**IMPORTANT**: The OpenWrt SDK can only be built on Linux. The SDK contains Linux-specific binaries and requires GNU tools. Building on macOS or Windows will fail with "cannot execute binary file" errors.

The GitHub Actions workflow (`.github/workflows/build-ipk.yml`) builds the package on Ubuntu:

```bash
# The workflow downloads OpenWrt SDK and builds automatically on tag push
# To manually trigger: use workflow_dispatch from GitHub Actions UI
```

**Package Structure Requirements**:
- The Makefile includes `../../luci.mk`, which means the package MUST be placed in:
  ```
  feeds/luci/applications/luci-app-mullvad/
  ```
- NOT in `package/luci-app-mullvad/` - this will cause build failures
- The build process:
  1. Copy package files to `feeds/luci/applications/luci-app-mullvad/`
  2. Run `./scripts/feeds update -a` to index the package
  3. Run `./scripts/feeds install luci-app-mullvad` to register it
  4. Run `make defconfig` to generate default configuration
  5. Build with `make package/luci-app-mullvad/compile`

The SDK URL and filename are hardcoded in the workflow. If updating OpenWrt version:
- Change `SDK_URL` environment variable
- Update the exact filename in `tar -xf` and `mv` commands (no wildcards)

### Manual Installation (Development)

```bash
# Copy files to router
scp -r luci-app-mullvad root@<router-ip>:/root/

# SSH into router and install
cd /root/luci-app-mullvad
cp -r root/* /
cp -r htdocs/* /www/
chmod +x /usr/bin/mullvad-*.sh
chmod 644 /usr/share/rpcd/acl.d/luci-app-mullvad.json
chmod 644 /usr/share/luci/menu.d/luci-app-mullvad.json
chmod 644 /etc/config/mullvad
chmod 644 /www/luci-static/resources/view/mullvad/manager.js
chmod 755 /www/luci-static/resources/view/mullvad

# Initialize and restart services
uci commit mullvad
/etc/init.d/rpcd restart
/etc/init.d/uhttpd restart
```

### Testing Backend Scripts

```bash
# Test server fetch
/usr/bin/mullvad-fetch-servers.sh
cat /tmp/mullvad_servers.json | head

# Test status retrieval
/usr/bin/mullvad-get-status.sh

# Test server application (requires valid server data)
/usr/bin/mullvad-apply-server.sh <hostname> <pubkey> <ip> <port>

# Verify UCI changes
uci show network | grep wireguard
uci show mullvad
```

## Dependencies

**Required packages** (specified in `Makefile`):
- `luci-base` - LuCI core framework
- `luci-proto-wireguard` - WireGuard protocol support in LuCI
- `wireguard-tools` - WireGuard CLI tools (`wg` command)
- `curl` - HTTP client for API calls
- `jsonfilter` - JSON parsing in shell scripts

## Key Files and Their Purposes

- `Makefile`: OpenWrt package build definition (follows OpenWrt buildroot conventions)
- `root/etc/config/mullvad`: UCI configuration template with default values
- `htdocs/luci-static/resources/view/mullvad/manager.js`: Main UI view (LuCI JS framework)
- `root/usr/bin/mullvad-fetch-servers.sh`: API client for Mullvad relay list
- `root/usr/bin/mullvad-apply-server.sh`: UCI network configuration updater
- `root/usr/bin/mullvad-get-status.sh`: WireGuard status parser
- `.github/workflows/build-ipk.yml`: CI/CD for building IPK packages

## API Integration

**Mullvad Relay API**: `https://api.mullvad.net/app/v1/relays`
- Returns JSON with all Mullvad relay servers
- Structure: `{ wireguard: { relays: [...] }, locations: {...} }`
- Filters: Only servers with `active: true` and `include_in_country: true` are shown
- Server properties used: `hostname`, `public_key`, `ipv4_addr_in`, `location`, `owned`, `provider`

## UCI Configuration Schema

```
config settings 'config'
    option cache_enabled '1'                   # Enable/disable local caching
    option cache_ttl '86400'                   # Cache TTL in seconds (default: 24h)
    option wireguard_interface 'MullvadWG'     # WireGuard interface name (auto-detected)
    option last_fetch '0'                      # Timestamp of last API fetch

config cache 'servers'
    option data ''                             # Cached server list (compressed JSON)
    option timestamp '0'                       # Cache timestamp
```

## Network Configuration Updates

When switching servers, the app modifies the WireGuard peer section in `/etc/config/network`:

```
config wireguard_<InterfaceName>
    option description 'Mullvad VPN Server: <hostname>'
    option public_key '<server_public_key>'
    option endpoint_host '<server_ip>'
    option endpoint_port '51820'
```

The peer section name pattern is `wireguard_<InterfaceName>` where `<InterfaceName>` is the UCI network interface name.

## Common Pitfalls

1. **Cannot Build on macOS/Windows**: The OpenWrt SDK only works on Linux. Attempting to build on macOS will fail with "cannot execute binary file" and "ld-linux-x86-64.so.2" errors. Always use Linux (or GitHub Actions with ubuntu-latest) for builds.

2. **Package Location**: LuCI packages MUST be in `feeds/luci/applications/<package-name>/`, NOT in `package/<package-name>/`. The Makefile's `include ../../luci.mk` expects the feeds directory structure. Placing the package in the wrong location will cause "luci.mk not found" build failures.

3. **Feeds Installation**: Do NOT run `./scripts/feeds install -a` (install all packages). OpenWrt 23.05.2 feeds contain packages with broken dependencies (e.g., `python3-pymysql` has a recursive dependency). Only install the specific packages needed: `luci-base luci-proto-wireguard wireguard-tools curl jsonfilter`. The build will fail with "recursive dependency detected!" if you install all packages.

4. **Missing .config File**: The SDK requires a `.config` file before building. Always run `make defconfig` before compiling packages. Without this, the build will try to run `menuconfig` and fail with "Error opening terminal: unknown." in CI environments.

5. **GitHub Actions SDK URL**: The workflow uses explicit filenames for tar extraction and mv commands. Wildcards fail in the CI environment. If changing OpenWrt versions, update all three instances of the SDK filename.

6. **Interface Name Assumptions**: Never hardcode `MullvadWG` - always use the configured/detected interface name from `mullvad.config.wireguard_interface`.

7. **UCI Caching Limits**: UCI has size limits for option values. The JSON is compressed (whitespace removed) before storing in UCI cache.

8. **Shell Script Permissions**: All shell scripts must be executable (`chmod +x`). ACL and menu JSON files must NOT be executable (644).

9. **Service Restart Order**: Always restart `rpcd` before `uhttpd` when updating ACL or menu files.

## Commit Message Guidelines

Do not include "Co-Authored-By: Claude" trailers or Claude Code footer links in commit messages.
