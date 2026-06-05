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
- Attachments are optional and, when enabled, are stored in the local Garage S3 bucket.
- MakpadAdmin reads the same local SQLite/S3 state.

No external KVDB service is required.

## Project Structure

```text
src/server/          Express API, SQLite, S3/Garage integration
public/app/          Main MAKPAD web editor
public/admin/        MakpadAdmin dashboard
public/assets/       Icons, favicons, and static media
scripts/cli/         Linux/macOS and PowerShell CLI clients
scripts/install/     Public installer scripts
deploy/casaos/       CasaOS compose files for MAKPAD, Garage, and S3 Manager
```

Public compatibility routes are preserved. For example, `/app.js`, `/style.css`, `/install.sh`, `/makpad-cli.txt`, and `/icons/...` still work even though their source files now live in organized folders.

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
- Attachment metadata in `/DATA/AppData/makpad/makpad.db`, when attachments are enabled.
- Attachment binary objects in the Garage/S3 bucket `makpad-attachments`, when attachments are enabled.

## Minimal Install

MAKPAD can run without Garage/S3.

For a minimal SQLite-only install, omit these environment variables:

```text
S3_ENDPOINT
S3_BUCKET
S3_ACCESS_KEY_ID
S3_SECRET_ACCESS_KEY
```

In this mode:

- the web UI hides the attachments panel;
- text notes continue working normally;
- MakpadAdmin shows attachment storage as disabled;
- CLI file commands return a clear disabled message;
- only `/DATA/AppData/makpad/makpad.db` is required for persistence.

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

Required for the app:

```text
MAKPAD_ADMIN_PASSWORD
```

Required only when enabling attachments:

```text
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

## CasaOS Compose Files

The CasaOS manifests live in:

```text
deploy/casaos/makpad-compose.yml
deploy/casaos/garage-compose.yml
deploy/casaos/s3manager-compose.yml
```

## Tech Stack

- Node.js and Express
- SQLite via `better-sqlite3`
- Garage/S3 for attachment objects
- MinIO SDK for S3 operations
- Vanilla HTML/CSS/JavaScript

## License

MIT
