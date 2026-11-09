-- How many rows each account has written today, so one account can't run up the bill.
ALTER TABLE users ADD COLUMN upload_day TEXT;
ALTER TABLE users ADD COLUMN upload_rows INTEGER NOT NULL DEFAULT 0;
