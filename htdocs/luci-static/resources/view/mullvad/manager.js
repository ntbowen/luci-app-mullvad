'use strict';
'require view';
'require form';
'require fs';
'require ui';
'require uci';

return view.extend({
	statusPollTimer: null,
	currentServerData: null,

	load: function() {
		var self = this;
		return Promise.all([
			uci.load('mullvad'),
			uci.load('network'),
			this.getStatus()
		]).then(function(results) {
			return self.getServerList().then(function(servers) {
				return [results[0], results[1], results[2], servers];
			});
		});
	},

	getStatus: function() {
		return fs.exec('/usr/bin/mullvad-get-status.sh', [])
			.then(function(res) {
				try {
					return JSON.parse(res.stdout || '{}');
				} catch(e) {
					return {
						connected: false,
						error: 'Failed to parse status'
					};
				}
			})
			.catch(function(err) {
				return {
					connected: false,
					error: 'Failed to get status: ' + err.message
				};
			});
	},

	getServerList: function() {
		var self = this;
		var cacheEnabled = uci.get('mullvad', 'config', 'cache_enabled');
		var lastFetch = parseInt(uci.get('mullvad', 'config', 'last_fetch') || '0');
		var cacheTTL = parseInt(uci.get('mullvad', 'config', 'cache_ttl') || '86400');
		var now = Math.floor(Date.now() / 1000);

		// Check if cache is valid
		if (cacheEnabled === '1' && lastFetch > 0 && (now - lastFetch) < cacheTTL) {
			// Try to use cached data
			var cached = uci.get('mullvad', 'servers', 'data');
			if (cached && cached !== '') {
				try {
					return Promise.resolve(JSON.parse(cached));
				} catch(e) {
					// Cache is corrupted, fetch fresh
					return self.fetchServers();
				}
			}
		}

		// Check if temp cache exists
		return fs.stat('/tmp/mullvad_servers.json').then(function(stat) {
			// Temp cache exists, check if it's recent
			var fileAge = now - stat.mtime;
			if (fileAge < cacheTTL) {
				return fs.read('/tmp/mullvad_servers.json').then(function(data) {
					return JSON.parse(data);
				});
			}
			// Temp cache too old, fetch fresh
			return self.fetchServers();
		}).catch(function() {
			// No temp cache, fetch fresh
			return self.fetchServers();
		});
	},

	fetchServers: function() {
		ui.showModal(_('Fetching Server List'), [
			E('p', { 'class': 'spinning' }, _('Downloading latest Mullvad server list...'))
		]);

		return fs.exec('/usr/bin/mullvad-fetch-servers.sh', []).then(function(res) {
			if (res.code !== 0) {
				throw new Error('Script failed with code ' + res.code);
			}
			return fs.read('/tmp/mullvad_servers.json');
		}).then(function(data) {
			ui.hideModal();
			return JSON.parse(data);
		}).catch(function(err) {
			ui.hideModal();
			ui.addNotification(null, E('p', _('Failed to fetch server list: ') + err.message), 'error');
			return { wireguard: {}, locations: {} };
		});
	},

	parseWireGuardServers: function(apiData) {
		var servers = [];
		var wgServers = apiData.wireguard || {};
		var wgRelays = wgServers.relays || [];
		var locations = apiData.locations || {};

		// Parse the relay list
		wgRelays.forEach(function(relay) {
			if (relay.active && relay.include_in_country) {
				var location = locations[relay.location] || {};
				// Extract country code from location (e.g., "gr-ath" → "GR")
				var countryCode = relay.location ? relay.location.split('-')[0].toUpperCase() : 'XX';

				servers.push({
					hostname: relay.hostname,
					country: location.country || 'Unknown',
					country_code: countryCode,
					city: location.city || 'Unknown',
					city_code: relay.location || '',
					public_key: relay.public_key,
					ipv4: relay.ipv4_addr_in,
					ipv6: relay.ipv6_addr_in || '',
					port: '51820',  // Default WireGuard port
					owned: relay.owned || false,
					provider: relay.provider || 'Unknown',
					weight: relay.weight || 100
				});
			}
		});

		// Sort by country, then city, then hostname
		servers.sort(function(a, b) {
			if (a.country !== b.country) return a.country.localeCompare(b.country);
			if (a.city !== b.city) return a.city.localeCompare(b.city);
			return a.hostname.localeCompare(b.hostname);
		});

		return servers;
	},

	render: function(loadData) {
		var m, s, o;
		var status = loadData[2];
		var serverData = loadData[3];
		var servers = this.parseWireGuardServers(serverData);
		var self = this;

		// Store server data for later use
		this.currentServerData = servers;

		m = new form.JSONMap({
			'__server__': {
				'country': '',
				'city': '',
				'server': ''
			},
			'__settings__': {
				'cache_enabled': uci.get('mullvad', 'config', 'cache_enabled') || '1',
				'cache_ttl': uci.get('mullvad', 'config', 'cache_ttl') || '86400'
			}
		}, _('Mullvad WireGuard Manager'),
			_('Manage your Mullvad WireGuard VPN server connection. Select a server, configure caching, and monitor connection status.'));

		// Connection Status Section
		s = m.section(form.NamedSection, '__status__', 'status');
		s.tab('status', _('Connection Status'));
		s.render = L.bind(function(section_id) {
			return E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-section-node' }, [
					this.renderStatus(status)
				])
			]);
		}, this);

		// Server Selection Section
		s = m.section(form.NamedSection, '__server__', '__server__', _('Server Selection'));
		s.anonymous = true;
		s.addremove = false;

		// Get current server from UCI
		var currentHostname = 'None';
		var currentPeerSection = null;
		var networkSections = uci.sections('network');
		for (var i = 0; i < networkSections.length; i++) {
			var section = networkSections[i];
			if (section['.type'] === 'wireguard_MullvadWG' ||
			    (section['.type'].indexOf('wireguard_') === 0)) {
				currentPeerSection = section;
				currentHostname = section.description || 'Unknown';
				break;
			}
		}

		// Add current server display
		o = s.option(form.DummyValue, '_current', _('Current Server'));
		o.default = currentHostname;
		o.readonly = true;

		// Single flat server selection dropdown
		o = s.option(form.ListValue, 'server', _('Select New Server'),
			_('Choose a Mullvad WireGuard server. Format: Country - City - Hostname (Provider)'));
		o.value('', _('-- Select Server --'));

		// Add all servers in a flat list, sorted by country/city/hostname
		servers.forEach(function(server) {
			var label = server.country + ' - ' + server.city + ' - ' + server.hostname;
			if (server.owned) {
				label += ' (Mullvad Owned)';
			} else {
				label += ' (' + server.provider + ')';
			}

			var value = JSON.stringify({
				hostname: server.hostname,
				public_key: server.public_key,
				ipv4: server.ipv4,
				port: server.port
			});

			o.value(value, label);
		});
		o.rmempty = false;

		// Settings Section
		s = m.section(form.NamedSection, '__settings__', '__settings__', _('Settings'));
		s.anonymous = true;
		s.addremove = false;

		o = s.option(form.Flag, 'cache_enabled', _('Enable Server List Caching'),
			_('Cache the server list locally to reduce API calls and improve loading speed'));
		o.rmempty = false;

		o = s.option(form.Value, 'cache_ttl', _('Cache Time-to-Live'),
			_('How long (in seconds) to keep cached server data before refreshing. Default: 86400 (24 hours)'));
		o.datatype = 'uinteger';
		o.placeholder = '86400';
		o.depends('cache_enabled', '1');

		// Override default save behavior
		m.save = function() {
			// Save settings to UCI
			var cacheEnabled = document.querySelector('input[name="cbid.__settings__.__settings__.cache_enabled"]');
			var cacheTTL = document.querySelector('input[name="cbid.__settings__.__settings__.cache_ttl"]');

			if (cacheEnabled) {
				uci.set('mullvad', 'config', 'cache_enabled', cacheEnabled.checked ? '1' : '0');
			}
			if (cacheTTL && cacheTTL.value) {
				uci.set('mullvad', 'config', 'cache_ttl', cacheTTL.value);
			}

			return uci.save().then(function() {
				ui.addNotification(null, E('p', _('Settings saved successfully')), 'info');
			}).catch(function(err) {
				ui.addNotification(null, E('p', _('Failed to save settings: ') + err.message), 'error');
			});
		};

		return m.render().then(function(rendered) {
			// Add custom buttons
			var buttonBar = E('div', { 'class': 'cbi-page-actions' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'click': L.bind(self.handleRefreshServers, self)
				}, _('Refresh Server List')),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-apply',
					'click': L.bind(self.handleSaveAndApply, self, servers, m)
				}, _('Save & Apply'))
			]);

			rendered.appendChild(buttonBar);

			// Start status polling
			self.startStatusPolling();

			return rendered;
		});
	},

	renderStatus: function(status) {
		var connectedClass = status.connected ? 'success' : 'danger';
		var connectedText = status.connected ? _('Connected') : _('Disconnected');

		return E('div', { 'class': 'table-wrapper' }, [
			E('h3', {}, _('Current Status')),
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left', 'style': 'width: 30%; font-weight: bold' }, _('Connection')),
					E('td', { 'class': 'td left' }, [
						E('span', {
							'class': 'badge label-' + connectedClass,
							'style': 'padding: 3px 8px; border-radius: 3px'
						}, connectedText)
					])
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left', 'style': 'font-weight: bold' }, _('Current Server')),
					E('td', { 'class': 'td left' }, status.current_server || _('Not configured'))
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left', 'style': 'font-weight: bold' }, _('Endpoint')),
					E('td', { 'class': 'td left' }, status.endpoint || _('N/A'))
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left', 'style': 'font-weight: bold' }, _('Latest Handshake')),
					E('td', { 'class': 'td left' }, status.latest_handshake || _('Never'))
				]),
				E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left', 'style': 'font-weight: bold' }, _('Transfer (RX / TX)')),
					E('td', { 'class': 'td left' }, (status.transfer_rx || '0 B') + ' / ' + (status.transfer_tx || '0 B'))
				])
			])
		]);
	},

	handleRefreshServers: function(ev) {
		var self = this;
		ev.target.classList.add('spinning');
		ev.target.disabled = true;

		return this.fetchServers().then(function() {
			ui.addNotification(null, E('p', _('Server list refreshed successfully. Reloading page...')), 'info');
			setTimeout(function() {
				window.location.reload();
			}, 1500);
		}).catch(function(err) {
			ev.target.classList.remove('spinning');
			ev.target.disabled = false;
			ui.addNotification(null, E('p', _('Failed to refresh: ') + err.message), 'error');
		});
	},

	handleSaveAndApply: function(servers, m, ev) {
		var self = this;
		ev.target.classList.add('spinning');
		ev.target.disabled = true;

		// First, save settings
		var cacheEnabled = document.querySelector('input[name="cbid.__settings__.__settings__.cache_enabled"]');
		var cacheTTL = document.querySelector('input[name="cbid.__settings__.__settings__.cache_ttl"]');

		if (cacheEnabled) {
			uci.set('mullvad', 'config', 'cache_enabled', cacheEnabled.checked ? '1' : '0');
		}
		if (cacheTTL && cacheTTL.value) {
			uci.set('mullvad', 'config', 'cache_ttl', cacheTTL.value);
		}

		return uci.save().then(function() {
			// Check if a server is selected
			var serverSelect = document.getElementById('widget.cbid.json.__server__.server');

			if (serverSelect && serverSelect.value && serverSelect.value !== '') {
				// Server selected, apply it
				var serverInfo;
				try {
					serverInfo = JSON.parse(serverSelect.value);
				} catch(e) {
					ui.addNotification(null, E('p', _('Invalid server selection')), 'error');
					ev.target.classList.remove('spinning');
					ev.target.disabled = false;
					return Promise.resolve();
				}

				// Show confirmation dialog
				return self.confirmAndApplyServer(serverInfo, ev.target);
			} else {
				// No server selected, just save settings
				ev.target.classList.remove('spinning');
				ev.target.disabled = false;
				ui.addNotification(null, E('p', _('Settings saved successfully')), 'info');
				return Promise.resolve();
			}
		}).catch(function(err) {
			ev.target.classList.remove('spinning');
			ev.target.disabled = false;
			ui.addNotification(null, E('p', _('Failed to save: ') + err.message), 'error');
		});
	},

	confirmAndApplyServer: function(serverInfo, button) {
		var self = this;

		// Confirm with user
		return ui.showModal(_('Confirm Server Change'), [
			E('p', {}, _('Are you sure you want to switch to the following server?')),
			E('ul', {}, [
				E('li', {}, [E('strong', {}, _('Hostname: ')), serverInfo.hostname]),
				E('li', {}, [E('strong', {}, _('IP Address: ')), serverInfo.ipv4]),
				E('li', {}, [E('strong', {}, _('Port: ')), serverInfo.port])
			]),
			E('p', {}, E('em', {}, _('Note: Your VPN connection will be interrupted briefly during the switch.'))),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn',
					'click': function() {
						ui.hideModal();
						button.classList.remove('spinning');
						button.disabled = false;
					}
				}, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button-action',
					'click': L.bind(function() {
						ui.hideModal();
						this.applyServerChange(serverInfo, button);
					}, self)
				}, _('Apply'))
			])
		]);
	},

	handleApplyServer: function(servers, ev) {
		ev.target.classList.add('spinning');
		ev.target.disabled = true;

		// Find the server dropdown using the correct ID
		var serverSelect = document.getElementById('widget.cbid.json.__server__.server');

		if (!serverSelect || !serverSelect.value || serverSelect.value === '') {
			ui.addNotification(null, E('p', _('Please select a server first')), 'warning');
			ev.target.classList.remove('spinning');
			ev.target.disabled = false;
			return Promise.resolve();
		}

		var serverInfo;
		try {
			serverInfo = JSON.parse(serverSelect.value);
		} catch(e) {
			ui.addNotification(null, E('p', _('Invalid server selection')), 'error');
			ev.target.classList.remove('spinning');
			ev.target.disabled = false;
			return Promise.resolve();
		}

		// Confirm with user
		return ui.showModal(_('Confirm Server Change'), [
			E('p', {}, _('Are you sure you want to switch to the following server?')),
			E('ul', {}, [
				E('li', {}, [E('strong', {}, _('Hostname: ')), serverInfo.hostname]),
				E('li', {}, [E('strong', {}, _('IP Address: ')), serverInfo.ipv4]),
				E('li', {}, [E('strong', {}, _('Port: ')), serverInfo.port])
			]),
			E('p', {}, E('em', {}, _('Note: Your VPN connection will be interrupted briefly during the switch.'))),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn',
					'click': function() {
						ui.hideModal();
						ev.target.classList.remove('spinning');
						ev.target.disabled = false;
					}
				}, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button-action',
					'click': L.bind(function() {
						ui.hideModal();
						this.applyServerChange(serverInfo, ev.target);
					}, this)
				}, _('Apply'))
			])
		]);
	},

	applyServerChange: function(serverInfo, button) {
		var self = this;

		ui.showModal(_('Applying Configuration'), [
			E('p', { 'class': 'spinning' }, _('Updating WireGuard configuration...'))
		]);

		return fs.exec('/usr/bin/mullvad-apply-server.sh', [
			serverInfo.hostname,
			serverInfo.public_key,
			serverInfo.ipv4,
			serverInfo.port
		]).then(function(res) {
			if (res.code !== 0) {
				throw new Error('Script failed: ' + (res.stderr || 'Unknown error'));
			}
			ui.hideModal();
			ui.addNotification(null, E('p', _('Configuration updated. Reloading interface...')), 'info');

			// Get WireGuard interface name from config
			var wgInterface = uci.get('mullvad', 'config', 'wireguard_interface') || 'MullvadWG';

			// Reload WireGuard interface using ifdown/ifup
			return fs.exec('/sbin/ifdown', [wgInterface]).then(function() {
				return fs.exec('/sbin/ifup', [wgInterface]);
			});
		}).then(function() {
			button.classList.remove('spinning');
			button.disabled = false;
			ui.addNotification(null, E('p', _('Server changed successfully. Verifying connection...')), 'info');

			// Wait a bit for the connection to establish
			setTimeout(function() {
				self.refreshStatus();
			}, 5000);
		}).catch(function(err) {
			ui.hideModal();
			button.classList.remove('spinning');
			button.disabled = false;
			ui.addNotification(null, E('p', _('Failed to apply server change: ') + err.message), 'error');
		});
	},

	refreshStatus: function() {
		var self = this;
		return this.getStatus().then(function(status) {
			var statusDiv = document.querySelector('.cbi-section-node');
			if (statusDiv) {
				statusDiv.innerHTML = '';
				statusDiv.appendChild(self.renderStatus(status));
			}
		});
	},

	startStatusPolling: function() {
		var self = this;
		// Update status every 30 seconds
		this.statusPollTimer = setInterval(function() {
			self.refreshStatus();
		}, 30000);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
