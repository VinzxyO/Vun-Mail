# Vun Mail - Telegram Temporary Email Bot

**Author:** [VinzxyO](https://github.com/VinzxyO)

A powerful Telegram bot that allows users to create and manage temporary email addresses using the Temp Mail API.

## Features

- 📧 Create temporary email addresses with custom prefixes
- ⏰ Set email expiration times (1 hour, 1 day, 3 days, or permanent)
- 📬 View and manage all your temporary emails
- 📨 Read incoming messages with full details
- 🗑️ Delete emails and messages when no longer needed
- 🌍 Multi-language support (English and Indonesian)
- 🔐 Admin panel for managing all user emails
- 🌐 Proxy rotation for handling API rate limits

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables in `.env`:
   - `BOT_TOKEN` - Your Telegram bot token from [@BotFather](https://t.me/BotFather)
   - `API_KEY` - Temp Mail API key from [Temp Mail Dashboard](https://chat-tempmail.com/id/profile)
   - `ADMIN_ID` - Your Telegram user ID for admin access (get it from [@userinfobot](https://t.me/userinfobot))
   - `PROXIES` - Optional comma-separated list of proxies for rate limit handling

4. Start the bot:
   ```bash
   npm start
   ```
   or
   ```bash
   node .
   ```

## Usage

### User Commands
- `/start` - Start the bot and show main menu
- `/create` - Create a new temporary email
- `/list` - List all your temporary emails
- `/help` - Show help information
- `/cancel` - Cancel current action
- `/language` - Change language

### Admin Features
- View all users and their email statistics
- Manage all user emails from the admin panel
- Change API key without restarting the bot
- Add/remove proxies for rate limit handling

## Technical Details

- Built with Telegraf.js for Telegram bot framework
- Uses Temp Mail API for email services
- JSON file-based database for user data persistence
- Automatic proxy rotation for rate limiting
- Retry logic with exponential backoff
- Full multi-language support

## Requirements

- Node.js v14 or higher
- Telegram bot token
- Temp Mail API key

## License


This project is licensed under the MIT License.


