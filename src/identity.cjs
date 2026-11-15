'use strict';
const fs = require('node:fs');
const path = require('node:path');
function dataDirectory(appData, demo = false) {
  const current = path.join(appData, demo ? 'FoxFerryDemo' : 'FoxFerry');
  // Read existing installations without moving or overwriting user data.
  const legacy = path.join(appData, demo ? 'ClashRoutingAssistantDemo' : 'ClashRoutingAssistant');
  return fs.existsSync(path.join(current, 'state.json')) || !fs.existsSync(path.join(legacy, 'state.json')) ? current : legacy;
}
function ownerOf(config) { return (config['x-foxferry'] ?? config['x-clash-assistant'])?.owner; }
function hasOwnership(config) { return !!(config['x-foxferry'] || config['x-clash-assistant']); }
module.exports = { dataDirectory, ownerOf, hasOwnership };
