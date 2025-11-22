// Proxy Configuration Module
// Manages proxy rotation for handling rate limiting
// Reads proxies from database/proxies.json for easy management

const fs = require('fs');
const path = require('path');

const proxyDbPath = path.join(__dirname, '..', 'database', 'proxies.json');

// Load proxies from database
function loadProxies() {
  try {
    if (fs.existsSync(proxyDbPath)) {
      const data = fs.readFileSync(proxyDbPath, 'utf8');
      const config = JSON.parse(data);
      return config.proxies || [];
    }
  } catch (error) {
    console.error('Error loading proxies from database:', error.message);
  }
  return [];
}

// Save proxies to database
function saveProxies(proxyList) {
  try {
    const dir = path.dirname(proxyDbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(proxyDbPath, JSON.stringify({ proxies: proxyList }, null, 2), 'utf8');
    console.log(`Proxies saved: ${proxyList.length} proxies`);
  } catch (error) {
    console.error('Error saving proxies to database:', error.message);
  }
}

let proxyList = loadProxies();
let currentProxyIndex = 0;

/**
 * Get the next proxy from the list
 * @returns {string|null} Proxy address or null if no proxies configured
 */
function getNextProxy() {
  if (proxyList.length === 0) return null;
  const proxy = proxyList[currentProxyIndex];
  currentProxyIndex = (currentProxyIndex + 1) % proxyList.length;
  return proxy;
}

/**
 * Get all available proxies
 * @returns {array} List of all proxy addresses
 */
function getAllProxies() {
  return [...proxyList]; // Return a copy
}

/**
 * Add a new proxy to the list
 * @param {string} proxy - Proxy address (e.g., http://ip:port)
 * @returns {boolean} Success status
 */
function addProxy(proxy) {
  if (proxy && !proxyList.includes(proxy)) {
    proxyList.push(proxy);
    saveProxies(proxyList);
    console.log(`Proxy added: ${proxy}`);
    return true;
  }
  return false;
}

/**
 * Remove a proxy from the list
 * @param {string} proxy - Proxy address to remove
 * @returns {boolean} Success status
 */
function removeProxy(proxy) {
  const index = proxyList.indexOf(proxy);
  if (index !== -1) {
    proxyList.splice(index, 1);
    saveProxies(proxyList);
    console.log(`Proxy removed: ${proxy}`);
    return true;
  }
  return false;
}

/**
 * Replace all proxies with a new list
 * @param {array} newProxyList - New list of proxies
 */
function replaceProxies(newProxyList) {
  proxyList = newProxyList;
  currentProxyIndex = 0;
  saveProxies(proxyList);
  console.log(`Proxies updated: ${newProxyList.length} proxies`);
}

/**
 * Get current proxy count
 * @returns {number} Number of available proxies
 */
function getProxyCount() {
  return proxyList.length;
}

/**
 * Reset proxy rotation index
 */
function resetProxyIndex() {
  currentProxyIndex = 0;
}

module.exports = {
  getNextProxy,
  getAllProxies,
  getProxyCount,
  resetProxyIndex,
  addProxy,
  removeProxy,
  replaceProxies,
  loadProxies,
  saveProxies
};
