CREATE TABLE people (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  owner_email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE wishes (
  id TEXT PRIMARY KEY NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(id),
  title TEXT NOT NULL,
  url TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX wishes_person_idx ON wishes(person_id);
--> statement-breakpoint
CREATE TABLE purchases (
  id TEXT PRIMARY KEY NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(id),
  wish_id TEXT UNIQUE REFERENCES wishes(id),
  title TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  buyer_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX purchases_person_idx ON purchases(person_id);
