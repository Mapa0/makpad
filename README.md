# 📝 MAKPAD — Realtime Cloud Notepad & CLI

[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen?style=for-the-badge&logo=vercel)](https://makpad.surge.sh)
[![Platform](https://img.shields.io/badge/platform-Web%20%7C%20Linux%20%7C%20macOS%20%7C%20Windows-blue?style=for-the-badge)](#)

> **MAKPAD** is a minimalist, ultra-fast, and realtime cloud notepad service. Inspired by Dontpad, it allows you to instantly sync text between your browser and your terminal without any login, configuration, or hassle. 

Just access any path (e.g., `makpad.surge.sh/my_notes`) to start writing instantly!

---

## ✨ Features

- **Instant Synchronization:** Write on the web, see in the terminal. Pipe from the terminal, see on the web.
- **Zero Configuration:** No accounts, no passwords, no setup. Just pick a URL/slug and go.
- **Cross-Platform CLI:** Native-like experience for Linux, macOS, and Windows.
- **Append & Pipe Support:** Append logs, pipe outputs, or overwrite files directly from your terminal workflows.
- **Retro Aesthetic:** Modern Web UI with a sleek dark-mode console theme, glowing typography, and micro-animations.

---

## 🚀 Live Demo

Access the web application here:  
👉 **[https://makpad.surge.sh](https://makpad.surge.sh)**

---

## 📦 CLI Installation

Install the **MAKPAD** command line tool with a single command:

### 🐧 Linux & macOS
```bash
curl -sL https://makpad.surge.sh/install.sh | bash
```

### 🪟 Windows (PowerShell)
```powershell
iwr -useb https://makpad.surge.sh/install.ps1 | iex
```

---

## 💻 CLI Usage Examples

Once installed, use `makpad <note_name>` in your terminal:

### 📖 Read a Note
Fetch and print the content of any cloud note:
```bash
makpad my_notes
```

### ✍️ Write/Overwrite a Note
Send a string directly:
```bash
makpad my_notes "Pausa pro café!"
```

Or pipe command outputs:
```bash
echo "Hello MAKPAD from the CLI!" | makpad my_notes
```

### ➕ Append to a Note
Append new content to the end of the note without overwriting:
```bash
echo "This is an extra log line" | makpad my_notes --append
# or shortcut
echo "Another line" | makpad my_notes -a
```

---

## 🛠️ Tech Stack

- **Frontend:** Vanilla HTML5, CSS3 (Custom Variables, Keyframe Animations), and modern JavaScript.
- **Backend/Storage:** Key-Value Database (KVDB) API for high performance and low-latency synchronization.
- **Fonts:** JetBrains Mono & Inter via Google Fonts.

---

## 📄 License

This project is open-source and available under the [MIT License](LICENSE).
