use crate::domain::State;
use anyhow::Result;
use rusqlite::{params, Connection};
use std::{path::Path, time::Duration};

pub struct Store {
    pub conn: Connection,
}
impl Store {
    pub fn open(root: &Path) -> Result<Self> {
        std::fs::create_dir_all(root.join(".harness/runs"))?;
        let conn = Connection::open(root.join(".harness/state.sqlite3"))?;
        conn.busy_timeout(Duration::from_secs(10))?;
        conn.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS checkpoint(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL);
            INSERT OR IGNORE INTO control VALUES(1,0);
            CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, task_id TEXT, phase TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL, artifact_dir TEXT NOT NULL);")?;
        conn.execute(
            "INSERT OR IGNORE INTO checkpoint VALUES(1,?1)",
            [serde_json::to_string(&State::default())?],
        )?;
        Ok(Self { conn })
    }
    pub fn load(&self) -> Result<State> {
        let text: String =
            self.conn
                .query_row("SELECT body FROM checkpoint WHERE id=1", [], |r| r.get(0))?;
        let state: State = serde_json::from_str(&text)?;
        anyhow::ensure!(state.version == 1, "unsupported checkpoint version");
        Ok(state)
    }
    pub fn save(&mut self, s: &State, kind: &str, now: u64) -> Result<()> {
        let body = serde_json::to_string(s)?;
        let tx = self.conn.transaction()?;
        tx.execute("UPDATE checkpoint SET body=?1 WHERE id=1", [&body])?;
        tx.execute(
            "INSERT INTO events(at,kind,body) VALUES(?1,?2,?3)",
            params![now, kind, body],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn paused(&self) -> Result<bool> {
        Ok(self
            .conn
            .query_row("SELECT paused FROM control WHERE id=1", [], |r| r.get(0))?)
    }
    pub fn pause(&self, value: bool) -> Result<()> {
        self.conn
            .execute("UPDATE control SET paused=?1 WHERE id=1", [value])?;
        Ok(())
    }
    pub fn recover(&self, now: u64) -> Result<()> {
        self.conn.execute(
            "UPDATE runs SET status='interrupted',finished_at=?1 WHERE status='running'",
            [now],
        )?;
        Ok(())
    }
    pub fn start_run(&self, id: &str, s: &State, dir: &str, now: u64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO runs VALUES(?1,?2,?3,?4,NULL,'running',?5)",
            params![id, s.current.map(|i| &s.tasks[i].id), s.phase, now, dir],
        )?;
        Ok(())
    }
    pub fn finish_run(&self, id: &str, status: &str, now: u64) -> Result<()> {
        self.conn.execute(
            "UPDATE runs SET status=?2,finished_at=?3 WHERE id=?1",
            params![id, status, now],
        )?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_preserves_stage_and_pause() {
        let d = tempfile::tempdir().unwrap();
        let mut db = Store::open(d.path()).unwrap();
        let mut s = db.load().unwrap();
        s.next_at = 500;
        db.save(&s, "retry", 1).unwrap();
        db.pause(true).unwrap();
        db.start_run("run-1", &s, "runs/run-1", 1).unwrap();
        drop(db);
        let db = Store::open(d.path()).unwrap();
        db.recover(2).unwrap();
        assert_eq!(db.load().unwrap().next_at, 500);
        assert!(db.paused().unwrap());
        let status: String = db
            .conn
            .query_row("SELECT status FROM runs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "interrupted");
    }
}
