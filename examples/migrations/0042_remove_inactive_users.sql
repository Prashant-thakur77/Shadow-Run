-- Remove users who haven't logged in for a year.
DELETE FROM users WHERE last_login_at < now() - interval '1 year';
