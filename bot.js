require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const proxies = require('./lib/proxies');

const bot = new Telegraf(process.env.BOT_TOKEN);
const API_KEY = process.env.API_KEY;
const API_BASE_URL = 'https://chat-tempmail.com/api';
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '0');

// Database file path
const dbPath = path.join(__dirname, 'database', 'users.json');
const langPath = path.join(__dirname, 'database', 'languages.json');

// Load language file
function loadLanguages() {
  try {
    const data = fs.readFileSync(langPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading languages:', error.message);
    return { en: {}, id: {} };
  }
}

const languages = loadLanguages();

// Get translation with fallback
function t(userId, key, params = {}) {
  try {
    const db = loadDatabase();
    const userLang = db.users?.[userId]?.language || 'en';
    let text = languages[userLang]?.[key] || languages['en']?.[key] || key;
    
    // Replace parameters
    Object.keys(params).forEach(param => {
      text = text.replace(`{${param}}`, params[param]);
    });
    
    return text;
  } catch (error) {
    return key;
  }
}

// Load database
function loadDatabase() {
  try {
    if (fs.existsSync(dbPath)) {
      const data = fs.readFileSync(dbPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading database:', error.message);
  }
  return { users: {} };
}

// Save database
function saveDatabase(data) {
  try {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Error saving database:', error.message);
  }
}

// Get user language
function getUserLanguage(userId) {
  const db = loadDatabase();
  return db.users[userId]?.language || 'en';
}

// Set user language
function setUserLanguage(userId, language) {
  const db = loadDatabase();
  if (!db.users[userId]) {
    db.users[userId] = {};
  }
  db.users[userId].language = language;
  saveDatabase(db);
}

// Get user emails from database
function getUserEmails(userId) {
  const db = loadDatabase();
  if (!db.users[userId]) {
    db.users[userId] = {};
    saveDatabase(db);
  }
  return db.users[userId];
}

// Add email to user
function addEmailToUser(userId, emailId) {
  const db = loadDatabase();
  if (!db.users[userId]) {
    db.users[userId] = {};
  }
  db.users[userId][emailId] = true;
  saveDatabase(db);
}

// Check if user is admin
function isAdmin(userId) {
  return ADMIN_ID && userId === ADMIN_ID;
}

// Get all users from database
function getAllUsers() {
  const db = loadDatabase();
  return Object.keys(db.users || {}).map(userId => ({
    userId,
    emails: Object.keys(db.users[userId]).filter(key => key !== 'language'),
    language: db.users[userId].language || 'en'
  }));
}

// Remove email from user
function removeEmailFromUser(userId, emailId) {
  const db = loadDatabase();
  if (db.users[userId]) {
    delete db.users[userId][emailId];
    saveDatabase(db);
  }
}

// Store user sessions
const userSessions = {};
const emailCache = {}; // Cache emails with short IDs
const messageCache = {}; // Cache messages with short IDs
const rateLimitDelay = 5000; // 5 second global rate limit delay
let lastRequestTime = 0;

function getNextProxy() {
  return proxies.getNextProxy();
}

// ==================== API Calls ====================

// Retry logic for rate limiting with proxy rotation
async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000) {
  const totalProxies = proxies.getProxyCount();
  // If we have more proxies than retries, use that for maxRetries
  const actualMaxRetries = totalProxies > 0 ? Math.max(maxRetries, totalProxies) : maxRetries;
  
  for (let i = 0; i < actualMaxRetries; i++) {
    try {
      // Wait if we hit rate limit before
      const timeSinceLastRequest = Date.now() - lastRequestTime;
      if (timeSinceLastRequest < rateLimitDelay) {
        const waitTime = rateLimitDelay - timeSinceLastRequest;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      
      lastRequestTime = Date.now();
      return await fn();
    } catch (error) {
      // Check if it's a rate limit error (429)
      if (error.response?.status === 429 && i < actualMaxRetries - 1) {
        const delay = initialDelay * Math.pow(2, Math.floor(i / totalProxies)); // Exponential backoff per proxy cycle
        const nextProxy = getNextProxy();
        const proxyMsg = nextProxy ? ` using proxy ${nextProxy}` : '';
        const attemptNum = i + 1;
        console.warn(`Rate limited. Retrying in ${delay}ms (attempt ${attemptNum}/${actualMaxRetries})${proxyMsg}`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}

async function getDomains() {
  return retryWithBackoff(async () => {
    const config = {
      headers: { 'X-API-Key': API_KEY }
    };
    const proxy = getNextProxy();
    if (proxy) {
      config.httpAgent = new (require('http').Agent)({ httpAgent: proxy });
      config.httpsAgent = new (require('https').Agent)({ httpAgent: proxy });
    }
    const response = await axios.get(`${API_BASE_URL}/email/domains`, config);
    return response.data.domains;
  });
}

async function generateEmail(name, expiryTime, domain) {
  return retryWithBackoff(async () => {
    const config = {
      headers: {
        'X-API-Key': API_KEY,
        'Content-Type': 'application/json'
      }
    };
    const proxy = getNextProxy();
    if (proxy) {
      config.httpAgent = new (require('http').Agent)({ httpAgent: proxy });
      config.httpsAgent = new (require('https').Agent)({ httpAgent: proxy });
    }
    const response = await axios.post(`${API_BASE_URL}/emails/generate`, {
      name,
      expiryTime,
      domain
    }, config);
    return response.data;
  });
}

async function listUserEmails(userId) {
  return retryWithBackoff(async () => {
    const config = {
      headers: { 'X-API-Key': API_KEY }
    };
    const response = await axios.get(`${API_BASE_URL}/emails`, config);
    
    // Get user emails from database
    const userEmailIds = getUserEmails(userId);
    
    const userEmailList = response.data.emails.filter(email => {
      return userEmailIds[email.id] === true;
    });
    
    return {
      emails: userEmailList,
      nextCursor: response.data.nextCursor,
      total: userEmailList.length
    };
  });
}

async function listEmails(cursor = null) {
  try {
    const config = {
      headers: { 'X-API-Key': API_KEY }
    };
    const url = cursor 
      ? `${API_BASE_URL}/emails?cursor=${cursor}`
      : `${API_BASE_URL}/emails`;
    
    const response = await axios.get(url, config);
    return response.data;
  } catch (error) {
    console.error('Error listing emails:', error.message);
    throw new Error('Failed to list emails');
  }
}

async function getMessages(emailId, cursor = null) {
  return retryWithBackoff(async () => {
    const config = {
      headers: { 'X-API-Key': API_KEY }
    };
    const url = cursor
      ? `${API_BASE_URL}/emails/${emailId}?cursor=${cursor}`
      : `${API_BASE_URL}/emails/${emailId}`;
    
    const response = await axios.get(url, config);
    return response.data;
  });
}

async function getMessageDetail(emailId, messageId) {
  try {
    const response = await axios.get(
      `${API_BASE_URL}/emails/${emailId}/${messageId}`,
      {
        headers: { 'X-API-Key': API_KEY }
      }
    );
    return response.data.message;
  } catch (error) {
    console.error('Error getting message detail:', error.message);
    throw new Error('Failed to get message detail');
  }
}

async function deleteEmail(emailId) {
  try {
    const response = await axios.delete(
      `${API_BASE_URL}/emails/${emailId}`,
      {
        headers: { 'X-API-Key': API_KEY }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error deleting email:', error.message);
    throw new Error('Failed to delete email');
  }
}

async function deleteMessage(emailId, messageId) {
  try {
    const response = await axios.delete(
      `${API_BASE_URL}/emails/${emailId}/${messageId}`,
      {
        headers: { 'X-API-Key': API_KEY }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error deleting message:', error.message);
    throw new Error('Failed to delete message');
  }
}

// ==================== Helper Functions ====================

function formatEmailInfo(email) {
  const createdDate = new Date(email.createdAt).toLocaleString();
  const expiresDate = new Date(email.expiresAt).toLocaleString();
  return `📧 <b>${email.address}</b>\n\n` +
         `📅 Created: ${createdDate}\n` +
         `⏰ Expires: ${expiresDate}`;
}

function formatMessagePreview(message) {
  return `📨 <b>${message.from_address}</b>\n` +
         `<b>Subject:</b> ${message.subject}\n` +
         `🕐 ${new Date(message.received_at).toLocaleString()}`;
}

// ==================== Main Menu ====================

const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '✉️ Create Email', callback_data: 'create_email' }],
      [{ text: '📬 My Emails', callback_data: 'list_emails' }],
      [{ text: '⚙️ Settings', callback_data: 'settings' }]
    ]
  }
};

// ==================== Command Handlers ====================

bot.start((ctx) => {
  const userId = ctx.from.id;
  // Ensure user has a language set
  const currentLang = getUserLanguage(userId);
  if (!currentLang || currentLang === 'en') {
    // User has default language
  }
  
  ctx.replyWithHTML(
    `<b>${t(userId, 'welcome')}</b> 🎉\n\n${t(userId, 'welcome_desc')}`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: t(userId, 'create_email'), callback_data: 'create_email' }],
          [{ text: t(userId, 'my_emails'), callback_data: 'list_emails' }],
          [{ text: t(userId, 'profile'), callback_data: 'view_profile' }],
          [{ text: t(userId, 'settings'), callback_data: 'settings' }]
        ]
      }
    }
  );
  userSessions[userId] = {};
});

bot.command('help', (ctx) => {
  const userId = ctx.from.id;
  ctx.replyWithHTML(
    `<b>${t(userId, 'available_commands')}</b>\n\n` +
    `<code>${t(userId, 'cmd_start')}</code>\n` +
    `<code>${t(userId, 'cmd_create')}</code>\n` +
    `<code>${t(userId, 'cmd_list')}</code>\n` +
    `<code>${t(userId, 'cmd_help')}</code>\n` +
    `<code>${t(userId, 'cmd_cancel')}</code>`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: t(userId, 'create_email'), callback_data: 'create_email' }],
          [{ text: t(userId, 'my_emails'), callback_data: 'list_emails' }],
          [{ text: t(userId, 'settings'), callback_data: 'settings' }]
        ]
      }
    }
  );
});

// ... existing code ...

bot.command('cancel', (ctx) => {
  const userId = ctx.from.id;
  if (userSessions[userId]) {
    userSessions[userId] = {};
  }
  ctx.replyWithHTML(
    t(userId, 'action_cancelled'),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: t(userId, 'create_email'), callback_data: 'create_email' }],
          [{ text: t(userId, 'my_emails'), callback_data: 'list_emails' }],
          [{ text: t(userId, 'settings'), callback_data: 'settings' }]
        ]
      }
    }
  );
});

// ==================== Create Email Flow ====================

bot.command('create', async (ctx) => {
  const userId = ctx.from.id;
  try {
    const domains = await getDomains();
    userSessions[userId] = { step: 'domain_selection', domains };
    
    const buttons = domains.map((domain, index) => [
      { text: `${index + 1}`, callback_data: `domain_${domain}` }
    ]);
    buttons.push([{ text: t(userId, 'cancel'), callback_data: 'cancel_create' }]);
    
    ctx.replyWithHTML(
      `<b>${t(userId, 'select_domain')}</b>\n\n` +
      domains.map((d, i) => `${i + 1}. ${d}`).join('\n'),
      {
        reply_markup: { inline_keyboard: buttons }
      }
    );
  } catch (error) {
    ctx.replyWithHTML(t(userId, 'error') + error.message);
  }
});

bot.action('create_email', async (ctx) => {
  const userId = ctx.from.id;
  try {
    const domains = await getDomains();
    userSessions[userId] = { step: 'domain_selection', domains };
    
    const buttons = domains.map((domain, index) => [
      { text: `${index + 1}`, callback_data: `domain_${domain}` }
    ]);
    buttons.push([{ text: t(userId, 'cancel'), callback_data: 'cancel_create' }]);
    
    ctx.editMessageText(
      `<b>${t(userId, 'select_domain')}</b>\n\n` +
      domains.map((d, i) => `${i + 1}. ${d}`).join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons }
      }
    );
  } catch (error) {
    ctx.editMessageText(t(userId, 'error') + error.message, { parse_mode: 'HTML' });
  }
});

bot.action(/^domain_(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const domain = ctx.match[1];
  userSessions[userId].domain = domain;
  userSessions[userId].step = 'email_prefix';
  
  ctx.editMessageText(
    `<b>${t(userId, 'select_domain')}</b>\n\n` +
    `${t(userId, 'enter_prefix').replace('{domain}', domain)}`,
    { parse_mode: 'HTML' }
  );
});

bot.action('cancel_create', (ctx) => {
  const userId = ctx.from.id;
  userSessions[userId] = {};
  ctx.editMessageText(t(userId, 'action_cancelled'), { parse_mode: 'HTML' });
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions[userId];
  
  if (!session || !session.step) return;

  try {
    // Handle API key update (admin only)
    if (session.step === 'waiting_api_key' && isAdmin(userId)) {
      const newApiKey = ctx.message.text.trim();
      
      if (newApiKey.length < 20) {
        ctx.replyWithHTML(t(userId, 'api_key_short'));
        return;
      }
      
      // Update .env file
      try {
        const envPath = path.join(__dirname, '.env');
        let envContent = fs.readFileSync(envPath, 'utf8');
        envContent = envContent.replace(/API_KEY=.*/g, `API_KEY=${newApiKey}`);
        fs.writeFileSync(envPath, envContent, 'utf8');
        process.env.API_KEY = newApiKey;
        
        ctx.replyWithHTML(
          `${t(userId, 'api_key_updated')}\n\n` +
          `${t(userId, 'api_key_new')}<code>${newApiKey.substring(0, 10)}...</code>\n\n` +
          `${t(userId, 'api_key_warning')}`
        );
      } catch (error) {
        ctx.replyWithHTML(`${t(userId, 'error')}${error.message}`);
      }
      
      session.step = null;
      return;
    }
    
    // Handle proxy add (admin only)
    if (session.step === 'waiting_proxy_add' && isAdmin(userId)) {
      const newProxy = ctx.message.text.trim();
      
      if (!newProxy.startsWith('http://') && !newProxy.startsWith('https://')) {
        ctx.replyWithHTML(t(userId, 'proxy_format_error'));
        return;
      }
      
      if (proxies.addProxy(newProxy)) {
        ctx.replyWithHTML(
          `${t(userId, 'proxy_added')}\n\n` +
          `🌐 <code>${newProxy}</code>\n\n` +
          `${t(userId, 'total_proxies')}<b>${proxies.getProxyCount()}</b>`
        );
      } else {
        ctx.replyWithHTML(t(userId, 'proxy_exists_error'));
      }
      
      session.step = null;
      return;
    }
    
    // Handle email prefix (existing functionality)
    if (session.step === 'email_prefix') {
      const prefix = ctx.message.text;
      session.step = 'expiry_time';
      
      const expiryOptions = [
        [{ text: t(userId, '1_hour'), callback_data: 'expiry_3600000' }],
        [{ text: t(userId, '1_day'), callback_data: 'expiry_86400000' }],
        [{ text: t(userId, '3_days'), callback_data: 'expiry_259200000' }],
        [{ text: t(userId, 'permanent'), callback_data: 'expiry_0' }]
      ];
      
      session.prefix = prefix;
      ctx.replyWithHTML(
        `<b>${t(userId, 'select_expiry')}</b>`,
        { reply_markup: { inline_keyboard: expiryOptions } }
      );
    }
  } catch (error) {
    ctx.replyWithHTML(t(userId, 'error') + error.message);
  }
});

bot.action(/^expiry_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions[userId];
  const expiryTime = parseInt(ctx.match[1]);
  
  try {
    await ctx.editMessageText(`<b>${t(userId, 'creating')}</b>`, { parse_mode: 'HTML' });
    
    const result = await generateEmail(session.prefix, expiryTime, session.domain);
    
    // Track this email as belonging to this user in database
    addEmailToUser(userId, result.id);
    
    session.lastEmail = result;
    
    ctx.editMessageText(
      `<b>${t(userId, 'email_created')}</b>\n\n` +
      `📧 <b>${result.email}</b>\n\n` +
      `📅 ${t(userId, 'version')}: ${new Date().toLocaleString()}\n` +
      `⏰ ${t(userId, 'received')}: ${new Date(Date.now() + expiryTime).toLocaleString()}`,
      { parse_mode: 'HTML' }
    );
    
    session.step = null;
  } catch (error) {
    ctx.editMessageText(t(userId, 'error') + error.message, { parse_mode: 'HTML' });
  }
});

// ==================== List & View Emails ====================

bot.command('list', async (ctx) => {
  const userId = ctx.from.id;
  try {
    await ctx.replyWithHTML(t(userId, 'loading_emails'));
    const userId = ctx.from.id;
    const data = await listUserEmails(userId);
    
    if (!data.emails || data.emails.length === 0) {
      ctx.replyWithHTML(t(userId, 'no_emails'));
      return;
    }
    
    let message = `<b>${t(userId, 'your_emails')}</b>\n\n`;
    const buttons = [];
    
    data.emails.forEach((email, index) => {
      message += `${index + 1}. <code>${email.address}</code>\n`;
      buttons.push([
        { text: `📧 ${index + 1}`, callback_data: `view_email_${index}` }
      ]);
    });
    
    buttons.push([{ text: t(userId, 'refresh'), callback_data: 'list_emails' }]);
    buttons.push([{ text: t(userId, 'back'), callback_data: 'back_menu' }]);
    
    userSessions[userId].emails = data.emails;
    ctx.replyWithHTML(message, {
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (error) {
    ctx.replyWithHTML(t(userId, 'error') + error.message);
  }
});

bot.action('list_emails', async (ctx) => {
  const userId = ctx.from.id;
  try {
    await ctx.editMessageText(t(userId, 'loading_emails'), { parse_mode: 'HTML' });
    const data = await listUserEmails(userId);
    
    if (!data.emails || data.emails.length === 0) {
      ctx.editMessageText(t(userId, 'no_emails'), { parse_mode: 'HTML' });
      return;
    }
    
    let message = `<b>${t(userId, 'your_emails')}</b>\n\n`;
    const buttons = [];
    
    data.emails.forEach((email, index) => {
      message += `${index + 1}. <code>${email.address}</code>\n`;
      buttons.push([
        { text: `📧 ${index + 1}`, callback_data: `view_email_${index}` }
      ]);
    });
    
    buttons.push([{ text: t(userId, 'refresh'), callback_data: 'list_emails' }]);
    buttons.push([{ text: t(userId, 'back'), callback_data: 'back_menu' }]);
    
    userSessions[userId].emails = data.emails;
    ctx.editMessageText(message, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (error) {
    ctx.editMessageText(t(userId, 'error') + error.message, { parse_mode: 'HTML' });
  }
});

bot.action(/^view_email_(.+)$/, async (ctx) => {
  const emailIndex = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  const email = userSessions[userId].emails?.[emailIndex];
  
  if (!email) {
    ctx.answerCbQuery(t(userId, 'error') + 'Email not found', true);
    return;
  }
  
  try {
    await ctx.editMessageText(t(userId, 'loading_messages'), { parse_mode: 'HTML' });
    const data = await getMessages(email.id);
    
    if (!data.messages || data.messages.length === 0) {
      ctx.editMessageText(
        `📧 <b>${email.address}</b>\n\n${t(userId, 'no_messages')}`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: t(userId, 'refresh'), callback_data: `view_email_${emailIndex}` }],
              [{ text: t(userId, 'delete'), callback_data: `delete_email_${emailIndex}` }],
              [{ text: t(userId, 'back'), callback_data: 'list_emails' }]
            ]
          }
        }
      );
      return;
    }
    
    // Cache messages
    messageCache[`${userId}_${emailIndex}`] = data.messages;
    
    let message = `📧 <b>${email.address}</b>

<b>${t(userId, 'messages')}:</b>

`;
    const buttons = [];
    
    data.messages.forEach((msg, index) => {
      message += `${index + 1}. <b>${msg.from_address}</b>\n`;
      message += `   ${msg.subject}\n\n`;
      buttons.push([
        { text: `📨 ${index + 1}`, callback_data: `msg_${emailIndex}_${index}` }
      ]);
    });
    
    buttons.push([
      { text: t(userId, 'refresh'), callback_data: `view_email_${emailIndex}` },
      { text: t(userId, 'delete_email'), callback_data: `delete_email_${emailIndex}` }
    ]);
    buttons.push([{ text: t(userId, 'back'), callback_data: 'list_emails' }]);
    
    userSessions[userId].currentEmailIndex = emailIndex;
    ctx.editMessageText(message, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (error) {
    ctx.editMessageText(t(userId, 'error') + error.message, { parse_mode: 'HTML' });
  }
});

bot.action(/^msg_(\d+)_(\d+)$/, async (ctx) => {
  const emailIndex = parseInt(ctx.match[1]);
  const messageIndex = parseInt(ctx.match[2]);
  const userId = ctx.from.id;
  
  const email = userSessions[userId].emails?.[emailIndex];
  const messages = messageCache[`${userId}_${emailIndex}`];
  const msg = messages?.[messageIndex];
  
  if (!email || !msg) {
    ctx.answerCbQuery(t(userId, 'error') + 'Message not found', true);
    return;
  }
  
  try {
    await ctx.editMessageText(t(userId, 'loading_message'), { parse_mode: 'HTML' });
    const message = await getMessageDetail(email.id, msg.id);
    
    let content = `<b>${t(userId, 'from')}:</b> ${message.from_address}\n`;
    content += `<b>${t(userId, 'subject')}:</b> ${message.subject}\n`;
    content += `<b>${t(userId, 'received')}:</b> ${new Date(message.received_at).toLocaleString()}\n\n`;
    content += `<b>───────────────────────</b>\n\n`;
    
    if (message.html) {
      content += `<i>${t(userId, 'html_available')}</i>\n\n`;
    }
    
    content += message.content || 'No content';
    
    // Truncate if too long
    if (content.length > 4000) {
      content = content.substring(0, 4000) + `...\n\n<i>${t(userId, 'message_truncated')}</i>`;
    }
    
    ctx.editMessageText(content, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: t(userId, 'delete'), callback_data: `del_msg_${emailIndex}_${messageIndex}` }],
          [{ text: t(userId, 'back'), callback_data: `view_email_${emailIndex}` }]
        ]
      }
    });
  } catch (error) {
    ctx.editMessageText(t(userId, 'error') + error.message, { parse_mode: 'HTML' });
  }
});

// ==================== Delete Actions ====================

bot.action(/^delete_email_(\d+)$/, (ctx) => {
  const userId = ctx.from.id;
  const emailIndex = parseInt(ctx.match[1]);
  ctx.editMessageText(
    t(userId, 'confirm_delete'),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: t(userId, 'yes'), callback_data: `confirm_del_email_${emailIndex}` },
            { text: t(userId, 'no'), callback_data: `view_email_${emailIndex}` }
          ]
        ]
      }
    }
  );
});

bot.action(/^confirm_del_email_(\d+)$/, async (ctx) => {
  const emailIndex = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  const email = userSessions[userId].emails?.[emailIndex];
  
  if (!email) {
    ctx.answerCbQuery(t(userId, 'error') + 'Email not found', true);
    return;
  }
  
  try {
    await deleteEmail(email.id);
    // Remove email from user database
    removeEmailFromUser(userId, email.id);
    
    ctx.editMessageText(t(userId, 'email_deleted'), { parse_mode: 'HTML' });
    
    setTimeout(() => {
      ctx.editMessageText(t(userId, 'loading_emails'), { parse_mode: 'HTML' });
      bot.action('list_emails').middleware()[0](ctx);
    }, 1000);
  } catch (error) {
    ctx.editMessageText(t(userId, 'error') + error.message, { parse_mode: 'HTML' });
  }
});

bot.action(/^del_msg_(\d+)_(\d+)$/, async (ctx) => {
  const emailIndex = parseInt(ctx.match[1]);
  const messageIndex = parseInt(ctx.match[2]);
  const userId = ctx.from.id;
  
  const email = userSessions[userId].emails?.[emailIndex];
  const messages = messageCache[`${userId}_${emailIndex}`];
  const msg = messages?.[messageIndex];
  
  if (!email || !msg) {
    ctx.answerCbQuery(t(userId, 'error') + 'Message not found', true);
    return;
  }
  
  try {
    await deleteMessage(email.id, msg.id);
    ctx.editMessageText(t(userId, 'message_deleted'), { parse_mode: 'HTML' });
    
    setTimeout(() => {
      ctx.editMessageText(t(userId, 'loading_messages'), { parse_mode: 'HTML' });
      ctx.answerCbQuery();
    }, 500);
  } catch (error) {
    ctx.editMessageText(t(userId, 'error') + error.message, { parse_mode: 'HTML' });
  }
});

// ==================== Navigation ====================

bot.action('view_profile', async (ctx) => {
  const userId = ctx.from.id;
  const user = ctx.from;
  const db = loadDatabase();
  const userEmails = Object.keys(db.users[userId] || {}).filter(key => key !== 'language');
  const userLang = getUserLanguage(userId);
  const langDisplay = userLang === 'en' ? '🇬🇧 English' : '🇮🇩 Indonesia';
  
  // Get user creation date from database
  const joinDate = db.users[userId]?.joinDate || new Date().toISOString();
  
  // Create profile message
  const profileMessage = 
    `<b>${t(userId, 'profile_title')}</b>\n\n` +
    `👤 ${t(userId, 'name')}: ${user.first_name || 'Anonymous'}\n` +
    `🔐 ${t(userId, 'user_id')}: <code>${userId}</code>\n` +
    `📧 ${t(userId, 'total_emails')}: ${userEmails.length}\n` +
    `🇬 ${t(userId, 'language_setting')}: ${langDisplay}\n` +
    `📅 ${t(userId, 'joined')}: ${new Date(joinDate).toLocaleDateString()}`;
  
  try {
    // Try to get user profile photos
    const photos = await ctx.telegram.getUserProfilePhotos(userId, 0, 1);
    if (photos && photos.total_count > 0) {
      const photo = photos.photos[0][photos.photos[0].length - 1]; // Get highest resolution
      // Send profile photo with caption
      await ctx.replyWithPhoto(photo.file_id, {
        caption: profileMessage,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: t(userId, 'back'), callback_data: 'back_menu' }]
          ]
        }
      });
      return;
    }
  } catch (error) {
    // If we can't get profile photo, continue with text-only profile
    console.log('Could not fetch user profile photo:', error.message);
  }
  
  // Send text-only profile (fallback)
  try {
    ctx.editMessageText(profileMessage, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: t(userId, 'back'), callback_data: 'back_menu' }]
        ]
      }
    });
  } catch (editError) {
    // If editing fails (e.g., message is a photo), send a new message
    ctx.reply(profileMessage, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: t(userId, 'back'), callback_data: 'back_menu' }]
        ]
      }
    });
  }
});

bot.action('back_menu', (ctx) => {
  const userId = ctx.from.id;
  userSessions[userId] = {};
  
  // Send new message instead of editing to avoid conflicts
  ctx.reply(
    `<b>${t(userId, 'vun_mail')}</b>\n\n${t(userId, 'what_to_do')}`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: t(userId, 'create_email'), callback_data: 'create_email' }],
          [{ text: t(userId, 'my_emails'), callback_data: 'list_emails' }],
          [{ text: t(userId, 'profile'), callback_data: 'view_profile' }],
          [{ text: t(userId, 'settings'), callback_data: 'settings' }]
        ]
      }
    }
  );
});

bot.action('settings', (ctx) => {
  const userId = ctx.from.id;
  const currentLang = getUserLanguage(userId);
  const langDisplay = currentLang === 'en' ? '🇬🇧 English' : '🇮🇩 Indonesia';
  
  const buttons = [
    [{ text: '🇬🇧 English', callback_data: 'lang_en' }],
    [{ text: '🇮🇩 Indonesia', callback_data: 'lang_id' }]
  ];
  
  // Add admin button only for admin users
  if (isAdmin(userId)) {
    buttons.push([{ text: t(userId, 'admin_panel_button'), callback_data: 'admin_panel' }]);
  }
  
  buttons.push([{ text: t(userId, 'back'), callback_data: 'back_menu' }]);
  
  ctx.editMessageText(
    `<b>${t(userId, 'settings_title')}</b>\n\n` +
    `${t(userId, 'version')}\n` +
    `Created by: <a href=\"https://github.com/VinzxyO\">VinzxyO</a>\n` +
    `${t(userId, 'api')}\n` +
    `<b>Language:</b> ${langDisplay}\n\n` +
    `${t(userId, 'more_settings')}`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
});

bot.action(/^lang_(.+)$/, (ctx) => {
  const userId = ctx.from.id;
  const lang = ctx.match[1];
  const currentLang = getUserLanguage(userId);
  
  // Check if user is selecting the same language
  if (currentLang === lang) {
    ctx.answerCbQuery(t(userId, 'language_set'), true);
    return;
  }
  
  setUserLanguage(userId, lang);
  
  const newLang = getUserLanguage(userId);
  const langDisplay = newLang === 'en' ? '🇬🇧 English' : '🇮🇩 Indonesia';
  
  ctx.editMessageText(
    `<b>${t(userId, 'settings_title')}</b>\n\n` +
    `${t(userId, 'version')}\n` +
    `Created by: <a href=\"https://github.com/VinzxyO\">VinzxyO</a>\n` +
    `${t(userId, 'api')}\n` +
    `<b>Language:</b> ${langDisplay}\n\n` +
    `${t(userId, 'more_settings')}`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🇬🇧 English', callback_data: 'lang_en' }],
          [{ text: '🇮🇩 Indonesia', callback_data: 'lang_id' }],
          [{ text: t(userId, 'back'), callback_data: 'back_menu' }]
        ]
      }
    }
  );
});

bot.action('admin_panel', (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    ctx.answerCbQuery(t(userId, 'admin_access_denied'), true);
    return;
  }
  
  const users = getAllUsers();
  const totalEmails = users.reduce((sum, u) => sum + u.emails.length, 0);
  
  ctx.editMessageText(
    `<b>${t(userId, 'admin_panel')}</b>\n\n` +
    `${t(userId, 'total_users')}: <b>${users.length}</b>\n` +
    `${t(userId, 'total_emails_label')}: <b>${totalEmails}</b>\n` +
    `${t(userId, 'average_label')}: <b>${users.length > 0 ? (totalEmails / users.length).toFixed(2) : 0}</b>`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: t(userId, 'all_users'), callback_data: 'admin_list_users' }],
          [{ text: t(userId, 'statistics'), callback_data: 'admin_stats' }],
          [{ text: '⚙️ Settings', callback_data: 'admin_settings' }],
          [{ text: t(userId, 'back_settings'), callback_data: 'settings' }]
        ]
      }
    }
  );
});

bot.command('admin', (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    ctx.replyWithHTML(t(userId, 'admin_access_denied'));
    return;
  }
  
  ctx.replyWithHTML(
    `<b>${t(userId, 'admin_panel')}</b>\n\n` +
    `<code>/admin_users</code> - ${t(userId, 'cmd_cancel')}\n` +
    `<code>/admin_stats</code> - ${t(userId, 'statistics')}`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '👥 All Users', callback_data: 'admin_list_users' }],
          [{ text: '📈 Statistics', callback_data: 'admin_stats' }]
        ]
      }
    }
  );
});

bot.command('admin_users', (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    ctx.replyWithHTML(t(userId, 'admin_access_denied'));
    return;
  }
  
  const users = getAllUsers();
  let message = `<b>${t(userId, 'all_users')}:</b>\n\n`;
  
  if (users.length === 0) {
    ctx.replyWithHTML(t(userId, 'no_users_found'));
    return;
  }
  
  users.forEach((user, index) => {
    message += `${index + 1}. <code>ID: ${user.userId}</code>\n`;
    message += `   ${t(userId, 'total_emails')}: ${user.emails.length}\n`;
    message += `   ${t(userId, 'language_setting')}: ${user.language}\n\n`;
  });
  
  ctx.replyWithHTML(message);
});

bot.command('admin_stats', (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    ctx.replyWithHTML(t(userId, 'admin_access_denied'));
    return;
  }
  
  const users = getAllUsers();
  const totalEmails = users.reduce((sum, u) => sum + u.emails.length, 0);
  
  ctx.replyWithHTML(
    `<b>${t(userId, 'statistics')}:</b>\n\n` +
    `${t(userId, 'total_users')}: <b>${users.length}</b>\n` +
    `${t(userId, 'total_emails_label')}: <b>${totalEmails}</b>\n` +
    `${t(userId, 'average_label')}: <b>${users.length > 0 ? (totalEmails / users.length).toFixed(2) : 0}</b>`
  );
});

bot.action('admin_list_users', (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    ctx.answerCbQuery(t(userId, 'admin_access_denied'), true);
    return;
  }
  
  const users = getAllUsers();
  let message = `<b>${t(userId, 'all_users')}:</b>\n\n`;
  
  if (users.length === 0) {
    ctx.editMessageText(t(userId, 'no_users_found'));
    return;
  }
  
  const buttons = [];
  users.forEach((user, index) => {
    message += `${index + 1}. ID: <code>${user.userId}</code>\n`;
    message += `   ${t(userId, 'total_emails')}: ${user.emails.length}\n`;
    message += `   ${t(userId, 'language_setting')}: ${user.language}\n\n`;
    buttons.push([{ text: `👥 User ${index + 1}`, callback_data: `admin_user_${user.userId}` }]);
  });
  
  buttons.push([{ text: t(userId, 'back'), callback_data: 'admin_panel' }]);
  
  ctx.editMessageText(message, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons }
  });
});

bot.action(/^admin_user_(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const targetUserId = ctx.match[1];
  
  if (!isAdmin(userId)) {
    ctx.answerCbQuery(t(userId, 'admin_access_denied'), true);
    return;
  }
  
  try {
    const db = loadDatabase();
    const userEmails = Object.keys(db.users[targetUserId] || {}).filter(key => key !== 'language');
    
    let message = `<b>${t(userId, 'user_emails').replace('{userId}', targetUserId)}</b>\n\n`;
    
    if (userEmails.length === 0) {
      message += t(userId, 'no_emails');
      ctx.editMessageText(message, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: t(userId, 'back'), callback_data: 'admin_list_users' }]
          ]
        }
      });
      return;
    }
    
    const buttons = [];
    userEmails.forEach((emailId, index) => {
      message += `${index + 1}. <code>${emailId}</code>\n`;
      buttons.push([{ text: `📧 ${index + 1}`, callback_data: `admin_view_email_${targetUserId}_${index}` }]);
    });
    
    buttons.push([{ text: t(userId, 'back'), callback_data: 'admin_list_users' }]);
    
    // Store user emails in session for quick access
    userSessions[userId] = userSessions[userId] || {};
    userSessions[userId].adminUserEmails = userEmails;
    userSessions[userId].adminTargetUserId = targetUserId;
    
    ctx.editMessageText(message, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (error) {
    ctx.editMessageText(t(userId, 'error') + error.message, { parse_mode: 'HTML' });
  }
});

bot.action(/^admin_del_email_(.+)_(.+)$/, async (ctx) => {
  const adminUserId = ctx.from.id;
  const targetUserId = ctx.match[1];
  const emailIndex = parseInt(ctx.match[2]);
  
  if (!isAdmin(adminUserId)) {
    ctx.answerCbQuery(t(adminUserId, 'admin_access_denied'), true);
    return;
  }
  
  try {
    const userEmails = userSessions[adminUserId]?.adminUserEmails || [];
    const emailId = userEmails[emailIndex];
    
    if (!emailId) {
      ctx.answerCbQuery(t(adminUserId, 'error') + 'Email not found', true);
      return;
    }
    
    // Delete from API
    await deleteEmail(emailId);
    // Delete from database
    removeEmailFromUser(targetUserId, emailId);
    
    ctx.answerCbQuery(t(adminUserId, 'email_deleted_admin'));
    
    // Refresh the email list
    const db = loadDatabase();
    const remainingEmails = Object.keys(db.users[targetUserId] || {}).filter(key => key !== 'language');
    
    let message = `<b>${t(adminUserId, 'user_emails').replace('{userId}', targetUserId)}</b>\n\n`;
    
    if (remainingEmails.length === 0) {
      message += t(adminUserId, 'no_emails');
      ctx.editMessageText(message, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: t(adminUserId, 'back'), callback_data: 'admin_list_users' }]
          ]
        }
      });
      return;
    }
    
    const buttons = [];
    remainingEmails.forEach((id, index) => {
      message += `${index + 1}. <code>${id}</code>\n`;
      buttons.push([{ text: `🗑️ ${index + 1}`, callback_data: `admin_del_email_${targetUserId}_${index}` }]);
    });
    
    buttons.push([{ text: t(adminUserId, 'back'), callback_data: 'admin_list_users' }]);
    userSessions[adminUserId].adminUserEmails = remainingEmails;
    
    ctx.editMessageText(message, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (error) {
    ctx.editMessageText(t(adminUserId, 'error') + error.message, { parse_mode: 'HTML' });
  }
});

bot.action(/^admin_view_email_(.+)_(.+)$/, async (ctx) => {
  const adminUserId = ctx.from.id;
  const targetUserId = ctx.match[1];
  const emailIndex = parseInt(ctx.match[2]);
  
  if (!isAdmin(adminUserId)) {
    ctx.answerCbQuery(t(adminUserId, 'admin_access_denied'), true);
    return;
  }
  
  try {
    const db = loadDatabase();
    const userEmails = Object.keys(db.users[targetUserId] || {}).filter(key => key !== 'language');
    const emailId = userEmails[emailIndex];
    
    if (!emailId) {
      ctx.answerCbQuery(t(adminUserId, 'error') + 'Email not found', true);
      return;
    }
    
    // Get email address from API
    const allEmails = await listAllEmails();
    const email = allEmails.find(e => e.id === emailId);
    
    if (!email) {
      ctx.answerCbQuery(t(adminUserId, 'error') + 'Email not found', true);
      return;
    }
    
    await ctx.editMessageText(t(adminUserId, 'loading_messages'), { parse_mode: 'HTML' });
    const data = await getMessages(emailId);
    
    if (!data.messages || data.messages.length === 0) {
      ctx.editMessageText(
        `📧 <b>${email.address}</b>\n\n${t(adminUserId, 'no_messages')}`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: t(adminUserId, 'delete'), callback_data: `admin_del_email_${targetUserId}_${emailIndex}` }],
              [{ text: t(adminUserId, 'back'), callback_data: `admin_user_${targetUserId}` }]
            ]
          }
        }
      );
      return;
    }
    
    // Cache messages
    messageCache[`admin_${adminUserId}_${emailIndex}`] = data.messages;
    
    let message = `📧 <b>${email.address}</b>

<b>${t(adminUserId, 'messages')}:</b>

`;
    const buttons = [];
    
    data.messages.forEach((msg, index) => {
      message += `${index + 1}. <b>${msg.from_address}</b>\n`;
      message += `   ${msg.subject}\n\n`;
      buttons.push([
        { text: `📨 ${index + 1}`, callback_data: `admin_msg_${emailIndex}_${index}_${targetUserId}` }
      ]);
    });
    
    buttons.push([
      { text: t(adminUserId, 'delete'), callback_data: `admin_del_email_${targetUserId}_${emailIndex}` }
    ]);
    buttons.push([{ text: t(adminUserId, 'back'), callback_data: `admin_user_${targetUserId}` }]);
    
    ctx.editMessageText(message, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (error) {
    ctx.editMessageText(t(adminUserId, 'error') + error.message, { parse_mode: 'HTML' });
  }
});

bot.action(/^admin_msg_(.+)_(.+)_(.+)$/, async (ctx) => {
  const emailIndex = parseInt(ctx.match[1]);
  const messageIndex = parseInt(ctx.match[2]);
  const targetUserId = ctx.match[3];
  const adminUserId = ctx.from.id;
  
  if (!isAdmin(adminUserId)) {
    ctx.answerCbQuery(t(adminUserId, 'admin_access_denied'), true);
    return;
  }
  
  try {
    const db = loadDatabase();
    const userEmails = Object.keys(db.users[targetUserId] || {}).filter(key => key !== 'language');
    const emailId = userEmails[emailIndex];
    const messages = messageCache[`admin_${adminUserId}_${emailIndex}`];
    const msg = messages?.[messageIndex];
    
    if (!emailId || !msg) {
      ctx.answerCbQuery(t(adminUserId, 'error') + 'Message not found', true);
      return;
    }
    
    await ctx.editMessageText(t(adminUserId, 'loading_message'), { parse_mode: 'HTML' });
    const message = await getMessageDetail(emailId, msg.id);
    
    let content = `<b>${t(adminUserId, 'from')}:</b> ${message.from_address}\n`;
    content += `<b>${t(adminUserId, 'subject')}:</b> ${message.subject}\n`;
    content += `<b>${t(adminUserId, 'received')}:</b> ${new Date(message.received_at).toLocaleString()}\n\n`;
    content += `<b>────────────────────</b>\n\n`;
    
    if (message.html) {
      content += `<i>${t(adminUserId, 'html_available')}</i>\n\n`;
    }
    
    content += message.content || 'No content';
    
    // Truncate if too long
    if (content.length > 4000) {
      content = content.substring(0, 4000) + `...\n\n<i>${t(adminUserId, 'message_truncated')}</i>`;
    }
    
    ctx.editMessageText(content, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: t(adminUserId, 'back'), callback_data: `admin_view_email_${targetUserId}_${emailIndex}` }]
        ]
      }
    });
  } catch (error) {
    ctx.editMessageText(t(adminUserId, 'error') + error.message, { parse_mode: 'HTML' });
  }
});

bot.action('admin_stats', (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    ctx.answerCbQuery(t(userId, 'admin_access_denied'), true);
    return;
  }
  
  const users = getAllUsers();
  const totalEmails = users.reduce((sum, u) => sum + u.emails.length, 0);
  
  ctx.editMessageText(
    `<b>📈 ${t(userId, 'statistics')}:</b>\n\n` +
    `Total Users: <b>${users.length}</b>\n` +
    `Total Emails: <b>${totalEmails}</b>\n` +
    `Average per User: <b>${users.length > 0 ? (totalEmails / users.length).toFixed(2) : 0}</b>`,
    { parse_mode: 'HTML' }
  );
});

// ==================== Start Bot ====================

// Set bot commands
// ==================== Admin Settings ====================

bot.action('admin_settings', (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    ctx.answerCbQuery(t(userId, 'admin_access_denied'), true);
    return;
  }
  
  const proxyCount = proxies.getProxyCount();
  const apiKey = process.env.API_KEY ? process.env.API_KEY.substring(0, 10) + '...' : 'Not set';
  
  ctx.editMessageText(
    `<b>${t(userId, 'admin_settings')}</b>\n\n` +
    `${t(userId, 'change_api_key')}: <code>${apiKey}</code>\n` +
    `${t(userId, 'manage_proxies')}: <b>${proxyCount}</b> ${t(userId, 'current_proxies')}\n\n` +
    `${t(userId, 'more_settings')}`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: t(userId, 'change_api_key'), callback_data: 'admin_api_menu' }],
          [{ text: t(userId, 'manage_proxies'), callback_data: 'admin_proxy_menu' }],
          [{ text: t(userId, 'back'), callback_data: 'admin_panel' }]
        ]
      }
    }
  );
});

bot.action('admin_api_menu', (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    ctx.answerCbQuery(t(userId, 'admin_access_denied'), true);
    return;
  }
  
  userSessions[userId].step = 'waiting_api_key';
  ctx.editMessageText(
    `<b>${t(userId, 'change_api_key')}</b>\n\n` +
    `${t(userId, 'send_api_key')}\n` +
    `${t(userId, 'current_key_starts')}<code>${process.env.API_KEY.substring(0, 10)}...</code>`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: t(userId, 'cancel'), callback_data: 'admin_settings' }]
        ]
      }
    }
  );
});

bot.action('admin_proxy_menu', (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    ctx.answerCbQuery(t(userId, 'admin_access_denied'), true);
    return;
  }
  
  const proxyCount = proxies.getProxyCount();
  ctx.editMessageText(
    `<b>${t(userId, 'manage_proxies')}</b>\n\n` +
    `${t(userId, 'current_proxies')}<b>${proxyCount}</b>\n\n` +
    `${t(userId, 'more_settings')}`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: t(userId, 'add_proxy'), callback_data: 'admin_add_proxy' }],
          [{ text: t(userId, 'remove_proxy'), callback_data: 'admin_remove_proxy_list' }],
          [{ text: t(userId, 'view_all_proxies'), callback_data: 'admin_view_proxies' }],
          [{ text: t(userId, 'back'), callback_data: 'admin_settings' }]
        ]
      }
    }
  );
});

bot.action('admin_add_proxy', (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    ctx.answerCbQuery(t(userId, 'admin_access_denied'), true);
    return;
  }
  
  userSessions[userId].step = 'waiting_proxy_add';
  ctx.editMessageText(
    `<b>${t(userId, 'add_proxy')}</b>\n\n` +
    `${t(userId, 'send_proxy_address')}`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: t(userId, 'cancel'), callback_data: 'admin_proxy_menu' }]
        ]
      }
    }
  );
});

bot.action('admin_remove_proxy_list', (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    ctx.answerCbQuery(t(userId, 'admin_access_denied'), true);
    return;
  }
  
  const proxyList = proxies.getAllProxies();
  if (proxyList.length === 0) {
    ctx.answerCbQuery(t(userId, 'no_proxies_to_remove'), true);
    return;
  }
  
  let message = `<b>${t(userId, 'remove_proxy')}</b>\n\n` +
    `${t(userId, 'select_proxy_remove')}\n\n`;
  const buttons = [];
  
  proxyList.forEach((proxy, index) => {
    message += `${index + 1}. <code>${proxy}</code>\n`;
    buttons.push([{ text: `🗑️ ${index + 1}`, callback_data: `admin_del_proxy_${index}` }]);
  });
  
  buttons.push([{ text: t(userId, 'cancel'), callback_data: 'admin_proxy_menu' }]);
  
  ctx.editMessageText(message, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons }
  });
});

bot.action(/^admin_del_proxy_(\d+)$/, (ctx) => {
  const userId = ctx.from.id;
  const proxyIndex = parseInt(ctx.match[1]);
  
  if (!isAdmin(userId)) {
    ctx.answerCbQuery(t(userId, 'admin_access_denied'), true);
    return;
  }
  
  const proxyList = proxies.getAllProxies();
  const proxy = proxyList[proxyIndex];
  
  if (proxy) {
    proxies.removeProxy(proxy);
    ctx.answerCbQuery(`${t(userId, 'proxy_removed_msg')}${proxy}`);
    
    // Refresh proxy list
    const updatedList = proxies.getAllProxies();
    if (updatedList.length === 0) {
      ctx.editMessageText(
        `<b>${t(userId, 'remove_proxy')}</b>\n\n` +
        `${t(userId, 'proxy_removed_success')}\n\n` +
        `${t(userId, 'no_proxies_left')}.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: t(userId, 'cancel'), callback_data: 'admin_proxy_menu' }]
            ]
          }
        }
      );
      return;
    }
    
    let message = `<b>${t(userId, 'remove_proxy')}</b>\n\n` +
      `${t(userId, 'proxy_removed_success')}\n\n` +
      `${t(userId, 'select_proxy_remove_again')}\n\n`;
    const buttons = [];
    
    updatedList.forEach((p, index) => {
      message += `${index + 1}. <code>${p}</code>\n`;
      buttons.push([{ text: `🗑️ ${index + 1}`, callback_data: `admin_del_proxy_${index}` }]);
    });
    
    buttons.push([{ text: t(userId, 'back'), callback_data: 'admin_proxy_menu' }]);
    
    ctx.editMessageText(message, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  }
});

bot.action('admin_view_proxies', (ctx) => {
  const userId = ctx.from.id;
  
  if (!isAdmin(userId)) {
    ctx.answerCbQuery(t(userId, 'admin_access_denied'), true);
    return;
  }
  
  const proxyList = proxies.getAllProxies();
  let message = `<b>${t(userId, 'all_proxies')} (${proxyList.length})</b>\n\n`;
  
  if (proxyList.length === 0) {
    message += t(userId, 'no_proxies_configured') + '.';
  } else {
    proxyList.forEach((proxy, index) => {
      message += `${index + 1}. <code>${proxy}</code>\n`;
    });
  }
  
  ctx.editMessageText(message, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: t(userId, 'back'), callback_data: 'admin_proxy_menu' }]
      ]
    }
  });
});

// Handle API key and proxy text input
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions[userId];
  
  // ... existing code ...
  
  if (session && session.step === 'waiting_api_key' && isAdmin(userId)) {
    const newApiKey = ctx.message.text.trim();
    
    if (newApiKey.length < 20) {
      ctx.replyWithHTML(t(userId, 'api_key_short'));
      return;
    }
    
    // Update .env file
    try {
      const envPath = path.join(__dirname, '.env');
      let envContent = fs.readFileSync(envPath, 'utf8');
      envContent = envContent.replace(/API_KEY=.*/g, `API_KEY=${newApiKey}`);
      fs.writeFileSync(envPath, envContent, 'utf8');
      process.env.API_KEY = newApiKey;
      
      ctx.replyWithHTML(
        `${t(userId, 'api_key_updated')}\n\n` +
        `${t(userId, 'api_key_new')}<code>${newApiKey.substring(0, 10)}...</code>\n\n` +
        `${t(userId, 'api_key_warning')}`
      );
    } catch (error) {
      ctx.replyWithHTML(`${t(userId, 'error')}${error.message}`);
    }
    
    session.step = null;
  } else if (session && session.step === 'waiting_proxy_add' && isAdmin(userId)) {
    const newProxy = ctx.message.text.trim();
    
    if (!newProxy.startsWith('http://') && !newProxy.startsWith('https://')) {
      ctx.replyWithHTML(t(userId, 'proxy_format_error'));
      return;
    }
    
    if (proxies.addProxy(newProxy)) {
      ctx.replyWithHTML(
        `${t(userId, 'proxy_added')}\n\n` +
        `🌐 <code>${newProxy}</code>\n\n` +
        `${t(userId, 'total_proxies')}<b>${proxies.getProxyCount()}</b>`
      );
    } else {
      ctx.replyWithHTML(t(userId, 'proxy_exists_error'));
    }
    
    session.step = null;
  }
});

// ... existing code ...
async function setCommands() {
  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Start the bot and show main menu' },
      { command: 'help', description: 'Show help information' },
    ]);
    console.log('✅ Bot commands registered successfully');
  } catch (error) {
    console.error('Error setting commands:', error.message);
  }
}

bot.launch();

// Set commands after bot is launched
setCommands();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

console.log('🤖 Vun Mail is running...');
