include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-mullvad
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

PKG_LICENSE:=MIT
PKG_MAINTAINER:=Nikos Linakis <nlinakis@gmail.com>

LUCI_TITLE:=Mullvad WireGuard Server Manager
LUCI_DESCRIPTION:=LuCI web interface for managing Mullvad WireGuard VPN servers
LUCI_DEPENDS:=+luci-base +luci-proto-wireguard +wireguard-tools +curl +jsonfilter
LUCI_PKGARCH:=all

include ../../luci.mk

# call BuildPackage - OpenWrt buildroot signature
