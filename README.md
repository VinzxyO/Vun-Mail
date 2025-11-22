# Vun Mail - Bot Email Sementara Telegram

![Vun Mail](https://files.catbox.moe/7a9jci.jpg)

**Author:** [VinzxyO](https://github.com/VinzxyO)

Bot Telegram yang kuat yang memungkinkan pengguna membuat dan mengelola alamat email sementara menggunakan API Temp Mail.

## Fitur

- 📧 Buat alamat email sementara dengan awalan khusus
- ⏰ Atur waktu kedaluwarsa email (1 jam, 1 hari, 3 hari, atau permanen)
- 📬 Lihat dan kelola semua email sementara Anda
- 📨 Baca pesan masuk dengan detail lengkap
- 🗑️ Hapus email dan pesan jika tidak diperlukan lagi
- 🌍 Dukungan multibahasa (Inggris dan Indonesia)
- 🔐 Panel admin untuk mengelola semua email pengguna
- 🌐 Rotasi proxy untuk menangani batasan rate API

## Persiapan

1. Klon repositori:
   ```bash
   git clone https://github.com/VinzxyO/Vun-Mail.git
   ```

2. Masuk ke direktori proyek:
   ```bash
   cd Vun-Mail
   ```

3. Instal dependensi:
   ```bash
   npm install
   ```

4. Konfigurasi variabel lingkungan di `.env`:
   
   Lihat file [.env.example](https://github.com/VinzxyO/Vun-Mail/blob/main/.env.example) untuk instruksi pengaturan variabel lingkungan Anda.

   Penjelasan rinci untuk setiap variabel:
   - `BOT_TOKEN` - Token bot Telegram Anda dari [@BotFather](https://t.me/BotFather)
   - `API_KEY` - Kunci API Temp Mail dari [Dashboard Temp Mail](https://chat-tempmail.com/id/profile)
   - `ADMIN_ID` - ID pengguna Telegram Anda untuk akses admin (dapatkan dari [@userinfobot](https://t.me/userinfobot))
   - `PROXIES` - Daftar proxy yang dipisahkan koma untuk penanganan batasan rate (opsional)

5. Jalankan bot:
   ```bash
   npm start
   ```
   atau
   ```bash
   node .
   ```

## Penggunaan

### Perintah Pengguna
- `/start` - Mulai bot dan tampilkan menu utama
- `/create` - Buat email sementara baru
- `/list` - Daftar semua email sementara Anda
- `/help` - Tampilkan informasi bantuan
- `/cancel` - Batalkan tindakan saat ini
- `/language` - Ubah bahasa

### Fitur Admin
- Lihat semua pengguna dan statistik email mereka
- Kelola semua email pengguna dari panel admin
- Ubah kunci API tanpa merestart bot
- Tambah/hapus proxy untuk penanganan batasan rate

## Detail Teknis

- Dibangun dengan Telegraf.js untuk framework bot Telegram
- Menggunakan API Temp Mail untuk layanan email
- Database berbasis file JSON untuk persistensi data pengguna
- Rotasi proxy otomatis untuk pembatasan rate
- Logika retry dengan backoff eksponensial
- Dukungan multibahasa penuh

## Persyaratan

- Node.js v14 atau lebih tinggi
- Token bot Telegram
- Kunci API Temp Mail

## Lisensi

Proyek ini dilisensikan di bawah Lisensi MIT.
