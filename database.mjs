import { DatabaseSync } from "node:sqlite";

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, password TEXT,
      google_sub TEXT UNIQUE, verified_email TEXT UNIQUE COLLATE NOCASE, name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      digest TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY, verifier TEXT NOT NULL, mode TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lists (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT UNIQUE REFERENCES accounts(id),
      contact_email TEXT UNIQUE COLLATE NOCASE, creator_id TEXT NOT NULL REFERENCES accounts(id)
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, list_id TEXT NOT NULL REFERENCES lists(id), name TEXT NOT NULL,
      url TEXT NOT NULL, notes TEXT NOT NULL, image TEXT NOT NULL, price TEXT NOT NULL,
      added_by TEXT REFERENCES accounts(id), claimed_by TEXT REFERENCES accounts(id)
    );
    CREATE INDEX IF NOT EXISTS items_list_idx ON items(list_id);
  `);
  return db;
}
