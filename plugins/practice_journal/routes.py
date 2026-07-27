"""Practice Journal plugin — tracks practice sessions and provides stats."""

import json
import sqlite3
import threading
from datetime import datetime, timedelta
from pathlib import Path

_db_path = None
_conn = None
_lock = threading.Lock()


def _get_conn():
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(_db_path, check_same_thread=False)
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("""
            CREATE TABLE IF NOT EXISTS practice_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                title TEXT,
                artist TEXT,
                started_at TEXT NOT NULL,
                duration_seconds REAL NOT NULL DEFAULT 0,
                avg_speed REAL NOT NULL DEFAULT 1.0,
                loops_used TEXT DEFAULT '[]',
                arrangement TEXT
            )
        """)
        _conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_practice_filename
            ON practice_sessions(filename)
        """)
        _conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_practice_started
            ON practice_sessions(started_at)
        """)
        _conn.commit()
    return _conn


def setup(app, context):
    global _db_path
    config_dir = context["config_dir"]
    _db_path = str(config_dir / "practice_journal.db")

    @app.post("/api/plugins/practice_journal/session")
    def record_session(data: dict):
        """Record a completed practice session."""
        filename = data.get("filename", "")
        if not filename:
            return {"error": "No filename"}

        duration = data.get("duration", 0)
        if duration < 5:  # ignore sessions under 5 seconds
            return {"ok": True, "skipped": True}

        conn = _get_conn()
        with _lock:
            conn.execute(
                "INSERT INTO practice_sessions "
                "(filename, title, artist, started_at, duration_seconds, avg_speed, loops_used, arrangement) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    filename,
                    data.get("title", ""),
                    data.get("artist", ""),
                    data.get("started_at", datetime.utcnow().isoformat()),
                    duration,
                    data.get("avg_speed", 1.0),
                    json.dumps(data.get("loops_used", [])),
                    data.get("arrangement", ""),
                ),
            )
            conn.commit()
        return {"ok": True}

    @app.get("/api/plugins/practice_journal/stats")
    def practice_stats():
        """Overall practice statistics."""
        conn = _get_conn()
        now = datetime.utcnow()
        today = now.strftime("%Y-%m-%d")
        week_ago = (now - timedelta(days=7)).isoformat()
        month_ago = (now - timedelta(days=30)).isoformat()

        total_time = conn.execute(
            "SELECT COALESCE(SUM(duration_seconds), 0) FROM practice_sessions"
        ).fetchone()[0]
        today_time = conn.execute(
            "SELECT COALESCE(SUM(duration_seconds), 0) FROM practice_sessions WHERE started_at >= ?",
            (today,)
        ).fetchone()[0]
        week_time = conn.execute(
            "SELECT COALESCE(SUM(duration_seconds), 0) FROM practice_sessions WHERE started_at >= ?",
            (week_ago,)
        ).fetchone()[0]
        total_sessions = conn.execute(
            "SELECT COUNT(*) FROM practice_sessions"
        ).fetchone()[0]
        unique_songs = conn.execute(
            "SELECT COUNT(DISTINCT filename) FROM practice_sessions"
        ).fetchone()[0]

        # Most practiced songs (by total time)
        top_songs = conn.execute(
            "SELECT title, artist, filename, SUM(duration_seconds) as total, COUNT(*) as sessions "
            "FROM practice_sessions GROUP BY filename ORDER BY total DESC LIMIT 10"
        ).fetchall()

        # Daily practice time for the last 30 days
        daily = conn.execute(
            "SELECT DATE(started_at) as day, SUM(duration_seconds) as total "
            "FROM practice_sessions WHERE started_at >= ? "
            "GROUP BY day ORDER BY day",
            (month_ago,)
        ).fetchall()

        # Recent sessions
        recent = conn.execute(
            "SELECT title, artist, filename, started_at, duration_seconds, avg_speed, arrangement "
            "FROM practice_sessions ORDER BY started_at DESC LIMIT 20"
        ).fetchall()

        return {
            "total_time": total_time,
            "today_time": today_time,
            "week_time": week_time,
            "total_sessions": total_sessions,
            "unique_songs": unique_songs,
            "top_songs": [
                {"title": r[0], "artist": r[1], "filename": r[2],
                 "total_time": r[3], "sessions": r[4]}
                for r in top_songs
            ],
            "daily": [{"date": r[0], "seconds": r[1]} for r in daily],
            "recent": [
                {"title": r[0], "artist": r[1], "filename": r[2],
                 "started_at": r[3], "duration": r[4], "speed": r[5],
                 "arrangement": r[6]}
                for r in recent
            ],
        }

    @app.get("/api/plugins/practice_journal/song/{filename:path}")
    def song_practice_history(filename: str):
        """Practice history for a specific song."""
        conn = _get_conn()

        total_time = conn.execute(
            "SELECT COALESCE(SUM(duration_seconds), 0) FROM practice_sessions WHERE filename = ?",
            (filename,)
        ).fetchone()[0]
        session_count = conn.execute(
            "SELECT COUNT(*) FROM practice_sessions WHERE filename = ?",
            (filename,)
        ).fetchone()[0]

        # Speed progression over time
        speed_history = conn.execute(
            "SELECT started_at, avg_speed, duration_seconds FROM practice_sessions "
            "WHERE filename = ? ORDER BY started_at",
            (filename,)
        ).fetchall()

        # Sessions
        sessions = conn.execute(
            "SELECT started_at, duration_seconds, avg_speed, loops_used, arrangement "
            "FROM practice_sessions WHERE filename = ? ORDER BY started_at DESC LIMIT 50",
            (filename,)
        ).fetchall()

        return {
            "total_time": total_time,
            "session_count": session_count,
            "speed_history": [
                {"date": r[0], "speed": r[1], "duration": r[2]}
                for r in speed_history
            ],
            "sessions": [
                {"started_at": r[0], "duration": r[1], "speed": r[2],
                 "loops": json.loads(r[3]) if r[3] else [], "arrangement": r[4]}
                for r in sessions
            ],
        }
