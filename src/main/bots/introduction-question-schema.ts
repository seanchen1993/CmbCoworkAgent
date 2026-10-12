export const BOT_INTRODUCTION_QUESTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_introduction_questions(
 run_id TEXT PRIMARY KEY REFERENCES bot_introductions(run_id) ON DELETE CASCADE,
 message_id TEXT UNIQUE REFERENCES bot_messages(id) ON DELETE CASCADE,
 input TEXT NOT NULL CHECK(length(input)<=16000),
 data_epoch TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('staged','pending','answered','skipped','superseded')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0)
);
`
