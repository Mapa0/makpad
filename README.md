<p align="center">
  <img src="https://makpad.mapazero.com/icons/makpad.png" alt="MAKPAD" width="160">
</p>

# MAKPAD

MAKPAD is a self-hosted realtime notepad and temporary file-sharing app.

Open any path to create a chat/note:

```text
https://makpad.mapazero.com/my-note
```

The app is local-first in CasaOS:

- Notes are stored in SQLite.
- Attachments are stored in the local Garage S3 bucket.
- MakpadAdmin reads the same local SQLite/S3 state.

No external KVDB service is required.

## Storage Layout

Inside the CasaOS host:

```text
/DATA/AppData/makpad/
  makpad.db
  makpad.db-wal
  makpad.db-shm

/DATA/AppData/garage/
  Garage object storage data
```

MAKPAD stores:

- Text notes in `/DATA/AppData/makpad/makpad.db`.
- Admin config in `/DATA/AppData/makpad/makpad.db`.
- Attachment metadata in `/DATA/AppData/makpad/makpad.db`.
- Attachment binary objects in the Garage/S3 bucket `makpad-attachments`.

## MakpadAdmin

Open:

```text
https://makpad.mapazero.com/admin
```

MakpadAdmin can:

- list tracked notes/chats;
- show character counts;
- show attachment counts;
- show total S3 storage usage;
- sort chats by attachment storage;
- clean expired attachments;
- clean all attachments from a selected chat;
- delete a selected note and its attachments;
- configure upload limits.

Admin access is controlled by the container environment variable:

```text
MAKPAD_ADMIN_PASSWORD
```

## Abuse Guardrails

MakpadAdmin can configure:

- max file size;
- max files per chat;
- cooldown between uploads;
- attachment lifetime.

These limits reduce storage abuse and simple upload spam. For stronger DDoS protection, use edge/proxy protections too, such as rate limits in Caddy/Nginx/Cloudflare and host firewall rules.

## CLI Installation

Linux/macOS:

```bash
curl -sL https://makpad.mapazero.com/install.sh | bash
```

Windows PowerShell:

```powershell
iwr -useb https://makpad.mapazero.com/install.ps1 | iex
```

## CLI Usage

Read a note:

```bash
makpad my-note
```

Overwrite a note:

```bash
makpad my-note "hello from terminal"
```

Overwrite from stdin:

```bash
echo "hello from stdin" | makpad my-note
```

Append from stdin:

```bash
echo "another line" | makpad my-note --append
```

List attachments for a chat:

```bash
makpad my-note --files
```

Upload a file to a chat:

```bash
makpad my-note --upload ./report.zip
```

Download a file by id:

```bash
makpad my-note --download <file_id> ./report.zip
```

PowerShell examples:

```powershell
makpad my-note "hello from powershell"
makpad my-note -Files
makpad my-note -Upload .\report.zip
makpad my-note -Download <file_id> -OutFile .\report.zip
```

## Docker/CasaOS Environment

Required:

```text
MAKPAD_ADMIN_PASSWORD
S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY
```

Useful defaults:

```text
DATA_DIR=/app/data
FILE_TTL_MS=3600000
MAX_FILE_SIZE=104857600
MAX_FILES_PER_SLUG=20
UPLOAD_COOLDOWN_MS=10000
S3_ENDPOINT=http://host.docker.internal:3900
S3_REGION=garage
S3_BUCKET=makpad-attachments
```

The container volume should keep `/app/data` mapped to:

```text
/DATA/AppData/makpad
```

## Fresh Install

To reset MAKPAD completely:

```bash
sudo rm -rf /DATA/AppData/makpad
```

To also clear all Garage/S3 objects for MAKPAD, delete the objects under the `makpad-attachments` bucket or recreate the bucket.

After cleanup, redeploy/restart the MAKPAD container. The app will recreate `makpad.db` automatically.

## Tech Stack

- Node.js and Express
- SQLite via `better-sqlite3`
- Garage/S3 for attachment objects
- MinIO SDK for S3 operations
- Vanilla HTML/CSS/JavaScript

## License

MIT
