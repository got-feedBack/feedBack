# Slopsmith Plugin: Practice Journal

A plugin for [Slopsmith](https://github.com/byrongamatos/slopsmith) that automatically tracks your practice sessions and shows progress over time.

## Features

- **Auto-tracking** — practice time is recorded automatically when you play songs. No manual start/stop needed.
- **Dashboard** with:
  - Today / This Week / All Time practice time
  - Total songs practiced
  - 30-day activity chart
  - Most practiced songs (ranked by total time)
  - Recent sessions with duration, speed, and arrangement
- **Speed tracking** — records the average playback speed used per session
- **Loop tracking** — records which saved loops you used during practice
- **Per-song history** — API endpoint for detailed practice history per song

## Installation

```bash
cd /path/to/slopsmith/plugins
git clone https://github.com/byrongamatos/slopsmith-plugin-practice.git practice_journal
docker compose restart
```

The "Practice" link will appear in the navigation bar.

## How It Works

The plugin hooks into the Slopsmith player. When you open a song, a practice session starts automatically. When you leave the player (navigate away, close the song, or close the browser), the session is saved with:

- Song details (title, artist, arrangement)
- Duration
- Average playback speed
- Which saved loops were activated

Sessions under 5 seconds are ignored.

## License

MIT
