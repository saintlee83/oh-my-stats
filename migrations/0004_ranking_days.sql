-- Read each member's selected reporting dates across all their machines.
CREATE INDEX usage_daily_user_day ON usage_daily (user_id, day);
