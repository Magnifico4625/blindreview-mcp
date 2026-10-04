-- 004: drop users.legacy_id (v1 API was removed)
ALTER TABLE users DROP COLUMN legacy_id;
