# feedBack

feedBack (styled fee\[dB\]ack) is a self-hosted web app for playing and practicing music on a note highway.
It listens to your instrument and scores you as you play.
Charts use the open `.sloppak` / feedpak format and can be imported from Guitar Pro or MusicXML, or authored in the built-in editor.

This repo is the core app: a FastAPI server (`server.py`), a plain JavaScript frontend (`static/`), shared Python libraries (`lib/`) and the plugin loader (`plugins/`).
Most features ship as plugins.

<img src="docs/player-3d.webp" alt="The 3D note highway" width="720" />

## Get it

### Desktop app

The easiest way to play is the desktop app from [feedBack-desktop](https://github.com/got-feedBack/feedBack-desktop).
It bundles this server, a native low-latency audio engine and a set of plugins.

Download it from the [feedBack-desktop releases](https://github.com/got-feedBack/feedBack-desktop/releases):

- Windows x64: `.msi` installer or portable `.zip`
- macOS Apple silicon (arm64): `.pkg` installer or portable `.zip`
- Linux x64: `.AppImage` or `.deb`

### Docker (GHCR image)

Release tags publish an image to `ghcr.io/got-feedback/feedback` (see `.github/workflows/release.yml`).

```bash
docker run -d --name feedback -p 8000:8000 \
  -v /path/to/your/library:/dlc \
  -v feedback-config:/config \
  -e DLC_DIR=/dlc -e CONFIG_DIR=/config \
  ghcr.io/got-feedback/feedback:0.3.0-alpha.1
```

Then open <http://localhost:8000>.
`/dlc` is your song library and `/config` holds settings, cache and practice data.

### Docker Compose (from source)

`docker-compose.yml` builds the image locally and mounts the source for live reload during development:

```bash
git clone https://github.com/got-feedBack/feedBack.git
cd feedBack
LIBRARY_PATH=/path/to/your/library docker compose up -d --build
```

`LIBRARY_PATH` defaults to `./library`.

### NAS

`docker-compose.nas.yml` is a variant for a NAS.
It builds from the `Dockerfile`, mounts `/volume1/music/feedBack` as the library and restarts the container automatically.
Edit the library path to match your NAS, then run:

```bash
docker compose -f docker-compose.nas.yml up -d --build
```

### Proxmox LXC

`build-proxmox-ct.sh` builds a Proxmox LXC container template from WSL2 (or another Linux host), without Docker.
It bootstraps a Debian Trixie rootfs with `debootstrap`, installs ffmpeg, vgmstream, Node.js and the Python app into `/app`, and adds a `feedBack-server` systemd service on port 8000.
The output is a `.tar.zst` you can import with `pct restore`.

```bash
sudo apt install debootstrap systemd-container tar zstd curl unzip git
sudo bash build-proxmox-ct.sh amd64 feedBack-ct   # or arm64
```

The script prints the `scp` and `pct restore` commands to run on the Proxmox host when it finishes.
The container ships with an empty library, so mount or copy your songs into `/dlc` after import.
Read the header of the script for the supported environment variables.

## Documentation

- [User guide](https://got-feedback.github.io/feedBack-user-guide/): how to use the app, for players.
- [feedpak-spec](https://github.com/got-feedBack/feedpak-spec): the open chart format.
- [feedBack-plugin-spec](https://github.com/got-feedBack/feedBack-plugin-spec): how to write a plugin.
- [CLAUDE.md](CLAUDE.md): architecture and host API reference, written for AI agents and contributors.
- [docs/](docs/): format notes, plugin UI contracts and capability specs.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
Every commit needs a DCO sign-off (`git commit -s`).
Questions and bug reports go to [Issues](https://github.com/got-feedBack/feedBack/issues).

## License

feedBack is licensed under [AGPL-3.0-only](LICENSE).
