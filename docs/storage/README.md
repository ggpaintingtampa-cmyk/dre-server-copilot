# DRE Storage Operator Guide — Network Volume, S3, rclone, and `/workspace` vs `/opt`

**Status: VERIFIED OPERATIONAL PROCEDURE.** Unlike `research/*/README.md`
(which are design contracts for code that doesn't exist yet), this document
describes a workflow that has actually been tested and confirmed working.
It is the canonical operator guide for working with the DRE RunPod Network
Volume without paying for a running Pod.

## What this volume is

| Property | Value |
| --- | --- |
| Name | `BigLittleWeights` |
| Size | 150 GB |
| Datacenter | `EU-RO-1` |
| S3 bucket ID | `uk51i8y9mg` |
| S3 endpoint | `https://s3api-eu-ro-1.runpod.io` |

This is the same underlying storage that appears as `/workspace` inside a
running DRE Pod. RunPod's S3-compatible API exposes it directly, so it can
be read and written **while no Pod is running** — you are not paying for
compute time just to browse or manage files on it.

**Never commit S3 access keys or secrets to this repository or any
documentation.** Generate/rotate them from the RunPod dashboard (Settings →
S3 API Keys) and keep them out of chat logs, commit messages, and files
under version control.

## Verified access path

```text
RunPod Network Volume (BigLittleWeights)
  → RunPod S3-compatible API (https://s3api-eu-ro-1.runpod.io)
  → rclone (S3 remote) + WinFsp
  → Windows drive letter R:
  → BigLittleWeights (mounted contents)
```

This has been verified end-to-end from a Windows PC with **no Pod
running**: AWS CLI listing succeeded, rclone listing succeeded, a real
mount to `R:` succeeded, and a create/read/delete file test on the mounted
drive succeeded.

## Setting up the rclone remote

Create an S3 API key pair in the RunPod dashboard first (Settings → S3 API
Keys). Then configure an rclone remote (values below match this volume;
replace only the access key/secret):

```powershell
rclone config create runpod s3 provider=Other `
  access_key_id="YOUR_ACCESS_KEY" `
  secret_access_key="YOUR_SECRET_KEY" `
  endpoint=https://s3api-eu-ro-1.runpod.io `
  region=EU-RO-1 `
  force_path_style=true `
  env_auth=false
```

`env_auth` **must be `false`**. If it is `true`, rclone ignores the
`access_key_id`/`secret_access_key` stored in the remote and instead pulls
credentials from the generic AWS SDK chain (environment variables, shared
credentials file, instance metadata) — a different, easy-to-misconfigure
code path that produced persistent `SignatureDoesNotMatch` errors during
setup even with fully correct keys.

## Verifying access before mounting

Always confirm listing works before attempting a mount:

```powershell
rclone lsf runpod:uk51i8y9mg --max-depth 1
```

AWS CLI is a useful independent cross-check if rclone ever misbehaves,
since it resolves credentials completely separately from rclone:

```powershell
$env:AWS_ACCESS_KEY_ID = "YOUR_ACCESS_KEY"
$env:AWS_SECRET_ACCESS_KEY = "YOUR_SECRET_KEY"
aws s3 ls --region EU-RO-1 --endpoint-url https://s3api-eu-ro-1.runpod.io/ s3://uk51i8y9mg/
Remove-Item Env:AWS_ACCESS_KEY_ID
Remove-Item Env:AWS_SECRET_ACCESS_KEY
```

## Mounting as a Windows drive

Requires [WinFsp](https://winfsp.dev/) installed. Run in a normal
(non-Administrator) PowerShell window, and leave that window open for the
life of the mount:

```powershell
rclone mount runpod:uk51i8y9mg R: --network-mode --vfs-cache-mode writes --volname BigLittleWeights --s3-use-accept-encoding-gzip=false --s3-sign-accept-encoding=false
```

**The two `--s3-*-encoding` flags were required specifically for this
volume's `EU-RO-1` S3 gateway** — without them, mounted directory listings
and some operations failed even though plain `lsf`/`aws s3 ls` succeeded.
Add `--links` if rclone reports a symlink-support error on mount.

Once mounted, `R:\` (labeled `BigLittleWeights`) shows the same persistent
contents visible as `/workspace` inside a running Pod.

**Do not run `rclone sync` against this mount casually** — `sync` deletes
destination-side files to match the source. Use `rclone copy`/`lsf`/normal
Explorer file operations for routine work; reserve `sync` for a deliberate,
understood one-directional operation.

## The Pod-off workflow

With the volume S3-mounted and no Pod running, you can safely:

- Browse, add, edit, or delete plain files (models, checkpoints, logs,
  research source archives, project artifacts).
- Manage large file transfers (uploading/downloading models or datasets)
  without paying for GPU/CPU time.

You should **not**:

- Treat this as a substitute for running code — there is no compute here,
  only storage.
- Rely on file permission bits (`chmod`) set through this mount as any kind
  of security or execution-trust boundary (see below).
- Edit a live SQLite database file (e.g. `research.db`,
  `state.sqlite3`) over this mount while a Pod process has it open — see
  [Live SQLite files](#live-sqlite-files-never-hand-edit-while-in-use)
  below.

## FUSE / Network Volume chmod limitation

RunPod's Network Volume, accessed either through the Pod's FUSE-backed
`/workspace` mount or through the S3 API via rclone/WinFsp on Windows,
**does not reliably preserve Unix permission bits (`chmod`)**. A file
marked executable through one access path is not guaranteed to still be
recognized as executable through another, and permissions set here should
never be relied upon as a security boundary.

## `/workspace` vs `/opt` — the executable trust boundary rule

This has a direct architectural consequence for anything meant to *run* as
code (the research worker included — see
[`research/worker/README.md`](../../research/worker/README.md) and
[`image-research-autostart/README.md`](../../image-research-autostart/README.md)):

| Path | Role | Permissions |
| --- | --- | --- |
| `/workspace` | **Persistent source of truth** — state, models, research projects, evidence, logs. Lives on the Network Volume. | Not a trust boundary — chmod here is unreliable (see above) |
| `/opt/dre-research` | **Executable runtime**, inside a running Pod's normal (non-Network-Volume) filesystem | Normal Linux permissions apply and are trustworthy |

**Rule: persistent research source under `/workspace` must be copied or
synchronized into `/opt/dre-research` and hash-verified before execution.**
Nothing should be executed directly out of `/workspace`, and a file's
permission bits as seen on `/workspace` must never be treated as proof of
what it's safe to run. `/opt/dre-research` is where normal Unix permissions
and execution trust apply.

The Network Volume can continue to be managed via the S3 API (per this
document) while no Pod is running — that only affects the persistent
source under `/workspace`, not the executable copy under `/opt`, which only
exists while a Pod is actually up.

## Live SQLite files — never hand-edit while in use

Do not open, edit, or write to a live SQLite database (e.g. a research
queue database, `state.sqlite3`) directly over the Windows S3 mount while a
Pod process (the FastAPI backend, a research worker) has that file open.
SQLite's locking model assumes a single coherent filesystem with proper
lock support; concurrent access through an S3-backed mount from a second
machine while a Pod-side process is also writing risks corrupting the
database. If you need to inspect it, either do so while the Pod is fully
stopped, or copy the file elsewhere first and inspect the copy.

## Related documents

- [Root README § Persistence / storage rules](../../README.md#persistence--storage-rules)
- [`research/projects/README.md`](../../research/projects/README.md) — the logical SQLite/file layout under `/workspace/dre-research-runtime`
- [`research/worker/README.md`](../../research/worker/README.md) — how the research worker is expected to start and execute
- [`image-research-autostart/README.md`](../../image-research-autostart/README.md) — the image-level bootstrap hook this feeds into
